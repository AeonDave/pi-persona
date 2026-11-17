import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type FileEntry } from "@earendil-works/pi-coding-agent";
import { SessionResults, untrackedRootRunId } from "../../src/extension/results.ts";
import { highestIssuedRun } from "../../src/core/session-runs.ts";
import { sumUsage } from "../../src/orchestration/reducers.ts";
import { AsyncRunTracker, MAX_COMPLETION_REPORT_CHARS, renderCompletion } from "../../src/engine/async.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import { fenceUntrusted } from "../../src/core/fence.ts";
import { TerminalResultArchive } from "../../src/results/archive.ts";
import { TERMINAL_RESULT_ENTRY, RESULT_MAX_ENTRIES } from "../../src/results/types.ts";
import { resultReceiptHint } from "../../src/results/retrieval.ts";
import { registerIntercomTool } from "../../src/tools/intercom-tool.ts";
import { ChildUsageLedger, formatPersonaCostStatus, toolUsageField } from "../../src/ui/usage.ts";
import { makeSDK } from "../../src/orchestration/sdk.ts";
import { Semaphore } from "../../src/orchestration/parallel.ts";
import type { AgentResult } from "../../src/orchestration/types.ts";
import { createBackgroundRuns } from "../../src/tools/background-run.ts";
import { AgentTree } from "../../src/ui/agent-tree.ts";

const result = (output: string): AgentResult => ({ agent: "readonly-reviewer", output, ok: true, usage: { ...emptyUsage(), input: 12, output: 34, cost: 0.01 }, thinkingRequested: "high", thinkingEffective: "medium" });
const ctx = (manager: SessionManager): ExtensionContext => ({ sessionManager: manager }) as unknown as ExtensionContext;
const terminalEntries = (manager: SessionManager) => manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === TERMINAL_RESULT_ENTRY);

function conversation(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "offline storage fixture", timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "offline storage fixture" }], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

function toolFor(owner: SessionResults, tracker = new AsyncRunTracker()) {
	let tool: any;
	let billed = 0;
	let discarded = 0;
	const ledger = new ChildUsageLedger();
	registerIntercomTool({ registerTool: (definition: unknown) => { tool = definition; } } as ExtensionAPI, {
		tracker, archive: (context: ExtensionContext) => owner.activate(context),
		completionNotifier: { discard: () => { discarded++; } } as any,
		childUsage: ledger, publishPersonaCost: () => { billed++; },
		scanForSurrender: () => undefined,
		missingRunMessage: () => "No current runtime handle; use results/ref",
	} as any);
	return { call: (args: unknown, context: ExtensionContext) => tool.execute("fixture", args, undefined, undefined, context), get billed() { return billed; }, get discarded() { return discarded; } };
}

test("native history in a memory-only owner never claims session-entry storage on read/list/idempotent save", () => {
	const input = { originKey: "same-logical-outcome", agent: "reviewer", status: "done" as const, body: "copied report", provenance: "result-output" as const };
	const history: unknown[] = [];
	const original = new TerminalResultArchive({ entries: () => [], persistent: true, append: (customType, data) => history.push({ type: "custom", customType, data }) });
	const saved = original.save(input);
	assert.equal(saved.ok, true);
	if (!saved.ok) return;
	const memory = new TerminalResultArchive({ entries: () => history, persistent: false, append: () => assert.fail("historical read must not append") });
	const read = memory.read({ ref: saved.ref });
	assert.equal(read.ok && read.summary.storage, "memory-only");
	const list = memory.list();
	assert.equal(list.ok && list.results[0]?.storage, "memory-only");
	const again = memory.save(input);
	assert.equal(again.ok && again.storage, "memory-only");
});

test("three large readonly reports: native JSONL, bounded completion, full paged reload retrieval, no replay or rebilling", async () => {
	const root = mkdtempSync(join(tmpdir(), "persona-terminal-results-"));
	try {
		let manager = SessionManager.create(root, root);
		conversation(manager);
		const path = manager.getSessionFile()!;
		const owner = new SessionResults({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		owner.activate(ctx(manager));
		const tracker = new AsyncRunTracker({ maxRetained: 1 });
		owner.track(tracker);
		const completed: any[] = [];
		tracker.onComplete((run) => { assert.equal(run.resultReceipt?.storage, "session-entry"); completed.push(run); });
		const reports = [0, 1, 2].map((i) => `READONLY-${i}\n${"Analysis Ω😀\n".repeat(6000)}END-${i}`);
		for (const body of reports) {
			const done = new Promise<void>((resolve) => { const off = tracker.onComplete(() => { off(); resolve(); }); });
			tracker.launch({ agent: "readonly-reviewer", task: "MUST NOT BE STORED", batch: "review-three" }, async () => result(body));
			await done;
		}
		const notice = renderCompletion(completed, fenceUntrusted, () => undefined);
		assert.ok(notice.length <= MAX_COMPLETION_REPORT_CHARS);
		assert.match(notice, /intercom.*results/);
		assert.match(notice, /result:/);
		assert.equal(terminalEntries(manager).length, 3);
		assert.equal(tracker.list().length, 1, "dropped live handles do not delete archive data");
		assert.doesNotMatch(JSON.stringify(terminalEntries(manager)), /MUST NOT BE STORED|contextTokens|structured/);
		const refs = completed.map((run) => run.resultReceipt.ref);
		owner.dispose();
		manager = SessionManager.open(path);
		const restored = new SessionResults({ appendEntry: () => assert.fail("retrieval cannot write") });
		restored.activate(ctx(manager));
		const tool = toolFor(restored);
		const before = manager.getEntries();
		const summaries = await tool.call({ action: "results", limit: 2 }, ctx(manager));
		assert.equal(summaries.details.results.length, 2);
		const tail = await tool.call({ action: "results", cursor: summaries.details.nextCursor, limit: 2 }, ctx(manager));
		assert.equal(tail.details.results.length, 1);
		// The page body reaches the model exactly once, inside the fenced content; details carry
		// only bounded metadata (the bounded-page rule). Reconstruct by unquoting the fence: every
		// payload line is quoted "> ", so a genuine "> x" body line round-trips as "> > x".
		const pageBody = (page: { content: Array<{ type: string; text: string }> }): string =>
			page.content[0]!.text.split("\n").filter((line) => line.startsWith("> ")).map((line) => line.slice(2)).join("\n");
		for (const [i, ref] of refs.entries()) {
			let output = "";
			let offset = 0;
			for (;;) {
				const page = await tool.call({ action: "result", ref, offset, limit: 15999 }, ctx(manager));
				assert.equal(page.isError, false);
				assert.match(page.content[0].text, /Sub-agent output \(untrusted data\)/);
				assert.equal(page.usage, undefined);
				assert.equal(page.details.summary.thinkingRequested, "high");
				assert.equal(page.details.summary.thinkingEffective, "medium");
				assert.equal(page.details.body, undefined, "the page body is never duplicated in details");
				output += pageBody(page);
				if (page.details.nextOffset === undefined) break;
				offset = page.details.nextOffset;
			}
			assert.equal(output, reports[i]);
		}
		assert.equal(tool.billed, 0);
		assert.equal(tool.discarded, 0);
		assert.deepEqual(manager.getEntries(), before, "reload reads have no writes, worker calls or completion machinery");
		assert.equal((await tool.call({ action: "result", ref: refs[0], collect: true }, ctx(manager))).isError, true);
		assert.equal((await tool.call({ action: "result", to: "run-1" }, ctx(manager))).isError, true, "historical run id is not guessed");
		restored.dispose();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("frozen owner revokes stale appends; sibling branches share a file, copied forks charge only their own entries", () => {
	const root = mkdtempSync(join(tmpdir(), "persona-terminal-owner-"));
	try {
		let manager = SessionManager.create(root, root);
		conversation(manager);
		const owner = new SessionResults({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		owner.activate(ctx(manager));
		const common = manager.getLeafId()!;
		const capture = owner.bind("root");
		const a = capture("a", result("branch A"));
		manager.branch(common);
		const b = capture("b", result("branch B"));
		assert.equal(owner.archive!.list().ok, true);
		const reopened = new SessionResults({ appendEntry: () => assert.fail("read-only") });
		reopened.activate(ctx(SessionManager.open(manager.getSessionFile()!)));
		const all = reopened.archive!.list();
		assert.equal(all.ok && all.results.length, 2, "all sibling entries are visible, not just active branch");
		const copied = manager.getEntries().filter((entry) => !(entry.type === "custom" && entry.customType === TERMINAL_RESULT_ENTRY && (entry.data as any).ref === a.ref));
		manager = SessionManager.inMemory(root, undefined, copied as FileEntry[]);
		owner.activate(ctx(manager));
		assert.equal(owner.archive!.read({ ref: a.ref! }).ok, false);
		const copiedB = owner.archive!.read({ ref: b.ref! });
		assert.equal(copiedB.ok && copiedB.summary.storage, "memory-only");
		assert.equal(copiedB.accounting.chargedEntries, 1, "no quota from discarded parent/sibling entries");
		const count = terminalEntries(manager).length;
		const stale = capture("late-old-owner", result("never enters the fork"));
		assert.equal(stale.ref, undefined);
		assert.match(stale.warning!, /no longer current/);
		assert.equal(terminalEntries(manager).length, count);
		owner.dispose(); reopened.dispose();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("interrupted archive capture salvages only strict exact-prefix partial extensions with truthful provenance", () => {
	const owner = new SessionResults({ appendEntry: () => {} });
	owner.activate(ctx(SessionManager.inMemory()));
	const capture = owner.bind("interrupted-prefix");
	const partial = "Complete retained progress with additional recovered continuation.";
	const prefix = partial.slice(0, 27);

	for (const status of ["stopped", "failed"] as const) {
		const receipt = capture(status, { ...result(prefix), ok: false }, { status, partial });
		assert.ok(receipt.ref);
		const saved = owner.archive!.read({ ref: receipt.ref! });
		assert.equal(saved.ok && saved.body, partial, `${status} archive body uses the complete progress extension`);
		assert.equal(saved.ok && saved.summary.status, status);
		assert.equal(saved.ok && saved.summary.provenance, "partial-output");
	}

	const done = capture("done", result(prefix), { status: "done", partial });
	const savedDone = owner.archive!.read({ ref: done.ref! });
	assert.equal(savedDone.ok && savedDone.body, prefix, "done retains the authoritative final output");
	assert.equal(savedDone.ok && savedDone.summary.provenance, "result-output");

	const nonPrefix = capture("non-prefix", { ...result("final answer"), ok: false }, { status: "failed", partial });
	const savedNonPrefix = owner.archive!.read({ ref: nonPrefix.ref! });
	assert.equal(savedNonPrefix.ok && savedNonPrefix.body, "final answer", "different final output is not replaced or concatenated");
	assert.equal(savedNonPrefix.ok && savedNonPrefix.summary.provenance, "result-output");

	const equal = capture("equal", { ...result(prefix), ok: false }, { status: "failed", partial: prefix });
	const savedEqual = owner.archive!.read({ ref: equal.ref! });
	assert.equal(savedEqual.ok && savedEqual.body, prefix, "equal text is not a strict extension");
	assert.equal(savedEqual.ok && savedEqual.summary.provenance, "result-output");
	owner.dispose();
});

test("capture is idempotent; errors, partial output, quota and failed append cannot turn work into failure or fake durability", async () => {
	const manager = SessionManager.inMemory();
	const owner = new SessionResults({ appendEntry: () => { throw new Error("disk error"); } });
	owner.activate(ctx(manager));
	const capture = owner.bind("root");
	const first = capture("one", result("whole"));
	assert.equal(first.storage, "memory-only");
	assert.match(resultReceiptHint(first), /not durable/);
	assert.equal(capture("one", result("whole")).ref, first.ref);
	assert.equal(capture("one", result("different")).ref, undefined);
	for (let i = 1; i < RESULT_MAX_ENTRIES; i++) capture(String(i), result("report"));
	const over = capture("overflow", result("ordinary work succeeded"));
	assert.equal(over.ref, undefined);
	assert.match(over.warning!, /quota/);
	owner.dispose();

	const storage = new SessionResults({ appendEntry: () => { throw new Error("disk error"); } });
	// A file-backed native owner whose append fails yields a runtime-only receipt.
	const fake = { getSessionId: () => "persistent", getSessionFile: () => "fixture.jsonl", getEntries: () => [] };
	storage.activate({ sessionManager: fake } as unknown as ExtensionContext);
	const receipt = storage.bind("append")("one", result("successful work"));
	assert.equal(receipt.storage, "memory-only");
	assert.match(receipt.warning!, /append-failed/);
	assert.match(resultReceiptHint(receipt), /memory-only/);
	storage.dispose();

	const partialOwner = new SessionResults({ appendEntry: () => {} });
	partialOwner.activate(ctx(manager));
	const tracker = new AsyncRunTracker(); partialOwner.track(tracker);
	const settled = new Promise<void>((resolve) => tracker.onComplete(() => resolve()));
	const id = tracker.launch({ agent: "partial", task: "do not save" }, (progress) => {
		progress({ output: "salvage", tokens: 1, turns: 1 });
		throw new Error("synchronous crash");
	});
	await settled;
	const run = tracker.peek(id)!;
	const saved = partialOwner.archive!.read({ ref: run.resultReceipt!.ref! });
	assert.equal(saved.ok && saved.body, "salvage");
	assert.equal(saved.ok && saved.summary.provenance, "partial-output");
	assert.equal(saved.ok && saved.summary.status, "failed");
	partialOwner.dispose();
});

test("SDK terminal capture runs once after recovery with summed usage, even if an archive callback throws", async () => {
	const manager = SessionManager.inMemory();
	const owner = new SessionResults({ appendEntry: () => {} }); owner.activate(ctx(manager));
	const capture = owner.bind("sdk");
	let calls = 0;
	let observed = 0;
	const sdk = makeSDK({ engine: { run: async () => (++calls === 1 ? { ...result("intermediate failed attempt"), ok: false, failureKind: "provider", modelUsed: "old/fixture", error: "unavailable" } : { ...result("FINAL RECOVERED REPORT"), modelUsed: "main/fixture" }) },
		limits: { maxChildren: 5, maxConcurrency: 1, budgetTokens: 0, timeoutMs: 1000 }, roster: { team: () => [] }, sessionModel: "main/fixture",
		onAgentResult: (r, key) => { observed++; r.resultReceipt = capture(key, r); },
	});
	const final = await sdk.agent({ agent: "readonly-reviewer", task: "task", model: "old/fixture" });
	assert.equal(final.ok, true); assert.equal(calls, 2); assert.equal(observed, 1);
	const page = owner.archive!.read({ ref: final.resultReceipt!.ref! });
	assert.equal(page.ok && page.body, "FINAL RECOVERED REPORT");
	assert.equal(page.ok && page.summary.usage?.input, 24);
	const list = owner.archive!.list(); assert.equal(list.ok && list.results.length, 1);
	const throwing = makeSDK({ engine: { run: async () => result("still succeeds") }, limits: { maxChildren: 1, maxConcurrency: 1, budgetTokens: 0, timeoutMs: 1000 }, roster: { team: () => [] }, onAgentResult: () => { throw new Error("callback error"); } });
	assert.equal((await throwing.agent({ agent: "reviewer", task: "work" })).output, "still succeeds");
	owner.dispose();
});

// ── persona-cost durability: LIVE == REBUILT across restarts, forks and reused run ids ─────────────

/** Deterministic PRNG (mulberry32) so a failing seed replays exactly. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One extension instance over one session file, wired like `session_start` wires the real one:
 *  a fresh terminal-archive owner, tracker and ledger restored from the file. `continueIds: false`
 *  replays a host that restarted the counter (a crash or fork before ids were made file-unique), so
 *  run ids already in the file are reissued. */
function instance(manager: SessionManager, continueIds: boolean) {
	const owner = new SessionResults({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
	owner.activate(ctx(manager));
	const tracker = new AsyncRunTracker();
	owner.track(tracker);
	const ledger = new ChildUsageLedger();
	const history = manager.getEntries();
	ledger.restore(history);
	if (continueIds) tracker.continueFrom(highestIssuedRun(history));
	// Runs whose terminal record never reaches the file (archive quota, memory-only owner): no owner
	// tracks this tracker, and its ids never collide with a recorded one. They sit above the range
	// `highestIssuedRun` reads back, so the billings naming them never move the recorded counter.
	const unrecorded = new AsyncRunTracker();
	unrecorded.continueFrom(2_000_000_000);
	let tool: any;
	registerIntercomTool({ registerTool: (definition: unknown) => { tool = definition; } } as ExtensionAPI, {
		tracker, archive: (context: ExtensionContext) => owner.activate(context),
		completionNotifier: { discard: () => {} } as any,
		childUsage: ledger, publishPersonaCost: () => {},
		bus: { pending: () => [], takeWhere: () => [] }, SUPERVISOR: "supervisor",
		scanForSurrender: () => undefined,
		missingRunMessage: () => "missing",
	} as any);
	return { owner, tracker, unrecorded, ledger, intercom: (id: string, call: string) => tool.execute(call, { action: "result", to: id }, undefined, undefined, ctx(manager)) };
}

async function settleRun(tracker: AsyncRunTracker, ledger: ChildUsageLedger, usage: ReturnType<typeof emptyUsage>): Promise<string> {
	const done = new Promise<void>((resolve) => { const off = tracker.onComplete(() => { off(); resolve(); }); });
	const id = tracker.launch({ agent: "scout", task: "t" }, async () => {
		ledger.add(usage); // what the extension's engine wrapper does when the leg settles
		return { agent: "scout", output: "report", ok: true, usage };
	});
	await done;
	return id;
}

test("persona-cost property: for any history of runs, collections, untracked roots, forks and restarts, LIVE == REBUILT", { timeout: 60_000 }, async () => {
	let reusedTotal = 0;
	for (let seed = 1; seed <= 12; seed++) {
		const root = mkdtempSync(join(tmpdir(), "persona-cost-property-"));
		const random = prng(seed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		// Dyadic costs and whole token counts keep every sum exact, so the published text and the
		// whole usage object can be compared for identity rather than approximately.
		const usage = () => ({ ...emptyUsage(), input: 1 + Math.floor(random() * 500), output: Math.floor(random() * 90), cacheRead: Math.floor(random() * 3) * 100, cost: (1 + Math.floor(random() * 200)) / 64 });
		let manager = SessionManager.create(root, root);
		conversation(manager);
		let live = instance(manager, true);
		/** Independent model: Σ usage of recorded runs never billed onto a tool result. */
		let modelPending = 0;
		let reused = 0;
		/** Settled runs of the CURRENT instance not yet billed, with their usage. */
		let open = new Map<string, ReturnType<typeof usage>>();
		let call = 0;
		const persist = (toolName: string, response: any) => {
			manager.appendMessage({ role: "toolResult", toolCallId: `call-${++call}`, toolName, content: response.content, details: response.details, isError: false, ...(response.usage ? { usage: response.usage } : {}), timestamp: 10 + call } as any);
		};
		const check = (where: string) => {
			const pending = live.ledger.pending();
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) assert.ok(pending[field] >= 0, `seed ${seed} ${where}: ${field} never negative`);
			assert.equal(pending.cost, modelPending, `seed ${seed} ${where}: live pending = Σ recorded − Σ billed`);
		};
		const reopen = (next: SessionManager, continueIds: boolean, where: string) => {
			const before = { text: formatPersonaCostStatus(live.ledger.pending()), pending: live.ledger.pending() };
			live.owner.dispose();
			manager = next;
			live = instance(manager, continueIds);
			open = new Map();
			assert.equal(formatPersonaCostStatus(live.ledger.pending()), before.text, `seed ${seed} ${where}: the published persona-cost is identical after the restart`);
			assert.deepEqual(live.ledger.pending(), before.pending, `seed ${seed} ${where}: LIVE == REBUILT`);
		};
		try {
			for (let step = 0; step < 28; step++) {
				const action = random();
				if (action < 0.3) {
					const u = usage();
					const id = await settleRun(live.tracker, live.ledger, u);
					if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === TERMINAL_RESULT_ENTRY && (entry.data as { originRunId?: string }).originRunId === id && (entry.data as { usage: { cost: number } }).usage.cost !== u.cost)) reused++;
					open.set(id, u);
					modelPending += u.cost;
				} else if (action < 0.45 && open.size > 0) {
					const id = pick([...open.keys()]);
					const response = await live.intercom(id, `collect-${call}`);
					assert.equal(response.usage?.cost.total, open.get(id)!.cost, `seed ${seed}: collecting a NEW run bills its usage, whatever ids the history holds (F1)`);
					persist("intercom", response);
					modelPending -= open.get(id)!.cost;
					open.delete(id);
				} else if (action < 0.58 && open.size > 0) {
					// A headless delegate join: the billing names every run it settled (some may be billed already).
					const ids = [...open.keys()].filter(() => random() < 0.7);
					const named = ids.length ? ids : [pick([...open.keys()])];
					const billed = live.ledger.accountMany(named.map((id) => ({ key: id, usage: open.get(id)! })));
					const expected = named.reduce((sum, id) => sum + open.get(id)!.cost, 0);
					assert.equal(billed.cost, expected, `seed ${seed}: a delegate join bills every unbilled run it names (F1)`);
					persist("delegate", { content: [], details: { settledRuns: named.map((id) => ({ id, agent: "scout" })) }, ...toolUsageField(billed) });
					for (const id of named) { modelPending -= open.get(id)!.cost; open.delete(id); }
				} else if (action < 0.68) {
					// A run whose record never reaches the file, then billed: neither added nor subtracted (F3).
					const u = usage();
					const id = await settleRun(live.unrecorded, live.ledger, u);
					persist("delegate", { content: [], details: { settledRuns: [{ id, agent: "scout" }] }, ...toolUsageField(live.ledger.accountMany([{ key: id, usage: u }])) });
				} else if (action < 0.78) {
					// An untracked top-level root (/orchestrate, /flow): per-leg records (no origin run id) and
					// one root record whose usage is the sum of its legs, under a `root:<uuid>` id.
					const capture = live.owner.bind(`orchestrate:${step}`);
					const legs = [usage(), usage()];
					legs.forEach((u, index) => { live.ledger.add(u); capture(`leg:${index}`, { agent: "scout", output: "leg", ok: true, usage: u }); });
					const total = sumUsage(legs);
					capture("root", { agent: "strategy", output: "ruling", ok: true, usage: total }, { originRunId: untrackedRootRunId() });
					modelPending += total.cost;
				} else if (action < 0.9) {
					reopen(SessionManager.open(manager.getSessionFile()!), random() < 0.5, `restart at step ${step}`);
				} else {
					reopen(SessionManager.forkFrom(manager.getSessionFile()!, root, root), random() < 0.5, `fork at step ${step}`);
				}
				check(`step ${step}`);
			}
			reopen(SessionManager.open(manager.getSessionFile()!), true, "final restart");
			check("final");
		} finally {
			live.owner.dispose();
			rmSync(root, { recursive: true, force: true });
		}
		reusedTotal += reused;
	}
	assert.ok(reusedTotal > 0, "the sweep actually reissued run ids already present in a file");
});

test("run ids continued past the file's highest id are never reissued after a fork or a crash", async () => {
	const root = mkdtempSync(join(tmpdir(), "persona-run-ids-"));
	try {
		const manager = SessionManager.create(root, root);
		conversation(manager);
		const first = instance(manager, true);
		const firstIds = [await settleRun(first.tracker, first.ledger, { ...emptyUsage(), input: 1, cost: 0.5 }), await settleRun(first.tracker, first.ledger, { ...emptyUsage(), input: 1, cost: 0.25 })];
		first.owner.dispose(); // a crash: no shutdown runs entry
		const forked = SessionManager.forkFrom(manager.getSessionFile()!, root, root);
		assert.notEqual(forked.getSessionId(), manager.getSessionId());
		for (const next of [SessionManager.open(manager.getSessionFile()!), forked]) {
			const resumed = instance(next, true);
			const id = await settleRun(resumed.tracker, resumed.ledger, { ...emptyUsage(), input: 1, cost: 1 });
			assert.ok(!firstIds.includes(id), `${id} is new in this file`);
			assert.equal(id, "run-3");
			resumed.owner.dispose();
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a run still in flight at a crash is never reissued: its persisted launch receipt names its id", async () => {
	const root = mkdtempSync(join(tmpdir(), "persona-run-ids-"));
	try {
		const manager = SessionManager.create(root, root);
		conversation(manager);
		const first = instance(manager, true);
		const settled = await settleRun(first.tracker, first.ledger, { ...emptyUsage(), input: 1, cost: 0.5 });
		const inFlight = first.tracker.launch({ agent: "scout", task: "t" }, () => new Promise<AgentResult>(() => {}));
		// The interactive `delegate` launch receipt, as Pi persists the tool result.
		manager.appendMessage({ role: "toolResult", toolCallId: "call-launch", toolName: "delegate", content: [{ type: "text", text: `Launched async run ${inFlight} (scout)` }],
			details: { runId: inFlight, runs: [{ id: inFlight, label: "scout", agent: "scout" }] }, isError: false, timestamp: 20 } as any);
		first.owner.dispose(); // the crash: no record for the in-flight run, no shutdown runs entry
		assert.ok(!terminalEntries(manager).some((entry) => (entry as { data: { originRunId?: string } }).data.originRunId === inFlight), "the receipt is the run's only trace");
		for (const next of [SessionManager.open(manager.getSessionFile()!), SessionManager.forkFrom(manager.getSessionFile()!, root, root)]) {
			const resumed = instance(next, true);
			const id = await settleRun(resumed.tracker, resumed.ledger, { ...emptyUsage(), input: 1, cost: 1 });
			assert.ok(![settled, inFlight].includes(id), `${id} is new in this file`);
			assert.equal(id, "run-3");
			resumed.owner.dispose();
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tracked council whose strategy throws keeps its legs' spend live, but a restart cannot rebuild it (documented under-count)", async () => {
	const root = mkdtempSync(join(tmpdir(), "persona-cost-throw-"));
	try {
		const manager = SessionManager.create(root, root);
		conversation(manager);
		const live = instance(manager, true);
		const runs = createBackgroundRuns({
			tracker: live.tracker, agentTree: new AgentTree(() => 0), stopRegistry: new Map(), slots: new Semaphore(2),
			completionNotifier: { discard: () => {} }, startPeek: () => {}, childUsage: live.ledger, publishPersonaCost: () => {},
		});
		const legs = [{ ...emptyUsage(), input: 40, output: 5, cost: 0.25 }, { ...emptyUsage(), input: 30, output: 2, cost: 0.125 }];
		const id = runs.launch({ kind: "council", label: "council magi", task: "ship it?", inline: true }, async () => {
			for (const leg of legs) live.ledger.add(leg); // the engine wrapper adds each leg as it settles
			throw new Error("strategy exploded");
		});
		const { runs: settled, usage } = await runs.settle([id], undefined);
		assert.equal(settled[0]?.status, "failed");
		assert.equal(settled[0]?.result, undefined, "a thrown strategy leaves the run without a result");
		assert.deepEqual(usage, emptyUsage(), "the settle bills nothing");
		// The headless `council failed: <cause>` tool result, persisted without usage.
		manager.appendMessage({ role: "toolResult", toolCallId: "call-council", toolName: "council", content: [{ type: "text", text: "council failed: strategy exploded" }],
			details: { error: "strategy exploded", strategy: "magi" }, isError: true, ...toolUsageField(usage), timestamp: 20 } as any);
		const record = (terminalEntries(manager) as unknown as Array<{ data: { originRunId?: string; usage: { input: number; cost?: number } } }>).find((entry) => entry.data.originRunId === id);
		assert.ok(record, "the run still records a terminal entry");
		assert.equal(record.data.usage.input, 0, "...with empty usage");
		assert.equal(record.data.usage.cost ?? 0, 0);
		assert.equal(live.ledger.pending().cost, 0.375, "live pending does not drop: the legs' spend stays in persona-cost");
		live.owner.dispose();
		const restarted = instance(SessionManager.open(manager.getSessionFile()!), true);
		assert.equal(restarted.ledger.pending().cost, 0, "after a restart that spend is gone: LIVE != REBUILT for this case");
		restarted.owner.dispose();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

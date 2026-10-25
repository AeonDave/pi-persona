import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type FileEntry } from "@earendil-works/pi-coding-agent";
import { SessionResults } from "../../src/extension/results.ts";
import { AsyncRunTracker, MAX_COMPLETION_REPORT_CHARS, renderCompletion } from "../../src/engine/async.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import { fenceUntrusted } from "../../src/core/fence.ts";
import { TerminalResultArchive } from "../../src/results/archive.ts";
import { TERMINAL_RESULT_ENTRY, RESULT_MAX_ENTRIES } from "../../src/results/types.ts";
import { resultReceiptHint } from "../../src/results/retrieval.ts";
import { registerIntercomTool } from "../../src/tools/intercom-tool.ts";
import { ChildUsageLedger } from "../../src/ui/usage.ts";
import { makeSDK } from "../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../src/orchestration/types.ts";

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

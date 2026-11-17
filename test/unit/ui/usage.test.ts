import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyUsage } from "../../../src/engine/stream.ts";
import { createTerminalResultRecord } from "../../../src/results/record.ts";
import {
	ChildUsageLedger,
	reconstructChildSpend,
	formatPersonaCostStatus,
	formatTokens,
	formatUsage,
	hasBillableUsage,
	PERSONA_COST_STATUS_KEY,
	toToolUsage,
	toolUsageField,
} from "../../../src/ui/usage.ts";

test("formatTokens scales to k/M", () => {
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(2344), "2.3k");
	assert.equal(formatTokens(12000), "12k");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatUsage shows input/output/cache/cost, omitting zeros", () => {
	assert.equal(
		formatUsage({ input: 10, output: 2344, cacheRead: 12000, cacheWrite: 500, cost: 0.05, contextTokens: 0, turns: 1 }),
		"↑10 ↓2.3k R12k W500 $0.0500",
	);
	assert.equal(
		formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }),
		"",
	);
});

test("toToolUsage puts ChildUsage.cost on Pi cost.total (the field the footer sums)", () => {
	const usage = toToolUsage({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.92, contextTokens: 80, turns: 3 });
	assert.equal(usage.input, 10);
	assert.equal(usage.output, 4);
	assert.equal(usage.cacheRead, 2);
	assert.equal(usage.cacheWrite, 1);
	assert.equal(usage.totalTokens, 17);
	assert.equal(usage.cost.total, 0.92);
	assert.equal(PERSONA_COST_STATUS_KEY, "persona-cost");
});

test("toolUsageField omits usage when the child billed nothing", () => {
	assert.equal(hasBillableUsage(emptyUsage()), false);
	assert.deepEqual(toolUsageField(emptyUsage()), {});
	assert.ok("usage" in toolUsageField({ ...emptyUsage(), cost: 0.001 }));
});

test("formatPersonaCostStatus matches pi-theme-1337's frame $0.423 / $2.50 convention", () => {
	assert.equal(formatPersonaCostStatus(emptyUsage()), undefined);
	assert.equal(formatPersonaCostStatus({ ...emptyUsage(), cost: 0.999 }), "$0.999");
	assert.equal(formatPersonaCostStatus({ ...emptyUsage(), cost: 1.92 }), "$1.92");
	assert.equal(formatPersonaCostStatus({ ...emptyUsage(), cost: 0.0005 }), "$0.001");
});

test("formatPersonaCostStatus clears a fully billed ledger's floating point residue", () => {
	const ledger = new ChildUsageLedger();
	for (const cost of [0.1, 0.2, 0.3]) ledger.add({ ...emptyUsage(), cost });
	for (const cost of [0.3, 0.2, 0.1]) ledger.account({ ...emptyUsage(), cost });
	assert.ok(ledger.pending().cost > 0, "different summation orders leave a floating point residue");
	assert.equal(formatPersonaCostStatus(ledger.pending()), undefined);
});

test("ChildUsageLedger pending is engine-added spend not yet on a tool result", () => {
	const ledger = new ChildUsageLedger();
	ledger.add({ ...emptyUsage(), cost: 0.25, input: 100 });
	ledger.add({ ...emptyUsage(), cost: 0.5, input: 50 });
	assert.equal(ledger.pending().cost, 0.75);
	ledger.account({ ...emptyUsage(), cost: 0.25, input: 100 });
	assert.equal(ledger.pending().cost, 0.5);
	assert.equal(ledger.pending().input, 50);
});

test("ChildUsageLedger account with a key is idempotent so repeated result retrievals cannot double-bill", () => {
	const ledger = new ChildUsageLedger();
	const u = { ...emptyUsage(), cost: 0.3 };
	ledger.add(u);
	assert.equal(ledger.account(u, "run-1"), true);
	assert.equal(ledger.account(u, "run-1"), false);
	assert.equal(ledger.pending().cost, 0);
	const fresh = ledger.accountMany([
		{ key: "run-1", usage: u },
		{ key: "run-2", usage: { ...emptyUsage(), cost: 0.2 } },
	]);
	assert.equal(fresh.cost, 0.2);
});

test("ChildUsageLedger reset clears a session's child spend", () => {
	const ledger = new ChildUsageLedger();
	ledger.add({ ...emptyUsage(), cost: 1 });
	ledger.account({ ...emptyUsage(), cost: 1 }, "run-1");
	ledger.reset();
	assert.deepEqual(ledger.pending(), emptyUsage());
	assert.equal(ledger.account({ ...emptyUsage(), cost: 1 }, "run-1"), true);
});


// ── session-file rebuild ────────────────────────────────────────────────────────

let refSeq = 0;
/** A terminal record; every call is a DISTINCT record (fresh ref) unless `ref` is given. */
const terminal = (runId: string | undefined, cost: number, ref = `result:00000000-0000-4000-8000-${String(++refSeq).padStart(12, "0")}`) => ({
	type: "custom", customType: "pi-persona-terminal-result",
	data: createTerminalResultRecord({ originKey: `gen-${refSeq}:tracker:${runId}`, ...(runId ? { originRunId: runId } : {}), status: "done", agent: "scout", body: "x", provenance: "result-output", usage: { input: 10, output: 5, cost } }, ref, 1),
});
const refOf = (entry: ReturnType<typeof terminal>): string => entry.data.ref;
const billing = (toolName: string, cost: number, details: Record<string, unknown>) => ({
	type: "message",
	message: { role: "toolResult", toolName, toolCallId: "c", content: [], details, isError: false, timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } },
});
const near = (actual: number, expected: number, message = "") => assert.ok(Math.abs(actual - expected) < 1e-9, `${message} ${actual} ≈ ${expected}`);
const pendingOf = (entries: unknown[]) => { const ledger = new ChildUsageLedger(); ledger.restore(entries); return ledger.pending(); };

test("reconstructChildSpend: an empty or unrelated history is zero", () => {
	assert.deepEqual(reconstructChildSpend([]).total, emptyUsage());
	const history = reconstructChildSpend([{ type: "message", message: { role: "assistant", usage: { cost: { total: 9 } } } }, null, 7, { type: "custom", customType: "other", data: {} }]);
	assert.equal(history.total.cost, 0);
	assert.equal(history.billed.cost, 0);
});

test("reconstructChildSpend: corrupted terminal records cannot invent spend or hide a valid record", () => {
	const valid = terminal("run-1", 0.5);
	const corruptions = [
		{ version: 999 },
		{ ref: "not-a-result-ref" },
		{ originRunId: "" },
		{ originKey: "" },
		{ usage: { input: 0.5, output: 0, cost: 7 } },
		{ usage: { input: 0, output: 0, cost: Number.MAX_SAFE_INTEGER + 1 } },
	];
	for (const patch of corruptions) {
		const corrupted = { ...valid, data: { ...valid.data, ...patch } };
		assert.deepEqual(reconstructChildSpend([corrupted]).total, emptyUsage(), JSON.stringify(patch));
		assert.equal(reconstructChildSpend([corrupted, valid]).total.cost, 0.5, "a rejected record cannot reserve the valid record's ref");
	}
});

test("reconstructChildSpend: unbilled runs are pending; each billing path removes exactly its record", () => {
	const council = terminal("run-3", 0.125);
	const intercomRun = terminal("run-1", 0.5);
	const entries = [
		intercomRun,
		terminal("run-2", 0.25),
		council,
		terminal("run-4", 2),
		terminal("root:4f1c2b9e-0000-4000-8000-000000000001", 4), // an untracked /orchestrate root counts like a run
		billing("intercom", 0.5, { action: "result", ok: true, runId: "run-1", resultReceipt: { ref: refOf(intercomRun) } }),
		billing("delegate", 0.25, { settledRuns: [{ id: "run-2", agent: "scout" }] }),
		billing("council", 0.125, { ok: true, resultReceipt: { ref: refOf(council) } }),
	];
	near(pendingOf(entries).cost, 6);
	const history = reconstructChildSpend(entries);
	near(history.total.cost, 6.875);
	near(history.billed.cost, 0.875);
});

test("reconstructChildSpend: records are counted per record identity — two records sharing a run id are two runs (F2)", () => {
	const first = terminal("run-1", 0.5);
	const history = reconstructChildSpend([first, terminal("run-1", 0.25), first, terminal(undefined, 0.3), terminal(undefined, 0.2)]);
	near(history.total.cost, 0.75); // the same record twice is one record; leg/phase records never sit beside their run
	assert.equal(history.total.input, 20);
	// A record without a ref is not a well-formed archive record.
	assert.equal(reconstructChildSpend([{ type: "custom", customType: "pi-persona-terminal-result", data: { originRunId: "run-9", usage: { input: 1, output: 1, cost: 1 } } }]).total.cost, 0);
});

test("reconstructChildSpend: a billing naming a run id claims the most recent PRECEDING record with that id", () => {
	const collect = (id: string, cost: number) => billing("delegate", cost, { settledRuns: [{ id }] });
	// Owner generation A runs and collects run-1; generation B (a fork or crash) reissues run-1.
	near(pendingOf([terminal("run-1", 0.5), collect("run-1", 0.5), terminal("run-1", 2)]).cost, 2, "the earlier billing belongs to the earlier record");
	near(pendingOf([terminal("run-1", 0.5), terminal("run-1", 2), collect("run-1", 2)]).cost, 0.5, "the later billing belongs to the later record");
	near(pendingOf([collect("run-1", 0.5), terminal("run-1", 0.5)]).cost, 0.5, "a record that follows the billing is not what it billed");
	near(pendingOf([terminal("run-1", 0.5), collect("run-1", 0.5), collect("run-1", 0.5)]).cost, 0, "a record is claimed at most once");
	// An exact receipt ref wins over the run id, and a ref absent from the file falls back to nothing.
	const older = terminal("run-1", 0.5);
	const newer = terminal("run-1", 2);
	near(pendingOf([older, newer, billing("intercom", 0.5, { action: "result", runId: "run-1", resultReceipt: { ref: refOf(older) } })]).cost, 2);
	near(pendingOf([older, billing("intercom", 2, { action: "result", runId: "run-1", resultReceipt: { ref: "result:ffffffff-ffff-4fff-8fff-ffffffffffff" } })]).cost, 0.5);
});

test("reconstructChildSpend: a billing that resolves to no record adds nothing and subtracts nothing (F3)", () => {
	const recorded = [terminal("run-1", 1), terminal("run-2", 0.5)];
	near(pendingOf([...recorded, billing("delegate", 99, { settledRuns: [{ id: "run-7" }] })]).cost, 1.5, "a run whose record never reached the file");
	near(pendingOf([...recorded, billing("intercom", 99, { action: "result", runId: "run-8" })]).cost, 1.5);
	near(pendingOf([...recorded, billing("flow", 99, { resultReceipt: { ref: "result:22222222-2222-4222-8222-222222222222" } })]).cost, 1.5);
	// A council/flow receipt without a ref (no record was saved) names no run at all.
	near(pendingOf([...recorded, billing("council", 0.5, { ok: true, resultReceipt: { warning: "Terminal report not archived (quota)." } })]).cost, 1.5);
	near(pendingOf([...recorded, billing("council", 0.5, { ok: true })]).cost, 1.5);
});

test("reconstructChildSpend: billing results from other tools, usage-less results and malformed records are ignored", () => {
	const ledger = new ChildUsageLedger();
	ledger.restore([
		terminal("run-1", 1),
		billing("bash", 1, { runId: "run-1", action: "result" }),
		{ type: "message", message: { role: "toolResult", toolName: "delegate", details: { settledRuns: [{ id: "run-1" }] } } },
		{ type: "custom", customType: "pi-persona-terminal-result", data: { ref: "result:a", originRunId: "run-9", usage: { input: -1, output: 0, cost: 5 } } },
		{ type: "custom", customType: "pi-persona-terminal-result", data: { ref: "result:b", originRunId: "run-8", usage: { input: 1, output: 1, cost: "5" } } },
	]);
	assert.equal(ledger.pending().cost, 1);
});

test("ChildUsageLedger restore keeps the sums but never lets a restored run id veto a NEW run's billing (F1)", () => {
	const ledger = new ChildUsageLedger();
	ledger.restore([terminal("run-2", 0.25), billing("delegate", 0.25, { settledRuns: [{ id: "run-2" }] }), terminal("run-3", 1)]);
	near(ledger.pending().cost, 1);
	// A later instance whose counter restarted reissues run-2 for a NEW run, then collects it.
	ledger.add({ ...emptyUsage(), cost: 0.5 });
	assert.equal(ledger.account({ ...emptyUsage(), cost: 0.5 }, "run-2"), true, "the new run's usage reaches the collecting tool result");
	near(ledger.pending().cost, 1);
	assert.equal(ledger.account({ ...emptyUsage(), cost: 0.5 }, "run-2"), false, "within one instance a run is still billed once");
});

test("ChildUsageLedger restore replaces the previous session and a superseded run's late spend is dropped", () => {
	const ledger = new ChildUsageLedger();
	const before = ledger.session();
	ledger.add({ ...emptyUsage(), cost: 3 }, before);
	ledger.restore([terminal("run-1", 0.25)]);
	assert.equal(ledger.pending().cost, 0.25, "restore starts from the file, not from the previous session's figure");
	ledger.add({ ...emptyUsage(), cost: 7 }, before); // started before the switch, settled after it
	assert.equal(ledger.pending().cost, 0.25);
	ledger.add({ ...emptyUsage(), cost: 0.5 }, ledger.session());
	assert.equal(ledger.pending().cost, 0.75);
	ledger.restore([]);
	assert.equal(ledger.pending().cost, 0, "a brand-new session starts at zero");
});

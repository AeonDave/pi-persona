import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentResult } from "../../../src/orchestration/types.ts";
import { aggregateResults, itemLedger, sumUsage } from "../../../src/orchestration/reducers.ts";

const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 1,
});

const ok = (agent: string, output: string): AgentResult => ({ agent, output, usage: usage(1), ok: true });

test("sumUsage adds usage fields across results", () => {
	const t = sumUsage([usage(3), usage(4)]);
	assert.equal(t.input, 7);
	assert.equal(t.turns, 2);
});

test("aggregateResults concatenates labeled sections, sums usage, and embeds structured", () => {
	const agg = aggregateResults([ok("a", "A out"), ok("b", "B out")]);
	assert.match(agg.output, /\[a\]/);
	assert.match(agg.output, /A out/);
	assert.match(agg.output, /B out/);
	assert.equal(agg.usage.input, 2);
	assert.equal(agg.ok, true);
	assert.equal(agg.structured?.count, 2);
});

test("aggregateResults is ok=false when any result failed", () => {
	const agg = aggregateResults([ok("a", "fine"), { agent: "b", output: "x", usage: usage(1), ok: false, error: "boom" }]);
	assert.equal(agg.ok, false);
	assert.match(agg.output, /boom/, "the supervisor must receive the actionable leg error, not only '(no output)'");
	assert.equal((agg.structured?.results as Array<Record<string, unknown>>)[1]?.error, "boom");
});

test("aggregateResults preserves a failure kind when the failed leg has no output", () => {
	const agg = aggregateResults([
		{ agent: "isolated", output: "", usage: usage(1), ok: false, error: "worktree requires a clean Git checkout", failureKind: "contract" },
	]);
	assert.match(agg.output, /worktree requires a clean Git checkout/);
	assert.match(agg.output, /contract/);
});

test("aggregateResults propagates the homogeneous failed-leg cause", () => {
	const agg = aggregateResults([
		{ agent: "a", output: "", usage: usage(1), ok: false, error: "provider unavailable", failureKind: "provider" },
		{ agent: "b", output: "", usage: usage(1), ok: false, error: "provider unavailable", failureKind: "provider" },
	]);
	assert.equal(agg.ok, false);
	assert.equal(agg.error, "provider unavailable");
	assert.equal(agg.failureKind, "provider");
});

test("itemLedger marks completed, failed (with cause), and not-run (dropped) items", () => {
	const allItems = [{ item: "alpha" }, { item: "beta" }, { item: "gamma" }, { item: "delta" }];
	const results: AgentResult[] = [
		ok("worker", "did alpha"),
		{ agent: "worker", output: "", usage: usage(1), ok: false, error: "timed out", failureKind: "timeout" },
	];
	// gamma/delta were beyond the worker cap — 2 of the 4 split items were never spawned.
	const ledger = itemLedger(allItems, results, 2);
	assert.deepEqual(ledger, [
		{ index: 0, item: "alpha", status: "completed", agent: "worker" },
		{ index: 1, item: "beta", status: "failed", agent: "worker", failureKind: "timeout", error: "timed out" },
		{ index: 2, item: "gamma", status: "not-run" },
		{ index: 3, item: "delta", status: "not-run" },
	]);
});

test("itemLedger carries a declared writeSet through for every status", () => {
	const allItems = [
		{ item: "alpha", writeSet: ["src/a.ts"] },
		{ item: "beta", writeSet: ["src/b.ts"] },
	];
	const results: AgentResult[] = [ok("worker", "did alpha")];
	const ledger = itemLedger(allItems, results, 1);
	assert.deepEqual(ledger[0]?.writeSet, ["src/a.ts"]);
	assert.equal(ledger[1]?.status, "not-run");
	assert.deepEqual(ledger[1]?.writeSet, ["src/b.ts"]);
});

test("itemLedger with no items and nothing dropped is empty", () => {
	assert.deepEqual(itemLedger([], [], 0), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentResult } from "../../../src/orchestration/types.ts";
import { aggregateResults, sumUsage } from "../../../src/orchestration/reducers.ts";

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
});

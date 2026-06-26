import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentResult } from "../../../src/orchestration/types.ts";
import { voteReduce } from "../../../src/orchestration/voting.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const c = (agent: string, vote: string, conf = 0.5, ok = true): AgentResult => ({
	agent,
	output: `o:${agent}`,
	structured: { vote, confidence: conf },
	usage: usage(),
	ok,
});

test("majority vote picks the plurality winner and records tally + dissent", () => {
	const r = voteReduce([c("m1", "A"), c("m2", "A"), c("m3", "B")], { aggregate: "majority" });
	assert.equal(r.status, "winner");
	assert.equal(r.winner?.structured?.vote, "A");
	assert.equal(r.tally.a, 2); // tally keys are normalised (lowercase)
	assert.equal(r.tally.b, 1);
	assert.equal(r.dissent?.length, 1);
});

test("vote keys are normalised (case/separators) so equivalent votes tally together", () => {
	const r = voteReduce([c("m1", "json-first"), c("m2", "JSON_First"), c("m3", "yaml")], { aggregate: "majority" });
	assert.equal(r.status, "winner");
	assert.equal(r.tally["json-first"], 2);
	assert.equal(r.tally.yaml, 1);
	assert.equal(r.winner?.structured?.vote, "json-first");
});

test("unanimity requires every valid candidate to agree", () => {
	assert.equal(voteReduce([c("a", "X"), c("b", "X")], { aggregate: "unanimity" }).status, "winner");
	assert.equal(voteReduce([c("a", "X"), c("b", "Y")], { aggregate: "unanimity" }).status, "no_consensus");
});

test("a tie returns status 'tie', or a best-by-confidence fallback when enabled", () => {
	const tie = voteReduce([c("a", "A", 0.4), c("b", "B", 0.9)], { aggregate: "majority" });
	assert.equal(tie.status, "tie");
	assert.equal(tie.winner, undefined);

	const fb = voteReduce([c("a", "A", 0.4), c("b", "B", 0.9)], { aggregate: "majority", keepBestFallback: true });
	assert.equal(fb.status, "tie");
	assert.equal(fb.usedFallback, true);
	assert.equal(fb.winner?.structured?.vote, "B", "fallback picks the highest-confidence candidate");
});

test("candidates that failed or have no usable vote are invalid", () => {
	const r = voteReduce(
		[
			{ agent: "x", output: "", structured: {}, usage: usage(), ok: true },
			c("y", "A", 0.5, false),
		],
		{ aggregate: "majority" },
	);
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.invalid?.length, 2);
});

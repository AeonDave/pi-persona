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

test("a threshold (best-of-X) requires the plurality winner to reach it, else fallback", () => {
	const win = voteReduce([c("a", "A"), c("b", "A"), c("c", "B")], { aggregate: "majority", threshold: 2 });
	assert.equal(win.status, "winner", "A has 2 votes, meets threshold 2");

	const short = voteReduce([c("a", "A"), c("b", "A"), c("c", "B")], {
		aggregate: "majority",
		threshold: 3,
		keepBestFallback: true,
	});
	assert.equal(short.status, "no_consensus", "A has 2 votes, short of best-of-3");
	assert.equal(short.usedFallback, true);
	assert.ok((short.dissent?.length ?? 0) >= 1, "dissent preserved on the threshold-miss fallback");
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
	assert.equal(fb.dissent?.length, 1, "the minority report is preserved even on the fallback path");
	assert.equal(fb.dissent?.[0]?.structured?.vote, "A");
});

test("no_consensus fallback also records the dissenting cores (3-way tie)", () => {
	const r = voteReduce([c("a", "A", 0.3), c("b", "B", 0.9), c("c", "C", 0.5)], {
		aggregate: "unanimity",
		keepBestFallback: true,
	});
	assert.equal(r.status, "no_consensus");
	assert.equal(r.winner?.structured?.vote, "B");
	assert.equal(r.dissent?.length, 2, "both losing cores are recorded as dissent");
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

const u = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

test("all-invalid + keepBestFallback + ok prose → best-confidence prose wins (usedFallback)", () => {
	const cands = [
		{ agent: "a", output: "weak take", structured: { confidence: 0.3 }, usage: u(), ok: true },
		{ agent: "b", output: "strong take", structured: { confidence: 0.9 }, usage: u(), ok: true },
	];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, true);
	assert.equal(r.winner?.agent, "b", "highest-confidence ok-prose candidate is surfaced");
	assert.equal(r.dissent?.length, 1);
	assert.equal(r.invalid?.length, 0, "surfaced prose (winner + dissent) is not double-counted as excluded");
});

test("all-invalid rescue counts only the genuinely-dropped candidates as invalid", () => {
	// 2 ok-prose (winner + dissent) + 1 failed member: only the failed one is 'excluded'.
	const cands = [
		{ agent: "a", output: "strong", structured: { confidence: 0.9 }, usage: u(), ok: true },
		{ agent: "b", output: "weak", structured: { confidence: 0.2 }, usage: u(), ok: true },
		{ agent: "c", output: "", usage: u(), ok: false },
	];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.winner?.agent, "a");
	assert.equal(r.dissent?.length, 1, "b is the minority prose");
	assert.equal(r.invalid?.length, 1, "only the failed member c is counted as excluded");
	assert.equal(r.invalid?.[0]?.agent, "c");
});

test("all-invalid with NO ok prose → unchanged empty invalid_outputs", () => {
	const cands = [{ agent: "a", output: "", usage: u(), ok: false }];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, false);
	assert.equal(r.winner, undefined);
});

test("all-invalid WITHOUT keepBestFallback → still empty (no rescue)", () => {
	const cands = [{ agent: "a", output: "prose", usage: u(), ok: true }];
	const r = voteReduce(cands, { aggregate: "majority" });
	assert.equal(r.winner, undefined);
});

test("contract-only failures ARE rescued by keepBestFallback (the engine-produced shape)", () => {
	// This is what an engine actually emits when a member answers in prose instead of the
	// vote JSON: ok=false, failureKind="contract", output intact. The live-drive debate bug:
	// requiring `ok` here left the ruling empty even though both members argued fine.
	const cands: AgentResult[] = [
		{ agent: "a", output: "CommonJS, because…", usage: u(), ok: false, failureKind: "contract" },
		{ agent: "b", output: "ESM, because…", structured: { confidence: 0.7 }, usage: u(), ok: false, failureKind: "contract" },
	];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, true);
	assert.equal(r.winner?.agent, "b", "highest-confidence contract-failed prose is surfaced");
	assert.equal(r.dissent?.length, 1);
	assert.equal(r.invalid?.length, 0, "rescued prose is not double-counted as excluded");
});

test("hard failures (timeout/abort/provider/agent) are NEVER rescued as prose", () => {
	const cands: AgentResult[] = [
		{ agent: "a", output: "partial output before dying", usage: u(), ok: false, failureKind: "timeout" },
		{ agent: "b", output: "also died", usage: u(), ok: false, failureKind: "provider" },
	];
	const r = voteReduce(cands, { aggregate: "majority", keepBestFallback: true });
	assert.equal(r.status, "invalid_outputs");
	assert.equal(r.usedFallback, false);
	assert.equal(r.winner, undefined);
	assert.equal(r.invalid?.length, 2);
});

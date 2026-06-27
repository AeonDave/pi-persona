import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareJudge } from "../../../src/orchestration/judge.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const cand = (agent: string, output: string): AgentResult => ({ agent, output, usage: usage(), ok: true });

test("prepareJudge anonymizes + labels candidates and resolves the verdict back", () => {
	const cands = [cand("melchior", "ship json"), cand("balthasar", "ship yaml")];
	// order [1,0]: ballot position A → candidate 1 (balthasar), B → candidate 0 (melchior)
	const rep = prepareJudge(cands, [1, 0]);
	assert.match(rep.ballot, /\[A\][\s\S]*ship yaml/);
	assert.match(rep.ballot, /\[B\][\s\S]*ship json/);
	assert.doesNotMatch(rep.ballot, /melchior|balthasar/, "no author identity leaks to the judge");
	assert.equal(rep.pick("A")?.agent, "balthasar");
	assert.equal(rep.pick("b")?.agent, "melchior", "case-insensitive");
	assert.equal(rep.pick("Z"), undefined, "an unknown label resolves to nothing");
});

test("prepareJudge defaults to candidate order when no permutation is given", () => {
	const rep = prepareJudge([cand("a", "first"), cand("b", "second")]);
	assert.equal(rep.pick("A")?.agent, "a");
	assert.equal(rep.pick("B")?.agent, "b");
});

test("prepareJudge ignores invalid candidates failing the contract excluded upstream", () => {
	const rep = prepareJudge([cand("only", "the one")]);
	assert.match(rep.ballot, /\[A\][\s\S]*the one/);
	assert.equal(rep.pick("A")?.agent, "only");
});

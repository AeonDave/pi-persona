import { test } from "node:test";
import assert from "node:assert/strict";

import { makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { magi } from "../../../src/orchestration/strategies/magi.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

function votingEngine(votes: Record<string, string>): StrategyEngine {
	return {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: `${s.agent} says ${votes[s.agent]}`,
			structured: { vote: votes[s.agent], confidence: 0.7 },
			usage: usage(),
			ok: true,
		}),
	};
}

test("magi runs the roster, votes by majority, and reports the ruling + tally", async () => {
	const sdk = makeSDK({
		engine: votingEngine({ melchior: "A", balthasar: "A", casper: "B" }),
		roster: { team: (n) => (n === "magi" ? ["melchior", "balthasar", "casper"] : []) },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.equal(r.ok, true);
	assert.equal(r.structured?.status, "winner");
	assert.match(r.output, /a=2/);
	assert.match(r.output, /dissent/i);
});

test("magi's ruling renders the winner's human fields, not the raw JSON envelope", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: '```json\n{"result":"ship json","vote":"json","output":"because reasons","confidence":0.9}\n```',
			structured: { result: "ship json", vote: "json", output: "because reasons", confidence: 0.9 },
			usage: usage(),
			ok: true,
		}),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["melchior", "balthasar", "casper"] }, limits: LIMITS });
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.match(r.output, /ship json/, "shows the winner's one-line result");
	assert.match(r.output, /because reasons/, "shows the winner's output synthesis");
	assert.doesNotMatch(r.output, /```/, "no code fence leaks into the ruling");
	assert.doesNotMatch(r.output, /"vote":/, "no raw JSON envelope in the ruling");
});

test("magi leads with the ruling (not the decision/tally plumbing) and exposes a headline", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: "raw",
			structured: { result: "ship json", vote: "json", output: "because reasons", confidence: 0.9 },
			usage: usage(),
			ok: true,
		}),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["melchior", "balthasar", "casper"] }, limits: LIMITS });
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.doesNotMatch(r.output.split("\n")[0] ?? "", /MAGI decision|tally/, "content leads with the ruling, not the plumbing");
	assert.match(r.output, /ship json/);
	assert.equal(r.structured?.headline, "ship json", "headline is the winner's one-liner, for the collapsed card");
});

test("magi honours unanimity and surfaces no_consensus when the 3 disagree", async () => {
	const sdk = makeSDK({
		engine: votingEngine({ melchior: "A", balthasar: "B", casper: "C" }),
		roster: { team: () => ["melchior", "balthasar", "casper"] },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { aggregate: "unanimity" } }, sdk);
	assert.match(r.output, /no_consensus/);
});

test("magi requires a roster", async () => {
	const sdk = makeSDK({ engine: votingEngine({}), roster: { team: () => [] }, limits: LIMITS });
	await assert.rejects(() => magi.run({ task: "decide", params: {} }, sdk));
});

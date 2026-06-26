import { test } from "node:test";
import assert from "node:assert/strict";

import { type AgentRunSpec, makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { criticLoop } from "../../../src/orchestration/strategies/critic-loop.ts";
import { fanout } from "../../../src/orchestration/strategies/fanout.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

test("fanout runs every roster agent in parallel and aggregates the results", async () => {
	const calls: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			calls.push(spec.agent);
			return { agent: spec.agent, output: `out:${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "review" ? ["a", "b", "c"] : []) }, limits: LIMITS });
	const r = await fanout.run({ task: "T", roster: "review", params: {} }, sdk);
	assert.deepEqual(calls.sort(), ["a", "b", "c"]);
	assert.equal(r.structured?.count, 3);
	assert.match(r.output, /out:a/);
});

test("the SDK reports per-agent status (running → done) via onAgentStatus", async () => {
	const events: string[] = [];
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStatus: (a, st) => events.push(`${a}:${st}`),
	});
	await sdk.agent({ agent: "melchior", task: "t" });
	assert.deepEqual(events, ["melchior:running", "melchior:done"]);
});

test("the SDK enforces maxChildren regardless of strategy code", async () => {
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 2 },
	});
	await sdk.agent({ agent: "a", task: "t" });
	await sdk.agent({ agent: "b", task: "t" });
	await assert.rejects(() => sdk.agent({ agent: "c", task: "t" }), /maxChildren/);
});

test("the SDK enforces the token budget across a run", async () => {
	const sdk = makeSDK({
		engine: {
			run: async (s) => ({ agent: s.agent, output: "o", usage: { ...usage(), input: 100, output: 100 }, ok: true }),
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, budgetTokens: 150 },
	});
	await sdk.agent({ agent: "a", task: "t" }); // spends 200 > 150
	await assert.rejects(() => sdk.agent({ agent: "b", task: "t" }), /budget/);
});

test("the SDK forwards per-agent streaming progress via onAgentProgress", async () => {
	const seen: string[] = [];
	const sdk = makeSDK({
		engine: {
			run: async (s, onProgress) => {
				onProgress?.({ output: "partial", tokens: 5 });
				return { agent: s.agent, output: "final", usage: usage(), ok: true };
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentProgress: (a, p) => seen.push(`${a}:${p.output}:${p.tokens}`),
	});
	await sdk.agent({ agent: "melchior", task: "t" });
	assert.deepEqual(seen, ["melchior:partial:5"]);
});

test("fanout throws when no roster is provided", async () => {
	const engine: StrategyEngine = { run: async () => ({ agent: "x", output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: LIMITS });
	await assert.rejects(() => fanout.run({ task: "T", params: {} }, sdk));
});

test("critic-loop revises while the critic rejects, then stops on approve", async () => {
	let criticCalls = 0;
	let genCalls = 0;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "skeptic") {
				criticCalls++;
				return {
					agent: "skeptic",
					output: "crit",
					structured: { stance: criticCalls < 2 ? "reject" : "approve" },
					usage: usage(),
					ok: true,
				};
			}
			genCalls++;
			return { agent: spec.agent, output: `gen#${genCalls}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["writer"] }, limits: LIMITS });
	const r = await criticLoop.run({ task: "T", roster: "team", params: { critic: "skeptic", rounds: 5 } }, sdk);
	assert.equal(criticCalls, 2, "critic ran twice (reject then approve)");
	assert.equal(genCalls, 2, "generator ran initial + one revision");
	assert.equal(r.output, "gen#2");
});

test("critic-loop stops at maxRounds even if the critic keeps rejecting", async () => {
	let genCalls = 0;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "skeptic") {
				return { agent: "skeptic", output: "crit", structured: { stance: "reject" }, usage: usage(), ok: true };
			}
			genCalls++;
			return { agent: spec.agent, output: `gen#${genCalls}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["writer"] }, limits: LIMITS });
	await criticLoop.run({ task: "T", roster: "team", params: { critic: "skeptic", generator: "writer", rounds: 2 } }, sdk);
	assert.equal(genCalls, 3, "initial generation + 2 revisions");
});

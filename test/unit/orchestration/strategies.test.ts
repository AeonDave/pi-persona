import { test } from "node:test";
import assert from "node:assert/strict";

import { type AgentRunSpec, makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { councilRounds } from "../../../src/orchestration/strategies/council-rounds.ts";
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

test("the SDK exposes a per-agent abort via onAgentStart (engine sees the aborted signal)", async () => {
	let sawAborted: boolean | undefined;
	const sdk = makeSDK({
		engine: {
			run: async (s, _p, signal) => {
				sawAborted = signal?.aborted;
				return { agent: s.agent, output: "o", usage: usage(), ok: true };
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStart: (_a, abort) => abort(), // stop this agent immediately
	});
	await sdk.agent({ agent: "x", task: "t" });
	assert.equal(sawAborted, true, "the engine received the per-agent abort signal");
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

test("council-rounds runs more rounds until best-of-X is reached, carrying the debate forward", async () => {
	const team = ["a", "b", "c"];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			const later = spec.task.includes("debate"); // round ≥ 2 carries the prior debate
			const vote = later ? "x" : spec.agent === "a" ? "x" : spec.agent === "b" ? "y" : "z";
			return { agent: spec.agent, output: `${spec.agent}:${vote}`, structured: { vote, confidence: 0.7 }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "t" ? team : []) }, limits: LIMITS });
	const r = await councilRounds.run({ task: "decide", roster: "t", params: { rounds: 3, bestOf: 3 } }, sdk);
	assert.equal(r.structured?.status, "winner");
	assert.equal(r.structured?.rounds, 2, "split in round 1, converged in round 2");
	assert.match(r.output, /best-of-3/);
});

test("council-rounds falls back to best-by-confidence on the final round without a supermajority", async () => {
	const team = ["a", "b", "c"];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			const vote = spec.agent === "a" ? "x" : spec.agent === "b" ? "y" : "z"; // never converges
			const confidence = spec.agent === "b" ? 0.9 : 0.4;
			return { agent: spec.agent, output: spec.agent, structured: { vote, confidence }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => team }, limits: LIMITS });
	const r = await councilRounds.run({ task: "decide", roster: "t", params: { rounds: 2, bestOf: 3 } }, sdk);
	assert.equal(r.structured?.usedFallback, true);
	assert.equal(r.structured?.rounds, 2);
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

test("critic-loop takes generator + critic from the roster's two entities by default", async () => {
	const seen: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			seen.push(spec.agent);
			if (spec.agent === "skeptic") {
				return { agent: "skeptic", output: "c", structured: { stance: "approve" }, usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: "draft", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["builder", "skeptic"] }, limits: LIMITS });
	await criticLoop.run({ task: "T", roster: "antagonist", params: {} }, sdk);
	assert.ok(seen.includes("builder"), "generator = roster[0]");
	assert.ok(seen.includes("skeptic"), "critic = roster[1]");
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

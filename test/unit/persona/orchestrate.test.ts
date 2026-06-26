import { test } from "node:test";
import assert from "node:assert/strict";

import type { StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { resolveStrategyName, runPersonaStrategy } from "../../../src/persona/orchestrate.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

test("resolveStrategyName resolves an explicit strategy, or parallel → fanout", () => {
	assert.equal(resolveStrategyName({ mode: "strategy", strategy: "magi" }), "magi");
	assert.equal(resolveStrategyName({ mode: "parallel" }), "fanout");
	assert.equal(resolveStrategyName({ mode: "solo" }), undefined);
	assert.equal(resolveStrategyName({ mode: "pipeline" }), undefined);
});

test("runPersonaStrategy runs the persona's strategy with its roster + params", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: `o:${s.agent}`,
			structured: { vote: "X", confidence: 0.5 },
			usage: usage(),
			ok: true,
		}),
	};
	const r = await runPersonaStrategy({ mode: "strategy", strategy: "magi", roster: "magi", params: { aggregate: "majority" } }, "decide", {
		engine,
		teams: { magi: ["melchior", "balthasar", "casper"] },
		limits: LIMITS,
	});
	assert.ok(r);
	assert.match(r.output, /— magi: winner · tally/);
});

test("runPersonaStrategy returns null for a non-runnable (solo) persona", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const r = await runPersonaStrategy({ mode: "solo" }, "t", { engine, teams: {}, limits: LIMITS });
	assert.equal(r, null);
});

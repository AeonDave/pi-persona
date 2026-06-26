import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { runDelegate } from "../../../src/tools/delegate.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const engineThat = (fn: (spec: AgentRunSpec) => AgentResult): StrategyEngine => ({ run: async (s) => fn(s) });

test("runDelegate single mode runs one named agent and returns its output", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: `out:${s.task}`, usage: usage(), ok: true }));
	const r = await runDelegate({ agent: "scout", task: "explore" }, engine);
	assert.equal(r.ok, true);
	assert.equal(r.results.length, 1);
	assert.match(r.text, /out:explore/);
});

test("runDelegate parallel mode runs all tasks (bounded) and aggregates", async () => {
	const seen: string[] = [];
	const engine = engineThat((s) => {
		seen.push(s.agent);
		return { agent: s.agent, output: `out:${s.agent}`, usage: usage(), ok: true };
	});
	const r = await runDelegate(
		{ tasks: [{ agent: "a", task: "t" }, { agent: "b", task: "t" }, { agent: "c", task: "t" }] },
		engine,
	);
	assert.deepEqual(seen.sort(), ["a", "b", "c"]);
	assert.equal(r.results.length, 3);
	assert.match(r.text, /\[a\]/);
	assert.equal(r.ok, true);
});

test("runDelegate reports a single-agent failure with its error", async () => {
	const engine = engineThat(() => ({ agent: "x", output: "", usage: usage(), ok: false, error: "boom" }));
	const r = await runDelegate({ agent: "x", task: "t" }, engine);
	assert.equal(r.ok, false);
	assert.match(r.text, /boom/);
});

test("runDelegate reports live per-task views via onProgress (parallel)", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: `out:${s.agent}`, usage: usage(), ok: true }));
	const doneCounts: number[] = [];
	const r = await runDelegate({ tasks: [{ agent: "a", task: "t" }, { agent: "b", task: "t" }] }, engine, 4, (views) =>
		doneCounts.push(views.filter((v) => !v.running).length),
	);
	assert.equal(r.views.length, 2);
	assert.ok(r.views.every((v) => !v.running && v.ok));
	assert.ok(doneCounts.length >= 2, "progress reported as tasks complete");
	assert.equal(doneCounts[doneCounts.length - 1], 2);
});

test("runDelegate single mode produces one done view", async () => {
	const r = await runDelegate({ agent: "x", task: "t" }, engineThat((s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true })));
	assert.equal(r.views.length, 1);
	assert.equal(r.views[0]?.running, false);
	assert.equal(r.views[0]?.ok, true);
});

test("runDelegate rejects when neither single nor parallel params are given", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }));
	const r = await runDelegate({}, engine);
	assert.equal(r.ok, false);
});

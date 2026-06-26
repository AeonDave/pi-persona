import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { labelFor, runDelegate, shortModel } from "../../../src/tools/delegate.ts";

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
	const r = await runDelegate(
		{ tasks: [{ agent: "a", task: "t" }, { agent: "b", task: "t" }] },
		engine,
		{ maxConcurrency: 4, maxChildren: 8 },
		(views) => doneCounts.push(views.filter((v) => !v.running).length),
	);
	assert.equal(r.views.length, 2);
	assert.ok(r.views.every((v) => !v.running && v.ok));
	assert.ok(doneCounts.length >= 2, "progress reported as tasks complete");
	assert.equal(doneCounts[doneCounts.length - 1], 2);
});

test("runDelegate passes per-task skills/model/tools to the engine (dynamic sub-agent)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (s) => {
			specs.push(s);
			return { agent: s.agent, output: "o", usage: usage(), ok: true };
		},
	};
	await runDelegate(
		{ tasks: [{ agent: "operator", task: "do it", skills: ["python-patterns"], model: "prov/m", tools: ["read"] }] },
		engine,
	);
	assert.deepEqual(specs[0]?.skills, ["python-patterns"]);
	assert.equal(specs[0]?.model, "prov/m");
	assert.deepEqual(specs[0]?.tools, ["read"]);
});

test("runDelegate single mode produces one done view", async () => {
	const r = await runDelegate({ agent: "x", task: "t" }, engineThat((s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true })));
	assert.equal(r.views.length, 1);
	assert.equal(r.views[0]?.running, false);
	assert.equal(r.views[0]?.ok, true);
});

test("runDelegate clamps concurrency and caps the task count to the limits", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const ran: string[] = [];
	const engine: StrategyEngine = {
		run: async (s) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			ran.push(s.agent);
			return { agent: s.agent, output: "o", usage: usage(), ok: true };
		},
	};
	const tasks = Array.from({ length: 6 }, (_, i) => ({ agent: `a${i}`, task: "t" }));
	const r = await runDelegate({ tasks, concurrency: 99 }, engine, { maxConcurrency: 2, maxChildren: 4 });
	assert.equal(ran.length, 4, "task count capped to maxChildren");
	assert.ok(maxInFlight <= 2, "concurrency clamped to maxConcurrency");
	assert.match(r.text, /dropped/);
});

test("shortModel + labelFor produce a friendly 'name · model' label", () => {
	assert.equal(shortModel("anthropic/claude-sonnet-4-6"), "sonnet-4-6");
	assert.equal(shortModel("openrouter/openrouter/owl-alpha:high"), "owl-alpha");
	assert.equal(labelFor({ agent: "operator", model: "anthropic/claude-sonnet-4-6" }, 0), "pippo · sonnet-4-6");
	assert.equal(labelFor({ agent: "scout", model: "x/y" }, 0), "scout · y", "a fixed agent keeps its own name");
	assert.equal(labelFor({ agent: "operator", name: "auditor", model: "p/claude-haiku" }, 3), "auditor · haiku");
});

test("runDelegate carries the display label in each view", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }));
	const r = await runDelegate({ tasks: [{ agent: "operator", task: "t", model: "anthropic/claude-sonnet-4-6" }] }, engine);
	assert.equal(r.views[0]?.label, "pippo · sonnet-4-6");
});

test("runDelegate exposes a per-leg abort via onLegStart", async () => {
	const starts: number[] = [];
	const engine = engineThat((s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }));
	await runDelegate(
		{ tasks: [{ agent: "a", task: "t" }, { agent: "b", task: "t" }] },
		engine,
		undefined,
		undefined,
		(i) => starts.push(i),
	);
	assert.deepEqual(starts.sort(), [0, 1]);
});

test("runDelegate rejects when neither single nor parallel params are given", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }));
	const r = await runDelegate({}, engine);
	assert.equal(r.ok, false);
});

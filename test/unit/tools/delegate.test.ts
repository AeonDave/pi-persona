import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { DelegationLedger, labelFor, MAX_IDENTICAL_FAILURES, runDelegate, shortModel } from "../../../src/tools/delegate.ts";

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

test("runDelegate threads a per-leg steer handle (onLegSteerable) from the engine", async () => {
	const steered: string[] = [];
	const engine: StrategyEngine = {
		run: async (s, _onProgress, _signal, onSteerable) => {
			onSteerable?.((text) => steered.push(`${s.agent}:${text}`));
			return { agent: s.agent, output: "ok", usage: usage(), ok: true };
		},
	};
	const handles: Array<(t: string) => void> = [];
	await runDelegate({ agent: "scout", task: "t" }, engine, undefined, undefined, undefined, (_i, steer) => handles.push(steer));
	assert.equal(handles.length, 1, "onLegSteerable fired for the leg");
	handles[0]?.("redirect to errors");
	assert.deepEqual(steered, ["scout:redirect to errors"], "the steer handle reaches the engine's steer fn");
});

test("runDelegate passes an on-the-fly `role` through to the engine spec (single + parallel)", async () => {
	const roles: Array<string | undefined> = [];
	const engine = engineThat((s) => {
		roles.push(s.role);
		return { agent: s.agent, output: "ok", usage: usage(), ok: true };
	});
	await runDelegate({ agent: "operator", task: "t", role: "You are a Rust auditor." }, engine);
	await runDelegate({ tasks: [{ agent: "operator", task: "t", role: "You are a CSS wizard." }, { agent: "scout", task: "t" }] }, engine);
	assert.deepEqual(roles, ["You are a Rust auditor.", "You are a CSS wizard.", undefined]);
});

test("DelegationLedger vetoes only after MAX identical failures; model/task changes are new keys", () => {
	const ledger = new DelegationLedger();
	const t = { agent: "op", model: "p/m", task: "do X" };
	assert.equal(ledger.vet([t]), undefined, "clean key → allowed");
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record(t, false);
	assert.match(ledger.vet([t]) ?? "", /already failed/, "identical retry is vetoed");
	assert.equal(ledger.vet([{ ...t, model: "p/other" }]), undefined, "a different model is a fresh attempt");
	assert.equal(ledger.vet([{ ...t, task: "do X, but smaller" }]), undefined, "a reworded task is a fresh attempt");
});

test("DelegationLedger clears the key on success (a later identical delegation is allowed again)", () => {
	const ledger = new DelegationLedger();
	const t = { agent: "op", task: "do X" };
	ledger.record(t, false);
	ledger.record(t, false);
	assert.notEqual(ledger.vet([t]), undefined);
	ledger.record(t, true); // it eventually worked (e.g. after a steer)
	assert.equal(ledger.vet([t]), undefined, "success resets the failure count");
});

test("DelegationLedger stays bounded (old keys are evicted, no unbounded growth)", () => {
	const ledger = new DelegationLedger();
	for (let i = 0; i < 500; i++) {
		ledger.record({ agent: "op", task: `task ${i}` }, false);
		ledger.record({ agent: "op", task: `task ${i}` }, false);
	}
	// The earliest keys were evicted — no veto for them anymore; the newest still veto.
	assert.equal(ledger.vet([{ agent: "op", task: "task 0" }]), undefined);
	assert.notEqual(ledger.vet([{ agent: "op", task: "task 499" }]), undefined);
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

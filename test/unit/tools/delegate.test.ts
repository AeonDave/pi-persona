import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { DelegationLedger, labelFor, MAX_IDENTICAL_FAILURES, runDelegate, shortModel, unknownAgentError, wantsAsyncRun } from "../../../src/tools/delegate.ts";

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

test("runDelegate threads mcp:true through to the engine spec (single + parallel), false/absent ⇒ unset", async () => {
	const mcp: Array<boolean | undefined> = [];
	const engine = engineThat((s) => {
		mcp.push(s.mcp);
		return { agent: s.agent, output: "ok", usage: usage(), ok: true };
	});
	await runDelegate({ agent: "operator", task: "t", mcp: true }, engine);
	await runDelegate({ tasks: [{ agent: "operator", task: "t", mcp: true }, { agent: "scout", task: "t" }] }, engine);
	assert.deepEqual(mcp, [true, true, undefined]);
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

test("DelegationLedger key: ledgerV2 OFF (default) ⇒ role/tools/isolation differences don't change the key (regression pin)", () => {
	const ledger = new DelegationLedger();
	const base = { agent: "op", model: "m", task: "do X" };
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record({ ...base, role: "A", tools: ["grep"], isolation: "worktree" }, false);
	// A retry that changes ONLY role/tools/isolation is still vetoed — today's key is agent+model+task only.
	assert.match(
		ledger.vet([{ ...base, role: "B", tools: ["read"], isolation: "none" }]) ?? "",
		/already failed/,
		"same agent+model+task ⇒ same key regardless of role/tools/isolation",
	);
});

test("DelegationLedger key: ledgerV2 ON ⇒ role/tools/isolation differences produce a fresh key", () => {
	const ledger = new DelegationLedger({ ledgerV2: true });
	const base = { agent: "op", model: "m", task: "do X" };
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record({ ...base, role: "A", tools: ["grep"], isolation: "worktree" }, false);
	assert.equal(
		ledger.vet([{ ...base, role: "B", tools: ["read"], isolation: "none" }]),
		undefined,
		"a changed role/tools/isolation is a fresh attempt under ledgerV2 — the retry isn't vetoed",
	);
});

test("DelegationLedger key: ledgerV2 ON ⇒ tools order doesn't matter (stable-sorted before joining)", () => {
	const ledger = new DelegationLedger({ ledgerV2: true });
	const base = { agent: "op", model: "m", task: "do X" };
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record({ ...base, tools: ["b", "a"] }, false);
	assert.match(
		ledger.vet([{ ...base, tools: ["a", "b"] }]) ?? "",
		/already failed/,
		"same tools in a different order ⇒ same key (sorted before joining)",
	);
});

// I1 regression: under ledgerV2, the async fan-out's record() sites key from the NORMALIZED
// spec (post-specOf() — isolation "none" never survives, role is trimmed), while vet() keys
// from the RAW params the supervisor typed (isolation:"none" passed through, role untrimmed).
// If key() didn't normalize both sides identically, these two would silently diverge and the
// 2-strike veto would never fire for exactly this class of async delegation.
test("DelegationLedger key: ledgerV2 ON ⇒ isolation \"none\" (raw) keys the same as isolation-absent (normalized) — async record/vet mismatch regression (I1)", () => {
	const ledger = new DelegationLedger({ ledgerV2: true });
	const base = { agent: "op", model: "sonnet", task: "X" };
	// Simulates the async record() sites: a normalized spec never carries isolation:"none".
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record(base, false);
	// Simulates vet(): the raw params, where isolation:"none" is passed through as typed.
	assert.match(
		ledger.vet([{ ...base, isolation: "none" }]) ?? "",
		/already failed/,
		'a raw isolation:"none" must key identically to an absent/normalized isolation, or the veto silently never fires for this async delegation',
	);
});

test("DelegationLedger key: ledgerV2 ON ⇒ a whitespace-padded role (raw) keys the same as its trimmed form (normalized) — async record/vet mismatch regression (I1)", () => {
	const ledger = new DelegationLedger({ ledgerV2: true });
	const base = { agent: "op", model: "sonnet", task: "X" };
	// Simulates the async record() sites: specOf() trims role before it reaches the spec.
	for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) ledger.record({ ...base, role: "lens" }, false);
	// Simulates vet(): the raw params carry whatever whitespace the caller typed.
	assert.match(
		ledger.vet([{ ...base, role: "lens " }]) ?? "",
		/already failed/,
		"a whitespace-padded role must key identically to its trimmed form, or the veto silently never fires for this async delegation",
	);
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

test("runDelegate threads a per-task timeoutMs through to the engine spec (single-leg override, siblings untouched — the untouched sibling's key is genuinely absent)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine = engineThat((s) => {
		specs.push(s);
		return { agent: s.agent, output: "ok", usage: usage(), ok: true };
	});
	await runDelegate({ tasks: [{ agent: "operator", task: "t", timeoutMs: 5000 }, { agent: "scout", task: "t" }] }, engine);
	assert.equal(specs[0]?.timeoutMs, 5000);
	assert.ok(!("timeoutMs" in (specs[1] ?? {})), "the sibling with no override has NO timeoutMs key, not a present-undefined one");
});

test("runDelegate ignores a non-finite/non-positive timeoutMs (falls back to the engine default — the key is genuinely absent, not present-as-undefined)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine = engineThat((s) => {
		specs.push(s);
		return { agent: s.agent, output: "ok", usage: usage(), ok: true };
	});
	await runDelegate(
		{ tasks: [{ agent: "a", task: "t", timeoutMs: 0 }, { agent: "b", task: "t", timeoutMs: -5 }, { agent: "c", task: "t", timeoutMs: Number.NaN }] },
		engine,
	);
	assert.ok(specs.every((s) => !("timeoutMs" in s)), "junk timeoutMs never reaches the spec — the key itself is absent, not present-as-undefined");
});

test("runDelegate threads timeoutMs through to the engine spec in single mode too (valid carries; junk/absent falls back to a genuinely absent key)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine = engineThat((s) => {
		specs.push(s);
		return { agent: s.agent, output: "ok", usage: usage(), ok: true };
	});
	await runDelegate({ agent: "scout", task: "t", timeoutMs: 12_000 }, engine);
	await runDelegate({ agent: "scout", task: "t", timeoutMs: -1 }, engine);
	await runDelegate({ agent: "scout", task: "t" }, engine);
	assert.equal(specs[0]?.timeoutMs, 12_000, "a valid timeoutMs carries through");
	assert.ok(!("timeoutMs" in (specs[1] ?? {})), "a junk (-1) timeoutMs is genuinely absent, not present-as-undefined");
	assert.ok(!("timeoutMs" in (specs[2] ?? {})), "an omitted timeoutMs is genuinely absent");
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
	assert.equal(labelFor({ agent: "operator", model: "anthropic/claude-sonnet-4-6" }, 0), "orion · sonnet-4-6");
	assert.equal(labelFor({ agent: "scout", model: "x/y" }, 0), "scout · y", "a fixed agent keeps its own name");
	assert.equal(labelFor({ agent: "operator", name: "auditor", model: "p/claude-haiku" }, 3), "auditor · haiku");
});

test("runDelegate carries the display label in each view", async () => {
	const engine = engineThat((s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }));
	const r = await runDelegate({ tasks: [{ agent: "operator", task: "t", model: "anthropic/claude-sonnet-4-6" }] }, engine);
	assert.equal(r.views[0]?.label, "orion · sonnet-4-6");
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

test("unknownAgentError: all known → undefined", () => {
	assert.equal(unknownAgentError(["scout", "operator"], ["scout", "operator", "reviewer"]), undefined);
});

test("unknownAgentError: names the installed agents (self-correcting, deduped)", () => {
	const err = unknownAgentError(["scoutt", "scoutt"], ["scout", "operator"]);
	assert.ok(err);
	assert.match(err ?? "", /"scoutt"/);
	assert.equal((err ?? "").split("scoutt").length, 2, "duplicate unknown names are deduped");
	assert.match(err ?? "", /Installed agents: scout, operator/);
	assert.match(err ?? "", /nothing was spawned/i);
});

test("unknownAgentError: empty registry → fresh-install guidance (/persona seed)", () => {
	const err = unknownAgentError(["operator"], []);
	assert.match(err ?? "", /\/persona seed/);
	assert.match(err ?? "", /no sub-agents are installed/i);
});

test("unknownAgentError: caps the installed list at 16", () => {
	const installed = Array.from({ length: 20 }, (_, i) => `a${i}`);
	const err = unknownAgentError(["nope"], installed);
	assert.match(err ?? "", /, …/);
	assert.equal(/a19/.test(err ?? ""), false);
});

// wantsAsyncRun — the background-by-default launch decision (extension.ts execute + renderCall).
// The headline v1.5.0 behavior: a regression flipping headless→async (stranding results after
// `pi -p` exits) or interactive→sync must fail here, not slip through green.

test("wantsAsyncRun: interactive (hasUI) defaults to background, headless defaults to sync", () => {
	assert.equal(wantsAsyncRun({}, true), true, "interactive ⇒ background by default");
	assert.equal(wantsAsyncRun({}, false), false, "headless ⇒ sync (the single turn must carry the result)");
});

test("wantsAsyncRun: sync:true opts an interactive call out; explicit async always wins", () => {
	assert.equal(wantsAsyncRun({ sync: true }, true), false, "sync:true blocks even interactively");
	assert.equal(wantsAsyncRun({ async: true }, false), true, "explicit async overrides the headless default");
	assert.equal(wantsAsyncRun({ async: false }, true), false, "explicit async:false overrides the interactive default");
	assert.equal(wantsAsyncRun({ async: true, sync: true }, true), true, "async wins over sync when both are set");
});

test("wantsAsyncRun: renderCall passes hasUI:true (it only fires in a UI) — mirrors the execute default", () => {
	assert.equal(wantsAsyncRun({}, true), true, "a defaulted interactive call shows the async tag");
	assert.equal(wantsAsyncRun({ sync: true }, true), false, "sync:true drops the tag");
});

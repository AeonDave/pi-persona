/**
 * Task 5: the provider-fallback breadcrumb. `withModelFallback`'s `onFallback` hook (tested in
 * isolation in test/unit/engine/fallback.test.ts) must actually be wired through
 * `createBuildEngine` -> `wrapFallback`, not just exist on the type. This builds a REAL engine via
 * `createBuildEngine` (child branch, worktree/mcp/broker off) with a stubbed base engine so a
 * provider-kind failure on the first attempt reroutes through the outermost fallback decorator,
 * and asserts the reroute reaches the `BuildEngineDeps.onFallback` callback the extension supplies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBuildEngine, type BuildEngineDeps } from "../../../src/extension/engine.ts";
import { participantKey } from "../../../src/persona/model-participants.ts";
import type { EngineAdapterDeps } from "../../../src/engine/adapter.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const provider = (model: string): AgentResult => ({ agent: "a", output: "", usage: { input: 0, output: 0, turns: 0 } as never, ok: false, error: "503", failureKind: "provider", modelUsed: model });
const okResult = (model: string): AgentResult => ({ agent: "a", output: "done", usage: { input: 0, output: 0, turns: 0 } as never, ok: true, modelUsed: model });

test("a provider reroute reaches the onFallback breadcrumb the extension wires", async () => {
	const seen: Array<{ from: string; to: string; agent: string }> = [];
	const calls: string[] = [];
	const fakeEngine = { run: async (spec: { model?: string }) => { calls.push(spec.model ?? ""); return calls.length === 1 ? provider(spec.model ?? "") : okResult(spec.model ?? ""); } };
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "m" },
		modelRegistry: {
			getAll: () => [{ provider: "anthropic", id: "m" }, { provider: "amazon-bedrock", id: "m" }],
			getAvailable: () => [{ provider: "anthropic", id: "m" }, { provider: "amazon-bedrock", id: "m" }],
		},
		sessionManager: { getSessionId: () => "s1" },
	} as unknown as BuildEngineDeps["lastCtx"];
	const deps = (): BuildEngineDeps => ({
		agents: [{ name: "a", model: "anthropic/m", systemPrompt: "x", source: "t" } as never],
		contractDefs: {},
		controller: { activePersona: undefined, capabilities: undefined } as never,
		host: { getThinkingLevel: () => "high" } as never,
		config: { engine: "child", broker: false } as never,
		personaConfigs: {} as never,
		lastCtx: ctx,
		workerSpineText: "",
		engineFactories: { makeEngine: () => fakeEngine as never, makeInProcessEngine: () => fakeEngine as never },
		makeBrokerDeps: () => undefined as never,
		userAgentDir: () => process.cwd(),
		childPiSettingsEnv: () => ({}),
		runLimits: { timeoutMs: 1000 } as never,
		bus: {} as never,
		supervisorHandle: "supervisor",
		onFallback: (info) => seen.push(info),
	});
	const engine = createBuildEngine(deps)();
	const r = await engine.run({ agent: "a", task: "t", model: "m" });
	assert.equal(r.ok, true);
	// NOTE: the brief's sketch expected { from: "anthropic/m", to: "amazon-bedrock/m" }, reasoning
	// as if the FIRST attempt already ran under the qualified "anthropic/m" ref. It didn't: the top
	// -level spec.model is the unqualified "m" (it must stay unqualified — a "provider/id" pin
	// disables cross-provider fallback by default, see fallback.ts's providerPinned check), and this
	// test's stub base engine echoes spec.model straight back as modelUsed with no resolution, so
	// the first (failing) attempt's modelUsed is literally "m". `tried` therefore contains only "m",
	// not "anthropic/m" — so providerFallbacks (preferProvider "anthropic" sorts first) offers
	// "anthropic/m" as the first untried alternative, and the stub's second call succeeds
	// immediately. The real routing here is genuinely { from: "m", to: "anthropic/m" }; asserting
	// the brief's guessed pair would fail against the actual (correct) fallback logic.
	assert.deepEqual(seen, [{ from: "m", to: "anthropic/m", agent: "a" }]);
});

/** A strategy/flow engine built with `providerFallback: false` must hand back the RAW engine —
 *  the SDK's own main-model recovery is the first and only reroute there. An ordinary `delegate`
 *  engine (the default) keeps the strict provider fallback exactly as before. */
test("providerFallback:false disables the decorator, while the default still reroutes", async () => {
	const runs: Array<{ spec: { model?: string }; eng: "raw" | "wrapped" }> = [];
	// Fails on a model it has not seen yet, succeeds on a reroute to a different one — i.e. exactly
	// the shape a provider outage has, so the attempt COUNT is what distinguishes the two engines.
	const makeFake = (tag: "raw" | "wrapped") => {
		let first: string | undefined;
		return {
			run: async (spec: { model?: string }) => {
				runs.push({ spec, eng: tag });
				const model = spec.model ?? "";
				if (first === undefined) {
					first = model;
					return provider(model);
				}
				return model === first ? provider(model) : okResult(model);
			},
		};
	};
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "m" },
		modelRegistry: {
			getAll: () => [{ provider: "anthropic", id: "m" }, { provider: "amazon-bedrock", id: "m" }],
			getAvailable: () => [{ provider: "anthropic", id: "m" }, { provider: "amazon-bedrock", id: "m" }],
		},
		sessionManager: { getSessionId: () => "s1" },
	} as unknown as BuildEngineDeps["lastCtx"];
	const breadcrumb: Array<{ from: string; to: string }> = [];
	const deps = (): BuildEngineDeps => ({
		agents: [{ name: "a", model: "anthropic/m", systemPrompt: "x", source: "t" } as never],
		contractDefs: {},
		controller: { activePersona: undefined, capabilities: undefined } as never,
		host: { getThinkingLevel: () => "high" } as never,
		config: { engine: "child", broker: false } as never,
		personaConfigs: {} as never,
		lastCtx: ctx,
		workerSpineText: "",
		engineFactories: { makeEngine: () => makeFake("raw") as never, makeInProcessEngine: () => makeFake("raw") as never },
		makeBrokerDeps: () => undefined as never,
		userAgentDir: () => process.cwd(),
		childPiSettingsEnv: () => ({}),
		runLimits: { timeoutMs: 1000 } as never,
		bus: {} as never,
		supervisorHandle: "supervisor",
		onFallback: (info) => breadcrumb.push(info),
	});

	const strategy = createBuildEngine(deps)(undefined, undefined, { providerFallback: false });
	const raw = await strategy.run({ agent: "a", task: "t", model: "m" });
	assert.equal(raw.ok, false, "no reroute: the failure is the SDK's to recover");
	assert.equal(runs.length, 1);
	assert.deepEqual(breadcrumb, [], "a disabled fallback emits no breadcrumb either");

	const ordinary = createBuildEngine(deps)();
	const rerouted = await ordinary.run({ agent: "a", task: "t", model: "m" });
	assert.equal(rerouted.ok, true, "an ordinary delegate engine keeps provider fallback");
	assert.equal(runs.length, 3, "two more attempts (one reroute)");
});

/** The picker saves under the ROLE key (`agent#hash`); the engine must read the SAME key, else the
 *  choice never reaches the leg it was made for. The bare agent key stays the legacy fallback. */
test("modelFor resolves a role member's own assignment first, then the agent's legacy one", () => {
	const captured: EngineAdapterDeps[] = [];
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "anthropic", id: "m" },
		modelRegistry: { getAll: () => [{ provider: "anthropic", id: "m" }], getAvailable: () => [{ provider: "anthropic", id: "m" }] },
		sessionManager: { getSessionId: () => "s1" },
	} as unknown as BuildEngineDeps["lastCtx"];
	const persona = "magi";
	const deps = (): BuildEngineDeps => ({
		agents: [{ name: "reviewer", systemPrompt: "x", source: "t" } as never],
		contractDefs: {},
		controller: { activePersona: { name: persona }, capabilities: undefined } as never,
		host: { getThinkingLevel: () => "high" } as never,
		config: { engine: "child", broker: false } as never,
		personaConfigs: {
			magi: { models: { reviewer: "p/legacy", [`${participantKey("reviewer", "SECURITY")}`]: "p/security" } },
		} as never,
		lastCtx: ctx,
		workerSpineText: "",
		engineFactories: {
			makeEngine: (d: EngineAdapterDeps) => { captured.push(d); return { run: async () => okResult("") } as never; },
			makeInProcessEngine: () => ({ run: async () => okResult("") }) as never,
		},
		makeBrokerDeps: () => undefined as never,
		userAgentDir: () => process.cwd(),
		childPiSettingsEnv: () => ({}),
		runLimits: { timeoutMs: 1000 } as never,
		bus: {} as never,
		supervisorHandle: "supervisor",
	});
	createBuildEngine(deps)();
	const modelFor = captured[0]?.modelFor;
	assert.ok(modelFor, "the adapter deps carry a modelFor");
	assert.equal(modelFor("reviewer", "SECURITY"), "p/security", "the role's own assignment wins");
	assert.equal(modelFor("reviewer", "PERFORMANCE"), "p/legacy", "an unassigned role inherits the agent's");
	assert.equal(modelFor("reviewer"), "p/legacy", "a bare agent keeps the legacy key");
	assert.equal(modelFor("other"), undefined);
});

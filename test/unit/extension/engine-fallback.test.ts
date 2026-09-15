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

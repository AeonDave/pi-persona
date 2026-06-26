/**
 * Running the active persona's strategy — shared by the `/orchestrate` command
 * and the mandatory turn-interception (input hook). Testable: the engine is
 * injected, so no real `pi` spawn is needed to verify the wiring.
 */

import type { RunLimits } from "../core/capabilities.ts";
import { makeRoster } from "../orchestration/roster.ts";
import { type AgentStatus, makeSDK, type SDKDeps, type StrategyEngine, type StrategyInput } from "../orchestration/sdk.ts";
import { getStrategy } from "../orchestration/strategy.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { OrchestrationGrammar } from "./persona.ts";

/** The strategy a persona's grammar runs: explicit strategy, or `parallel` → fanout. */
export function resolveStrategyName(orch: OrchestrationGrammar): string | undefined {
	if (orch.strategy) return orch.strategy;
	if (orch.mode === "parallel") return "fanout";
	return undefined;
}

export interface RunStrategyDeps {
	engine: StrategyEngine;
	teams: Record<string, string[]>;
	limits: RunLimits;
	signal?: AbortSignal;
	log?: (message: string) => void;
	/** Per-agent lifecycle, for live UI (which roster agent is running/done + its result). */
	onAgentStatus?: (agent: string, status: AgentStatus, result?: AgentResult) => void;
}

/** Run the persona's strategy on a task, or return null if it has no runnable strategy. */
export async function runPersonaStrategy(
	orch: OrchestrationGrammar,
	task: string,
	deps: RunStrategyDeps,
): Promise<AgentResult | null> {
	const name = resolveStrategyName(orch);
	if (!name) return null;
	const strategy = getStrategy(name);
	if (!strategy) return null;

	const sdkDeps: SDKDeps = { engine: deps.engine, roster: makeRoster(deps.teams), limits: deps.limits };
	if (deps.signal) sdkDeps.signal = deps.signal;
	if (deps.log) sdkDeps.log = deps.log;
	if (deps.onAgentStatus) sdkDeps.onAgentStatus = deps.onAgentStatus;

	const input: StrategyInput = { task, params: orch.params ?? {} };
	if (orch.roster) input.roster = orch.roster;

	return strategy.run(input, makeSDK(sdkDeps));
}

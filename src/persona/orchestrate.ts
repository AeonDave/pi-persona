/**
 * Running the active persona's strategy — shared by the `/orchestrate` command
 * and the mandatory turn-interception (input hook). Testable: the engine is
 * injected, so no real `pi` spawn is needed to verify the wiring.
 */

import type { RunLimits } from "../core/capabilities.ts";
import { makeRoster, type RosterMember } from "../orchestration/roster.ts";
import {
	type AgentProgress,
	type AgentStatus,
	makeSDK,
	type SDKDeps,
	type SteerFn,
	type StrategyEngine,
	type StrategyInput,
} from "../orchestration/sdk.ts";
import { getStrategy, strategyNames } from "../orchestration/strategy.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { OrchestrationGrammar } from "./persona.ts";

/** The strategy a persona's grammar runs: explicit strategy, or `parallel` → fanout. */
export function resolveStrategyName(orch: OrchestrationGrammar): string | undefined {
	if (orch.strategy) return orch.strategy;
	if (orch.mode === "parallel") return "fanout";
	if (orch.mode === "pipeline") return "pipeline";
	return undefined;
}

export interface RunStrategyDeps {
	engine: StrategyEngine;
	teams: Record<string, RosterMember[]>;
	limits: RunLimits;
	signal?: AbortSignal;
	log?: (message: string) => void;
	/** Per-agent lifecycle, for live UI (which roster agent is running/done + its result).
	 *  `key` is a run-unique display id (disambiguates same-agent roster-role members). */
	onAgentStatus?: (agent: string, status: AgentStatus, result?: AgentResult, key?: string) => void;
	/** Per-agent streaming progress (rolling output), for live UI. */
	onAgentProgress?: (agent: string, progress: AgentProgress, key?: string) => void;
	/** Called as each agent starts with a handle to abort just that agent (UI stop). */
	onAgentStart?: (agent: string, abort: () => void, key?: string) => void;
	/** Called once an agent is live with a handle to steer it (in-process engine only). */
	onAgentSteerable?: (agent: string, steer: SteerFn, key?: string) => void;
}

/** Run the persona's strategy on a task, or return null if it has no runnable strategy. */
export async function runPersonaStrategy(
	orch: OrchestrationGrammar,
	task: string,
	deps: RunStrategyDeps,
): Promise<AgentResult | null> {
	const name = resolveStrategyName(orch);
	if (!name) return null; // no mode/strategy → nothing to run (e.g. a solo persona); caller runs normally
	const strategy = getStrategy(name);
	// A NAMED-but-unknown strategy is a misconfiguration, not "nothing to run" — fail loudly
	// so the council/flow surfaces it instead of an opaque "no ruling".
	if (!strategy) throw new Error(`unknown strategy "${name}" (available: ${strategyNames().join(", ")})`);

	const sdkDeps: SDKDeps = { engine: deps.engine, roster: makeRoster(deps.teams), limits: deps.limits };
	if (deps.signal) sdkDeps.signal = deps.signal;
	if (deps.log) sdkDeps.log = deps.log;
	if (deps.onAgentStatus) sdkDeps.onAgentStatus = deps.onAgentStatus;
	if (deps.onAgentProgress) sdkDeps.onAgentProgress = deps.onAgentProgress;
	if (deps.onAgentStart) sdkDeps.onAgentStart = deps.onAgentStart;
	if (deps.onAgentSteerable) sdkDeps.onAgentSteerable = deps.onAgentSteerable;

	const input: StrategyInput = { task, params: orch.params ?? {} };
	if (orch.roster) input.roster = orch.roster;

	return strategy.run(input, makeSDK(sdkDeps));
}

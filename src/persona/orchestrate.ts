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
	// A mode that names *what* to run without naming it is a misconfiguration, not "nothing to
	// run" — the persona's mandatory orchestration would otherwise silently never fire.
	if (orch.mode === "strategy") throw new Error('orchestration "mode: strategy" needs a "strategy:" name');
	if (orch.mode === "flow" && !orch.flow) throw new Error('orchestration "mode: flow" needs a "flow:" name');
	return undefined;
}

/** The reserved team key under which an EPHEMERAL `members:` list is registered for one run.
 *  A CLONE of the shared team map carries it, so no team file, discovery map, or later call
 *  ever sees it — the reserved key is a per-call implementation detail, not a team name. */
export const ADHOC_MEMBERS_KEY = "__adhoc_members__";

/**
 * The members a run actually uses: inline `orch.members` when present (they WIN the named
 * team — ephemeral, one call, nothing written back), else the named `orch.roster`'s members.
 * An unknown team name is a diagnostic naming the known teams, raised BEFORE any engine call.
 * No roster at all ⇒ `[]`; whether that is fatal is the strategy's own call.
 */
export function resolveOrchestrationMembers(
	orch: Pick<OrchestrationGrammar, "roster" | "members">,
	teams: Record<string, RosterMember[]>,
): RosterMember[] {
	if (orch.members && orch.members.length > 0) return orch.members;
	if (!orch.roster) return [];
	const members = teams[orch.roster];
	if (!members) {
		const known = Object.keys(teams).sort();
		throw new Error(`unknown roster "${orch.roster}" (${known.length > 0 ? `available teams: ${known.join(", ")}` : "no teams are defined"})`);
	}
	return members;
}

export interface RunStrategyDeps {
	engine: StrategyEngine;
	teams: Record<string, RosterMember[]>;
	limits: RunLimits;
	signal?: AbortSignal;
	/** The session's own model (`provider/id`) — a strategy's last-resort recovery model for a
	 *  member whose own model broke with no healthy peer to borrow from. */
	sessionModel?: string;
	/** The session model read AT USE TIME (the session can switch models mid-run), forwarded
	 *  beside the static `sessionModel` so a late leg still sees the current one. */
	getSessionModel?: () => string | undefined;
	/** A provider reroute was applied to one leg (the fallback layer's telemetry hook). */
	onModelFallback?: (info: { agent: string; from?: string; to: string; key: string }) => void;
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
	/** See `SDKDeps.canSpawn` — every strategy spawn, not only `delegate`. */
	canSpawn?: (agent: string) => boolean;
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

	// Ephemeral members ride a CLONE of the shared team map under a reserved key: the
	// strategies read members by team name, so this is the one seam that lets an ad-hoc
	// council run through the exact same path — without ever mutating `deps.teams`.
	// An unknown NAMED roster is still left to the strategy (which fails with its own
	// "a roster of … is required" before any engine call); only inline members change here.
	const adhocMembers = orch.members && orch.members.length > 0 ? orch.members : undefined;
	const teams = adhocMembers ? { ...deps.teams, [ADHOC_MEMBERS_KEY]: adhocMembers } : deps.teams;
	const sdkDeps: SDKDeps = { engine: deps.engine, roster: makeRoster(teams), limits: deps.limits };
	if (deps.signal) sdkDeps.signal = deps.signal;
	if (deps.sessionModel) sdkDeps.sessionModel = deps.sessionModel;
	if (deps.getSessionModel) sdkDeps.getSessionModel = deps.getSessionModel;
	if (deps.onModelFallback) sdkDeps.onModelFallback = deps.onModelFallback;
	if (deps.log) sdkDeps.log = deps.log;
	if (deps.onAgentStatus) sdkDeps.onAgentStatus = deps.onAgentStatus;
	if (deps.onAgentProgress) sdkDeps.onAgentProgress = deps.onAgentProgress;
	if (deps.onAgentStart) sdkDeps.onAgentStart = deps.onAgentStart;
	if (deps.onAgentSteerable) sdkDeps.onAgentSteerable = deps.onAgentSteerable;
	if (deps.canSpawn) sdkDeps.canSpawn = deps.canSpawn;

	const input: StrategyInput = { task, params: orch.params ?? {} };
	// Inline members win the named team for this call (`resolveOrchestrationMembers` is the
	// shared read path for callers that need the roster resolved up front — the tree seeding).
	if (adhocMembers) input.roster = ADHOC_MEMBERS_KEY;
	else if (orch.roster) input.roster = orch.roster;

	return strategy.run(input, makeSDK(sdkDeps));
}

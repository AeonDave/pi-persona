/**
 * The Strategy SDK — the constrained surface a strategy is given. Strategies
 * call only these primitives (the engine seam is injected), so they are
 * backend-agnostic and testable with a stub engine. Built-in strategies use the
 * exact same surface as future user-authored strategy files.
 */

import type { RunLimits } from "../core/capabilities.ts";
import { type JudgePrep, prepareJudge } from "./judge.ts";
import { mapWithConcurrency } from "./parallel.ts";
import { aggregateResults } from "./reducers.ts";
import { roleHint, type RosterMember } from "./roster.ts";
import type { AgentResult } from "./types.ts";
import { type ReducerResult, type VoteOpts, voteReduce } from "./voting.ts";

export interface AgentRunSpec {
	agent: string;
	task: string;
	model?: string;
	tools?: string[];
	/** Skills the sub-agent must load first (dynamic specialisation). */
	skills?: string[];
	/** Extra system-prompt text appended to the agent's own prompt — an on-the-fly
	 *  specialist persona. Prompt-level only; capabilities remain the enforced gate. */
	role?: string;
	outputContract?: string;
	/** Run this leg in an isolated git worktree (overrides the agent's own setting). */
	isolation?: "none" | "worktree";
	/** Opt this run into sibling messaging: the child gets a `contact_peer` tool (list/send,
	 *  ONE-WAY) scoped to the other peers-enabled members of the SAME engine run. Set by
	 *  strategies (e.g. `debate`). In-process engine only — the child engine ignores it;
	 *  gated at bind time by the persona's `canUseBus` capability. */
	peers?: boolean;
}

/** A live snapshot of an agent's progress (for streaming UI). */
export interface AgentProgress {
	/** The agent's rolling output so far. */
	output: string;
	/** Tokens consumed so far (best-effort). */
	tokens?: number;
	/** The tool the agent is currently running (e.g. "grep src/…"), if any. */
	activity?: string;
}

/** Inject a steering message into a running agent (in-process engine only). */
export type SteerFn = (text: string) => void;

/** The engine seam the SDK runs agents through (real child engine or a stub). */
export interface StrategyEngine {
	run(
		spec: AgentRunSpec,
		onProgress?: (progress: AgentProgress) => void,
		signal?: AbortSignal,
		/** Called once the agent is live with a handle to steer it (in-process only). */
		onSteerable?: (steer: SteerFn) => void,
	): Promise<AgentResult>;
}

export interface Roster {
	/** A team's ordered members — bare agent names, or inline `{ agent, role, … }`
	 *  specialisations (see roster.ts). Normalise each with `rosterSpec`. */
	team(name: string): RosterMember[];
}

export interface StrategySDK {
	agent(spec: AgentRunSpec): Promise<AgentResult>;
	parallel<T>(thunks: Array<() => Promise<T>>, opts?: { concurrency?: number }): Promise<T[]>;
	reduce: {
		aggregate(results: AgentResult[]): AgentResult;
		vote(candidates: AgentResult[], opts: VoteOpts): ReducerResult;
		/** Anonymise + label candidates for an impartial judge (run `agent(judge, …)` on
		 *  the returned ballot, then map the verdict via `pick`). */
		judge(candidates: AgentResult[], order?: number[]): JudgePrep;
	};
	roster: Roster;
	signal: AbortSignal | undefined;
	log(message: string): void;
	limits: RunLimits;
}

export interface StrategyInput {
	task: string;
	roster?: string;
	params: Record<string, unknown>;
}

/** A declared strategy param — name/type/default/doc, for discovery (`/doctor`) and the
 *  council tool's lenient unknown-key warning (I2: strategies are trusted project code —
 *  this schema documents and warns, it never validates or blocks a run). */
export interface StrategyParam {
	type: "string" | "number" | "boolean";
	default?: string | number | boolean;
	doc: string;
}

export interface Strategy {
	name: string;
	/** Declared, discoverable params (name → type/default/doc). Consumed by the council tool
	 *  (warn on unknown keys) and `/doctor`. A strategy with no params omits this. */
	params?: Record<string, StrategyParam>;
	run(input: StrategyInput, sdk: StrategySDK): Promise<AgentResult>;
}

export type AgentStatus = "running" | "done" | "failed";

export interface SDKDeps {
	engine: StrategyEngine;
	roster: Roster;
	limits: RunLimits;
	signal?: AbortSignal;
	log?: (message: string) => void;
	/** Per-agent lifecycle, for live UI. The result is passed on done/failed so the
	 *  UI can capture each agent's output/usage. `key` is a run-unique display id (the
	 *  `agent` name for a solo member, disambiguated by role/occurrence when the same agent
	 *  runs several times in one roster) — key the UI node by it, not by `agent`, or three
	 *  same-agent roster-role members collapse into one node. Falls back to `agent`. */
	onAgentStatus?: (agent: string, status: AgentStatus, result?: AgentResult, key?: string) => void;
	/** Per-agent streaming progress (rolling output), for live UI. See `onAgentStatus.key`. */
	onAgentProgress?: (agent: string, progress: AgentProgress, key?: string) => void;
	/** Called as each agent starts with a handle to abort just that agent (for UI stop). */
	onAgentStart?: (agent: string, abort: () => void, key?: string) => void;
	/** Called once an agent is live with a handle to steer it (in-process engine only). */
	onAgentSteerable?: (agent: string, steer: SteerFn, key?: string) => void;
}

export function makeSDK(deps: SDKDeps): StrategySDK {
	// Run-scoped enforcement of the declared limits — applied here so NO strategy can
	// exceed them, however it calls agent() (I2: safety from runtime limits, not isolation).
	let childrenSpawned = 0;
	let tokensSpent = 0;
	// Run-unique UI keys: the base is the agent name, or `agent · HINT` when the member
	// carries a role — so an ensemble of one agent under several roles shows as distinct
	// nodes. A `#N` suffix guards the degenerate case of an identical base twice. This
	// mirrors `rosterNodeKeys`, so the seeded "queued" nodes line up with the live ones.
	const uiSeen = new Map<string, number>();
	const uiKeyFor = (spec: AgentRunSpec): string => {
		const base = spec.role ? `${spec.agent} · ${roleHint(spec.role)}` : spec.agent;
		const n = (uiSeen.get(base) ?? 0) + 1;
		uiSeen.set(base, n);
		return n === 1 ? base : `${base}#${n}`;
	};

	return {
		agent: async (spec) => {
			if (childrenSpawned >= deps.limits.maxChildren) {
				throw new Error(`run exceeded maxChildren (${deps.limits.maxChildren})`);
			}
			if (deps.limits.budgetTokens > 0 && tokensSpent >= deps.limits.budgetTokens) {
				throw new Error(`run exceeded token budget (${deps.limits.budgetTokens})`);
			}
			childrenSpawned += 1;
			const key = uiKeyFor(spec);
			const ac = new AbortController();
			deps.onAgentStart?.(spec.agent, () => ac.abort(), key);
			deps.onAgentStatus?.(spec.agent, "running", undefined, key);
			const onProgress = deps.onAgentProgress;
			try {
				const result = await deps.engine.run(
					spec,
					onProgress ? (p) => onProgress(spec.agent, p, key) : undefined,
					ac.signal,
					deps.onAgentSteerable ? (steer) => deps.onAgentSteerable?.(spec.agent, steer, key) : undefined,
				);
				tokensSpent += result.usage.input + result.usage.output;
				deps.onAgentStatus?.(spec.agent, result.ok ? "done" : "failed", result, key);
				return result;
			} catch (err) {
				deps.onAgentStatus?.(spec.agent, "failed", undefined, key);
				throw err;
			}
		},
		parallel: (thunks, opts) =>
			mapWithConcurrency(thunks, opts?.concurrency ?? deps.limits.maxConcurrency, (thunk) => thunk()),
		reduce: { aggregate: aggregateResults, vote: voteReduce, judge: prepareJudge },
		roster: deps.roster,
		signal: deps.signal,
		log: deps.log ?? (() => {}),
		limits: deps.limits,
	};
}

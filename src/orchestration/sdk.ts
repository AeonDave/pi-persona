/**
 * The Strategy SDK — the constrained surface a strategy is given. Strategies
 * call only these primitives (the engine seam is injected), so they are
 * backend-agnostic and testable with a stub engine. Built-in strategies use the
 * exact same surface as future user-authored strategy files.
 */

import type { RunLimits } from "../core/capabilities.ts";
import { mapWithConcurrency } from "./parallel.ts";
import { aggregateResults } from "./reducers.ts";
import type { AgentResult } from "./types.ts";
import { type ReducerResult, type VoteOpts, voteReduce } from "./voting.ts";

export interface AgentRunSpec {
	agent: string;
	task: string;
	model?: string;
	tools?: string[];
	/** Skills the sub-agent must load first (dynamic specialisation). */
	skills?: string[];
	outputContract?: string;
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

/** The engine seam the SDK runs agents through (real child engine or a stub). */
export interface StrategyEngine {
	run(spec: AgentRunSpec, onProgress?: (progress: AgentProgress) => void, signal?: AbortSignal): Promise<AgentResult>;
}

export interface Roster {
	team(name: string): string[];
}

export interface StrategySDK {
	agent(spec: AgentRunSpec): Promise<AgentResult>;
	parallel<T>(thunks: Array<() => Promise<T>>, opts?: { concurrency?: number }): Promise<T[]>;
	reduce: {
		aggregate(results: AgentResult[]): AgentResult;
		vote(candidates: AgentResult[], opts: VoteOpts): ReducerResult;
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

export interface Strategy {
	name: string;
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
	 *  UI can capture each agent's output/usage. */
	onAgentStatus?: (agent: string, status: AgentStatus, result?: AgentResult) => void;
	/** Per-agent streaming progress (rolling output), for live UI. */
	onAgentProgress?: (agent: string, progress: AgentProgress) => void;
	/** Called as each agent starts with a handle to abort just that agent (for UI stop). */
	onAgentStart?: (agent: string, abort: () => void) => void;
}

export function makeSDK(deps: SDKDeps): StrategySDK {
	// Run-scoped enforcement of the declared limits — applied here so NO strategy can
	// exceed them, however it calls agent() (I2: safety from runtime limits, not isolation).
	let childrenSpawned = 0;
	let tokensSpent = 0;

	return {
		agent: async (spec) => {
			if (childrenSpawned >= deps.limits.maxChildren) {
				throw new Error(`run exceeded maxChildren (${deps.limits.maxChildren})`);
			}
			if (deps.limits.budgetTokens > 0 && tokensSpent >= deps.limits.budgetTokens) {
				throw new Error(`run exceeded token budget (${deps.limits.budgetTokens})`);
			}
			childrenSpawned += 1;
			const ac = new AbortController();
			deps.onAgentStart?.(spec.agent, () => ac.abort());
			deps.onAgentStatus?.(spec.agent, "running");
			const onProgress = deps.onAgentProgress;
			try {
				const result = await deps.engine.run(
					spec,
					onProgress ? (p) => onProgress(spec.agent, p) : undefined,
					ac.signal,
				);
				tokensSpent += result.usage.input + result.usage.output;
				deps.onAgentStatus?.(spec.agent, result.ok ? "done" : "failed", result);
				return result;
			} catch (err) {
				deps.onAgentStatus?.(spec.agent, "failed");
				throw err;
			}
		},
		parallel: (thunks, opts) =>
			mapWithConcurrency(thunks, opts?.concurrency ?? deps.limits.maxConcurrency, (thunk) => thunk()),
		reduce: { aggregate: aggregateResults, vote: voteReduce },
		roster: deps.roster,
		signal: deps.signal,
		log: deps.log ?? (() => {}),
		limits: deps.limits,
	};
}

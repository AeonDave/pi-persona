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

/** The engine seam the SDK runs agents through (real child engine or a stub). */
export interface StrategyEngine {
	run(spec: AgentRunSpec): Promise<AgentResult>;
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
	/** Per-agent lifecycle, for live UI (which agent is running/done). */
	onAgentStatus?: (agent: string, status: AgentStatus) => void;
}

export function makeSDK(deps: SDKDeps): StrategySDK {
	return {
		agent: async (spec) => {
			deps.onAgentStatus?.(spec.agent, "running");
			try {
				const result = await deps.engine.run(spec);
				deps.onAgentStatus?.(spec.agent, result.ok ? "done" : "failed");
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

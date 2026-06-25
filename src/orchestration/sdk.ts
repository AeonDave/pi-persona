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

export interface AgentRunSpec {
	agent: string;
	task: string;
	model?: string;
	tools?: string[];
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
	reduce: { aggregate(results: AgentResult[]): AgentResult };
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

export interface SDKDeps {
	engine: StrategyEngine;
	roster: Roster;
	limits: RunLimits;
	signal?: AbortSignal;
	log?: (message: string) => void;
}

export function makeSDK(deps: SDKDeps): StrategySDK {
	return {
		agent: (spec) => deps.engine.run(spec),
		parallel: (thunks, opts) =>
			mapWithConcurrency(thunks, opts?.concurrency ?? deps.limits.maxConcurrency, (thunk) => thunk()),
		reduce: { aggregate: aggregateResults },
		roster: deps.roster,
		signal: deps.signal,
		log: deps.log ?? (() => {}),
		limits: deps.limits,
	};
}

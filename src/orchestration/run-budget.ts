/**
 * One tool run's limit state — a council / `/orchestrate` / mandated-strategy run, or one flow
 * invocation across all its phases. Every SDK built for that run shares this object, so phases
 * running in parallel draw on one child count, one token total and one `maxConcurrency` gate.
 *
 * The token budget is an admission threshold on COMPLETED usage, not a prediction: a leg already
 * running finishes and is kept, so spend can pass the threshold by what those legs still consume.
 * A limit never throws and never cancels; a leg it refuses is reported by the SDK as that leg's
 * own `failureKind: "limit"` result.
 */

import type { RunLimits } from "../core/capabilities.ts";
import type { ChildUsage } from "../engine/stream.ts";
import { Semaphore } from "./parallel.ts";

export interface RunLimitStop {
	limit: "maxChildren" | "budgetTokens";
	error: string;
}

export interface RunBudget {
	/** The declared ceilings. */
	readonly limits: RunLimits;
	/** The one `maxConcurrency` gate for every leg of the run. */
	readonly slots: Semaphore;
	/** Logical legs and thunks waiting for a slot — the work an optional recovery must leave room for. */
	readonly queued: Set<symbol>;
	/** Check and take one child synchronously (that is what makes admission atomic); a stop names the limit. */
	admit(): RunLimitStop | undefined;
	charge(usage: ChildUsage): void;
	/** Why an optional model recovery must be skipped, or undefined when it fits; `admit()` then takes its child. */
	recoverySkip(reserve: number): string | undefined;
	/** Live headroom; `tokens` is `Infinity` when the run has no token budget. */
	readonly remaining: { children: number; tokens: number };
}

export function createRunBudget(limits: RunLimits): RunBudget {
	let children = 0;
	let tokens = 0;
	const queued = new Set<symbol>();
	const tokenBudgetSpent = (): boolean => limits.budgetTokens > 0 && tokens >= limits.budgetTokens;
	return {
		limits,
		slots: new Semaphore(limits.maxConcurrency),
		queued,
		admit() {
			if (children >= limits.maxChildren) {
				return { limit: "maxChildren", error: `the run's maxChildren limit (${limits.maxChildren}) is spent` };
			}
			if (tokenBudgetSpent()) {
				return { limit: "budgetTokens", error: `the run's token budget (${limits.budgetTokens}) is spent (${tokens} tokens used)` };
			}
			children += 1;
			return undefined;
		},
		charge(usage) {
			tokens += usage.input + usage.output;
		},
		recoverySkip(reserve) {
			const held = reserve + queued.size;
			if (children + held >= limits.maxChildren) {
				return `no child budget left to recover it (maxChildren ${limits.maxChildren}, ${held} reserved for remaining work)`;
			}
			if (tokenBudgetSpent()) return `token budget exhausted (${limits.budgetTokens})`;
			return undefined;
		},
		get remaining() {
			return {
				children: Math.max(0, limits.maxChildren - children),
				tokens: limits.budgetTokens > 0 ? Math.max(0, limits.budgetTokens - tokens) : Infinity,
			};
		},
	};
}

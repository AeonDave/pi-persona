/**
 * Main-only model retry policy — when a leg fails for a MODEL reason, which model should it be
 * re-run on? Exactly one: the session's own (main) model.
 *
 * That single candidate is a deliberate, user-authorised exception to the strict provider-pin rule
 * (`engine/fallback.ts` never crosses a pinned provider, and a strategy never picks another
 * provider's model): a previously chosen, persisted, or inline-pinned model can simply be
 * UNREACHABLE — retired ref, dead auth, vanished route — and the model the user is running right
 * now is the only one with live evidence behind it. Earlier this policy also preferred a healthy
 * PEER's model; that is gone. Borrowing one silently re-shaped the panel (breaking a council's
 * uncorrelated-error bias guard for `magi`/`judge`) and crossed somebody else's provider pin, so
 * recovery is now main-only and disclosed. The SDK applies it; this module is the pure policy.
 *
 * Pure — no engine, no I/O, no clock.
 */

import type { AgentResult, FailureKind, ModelRecovery } from "./types.ts";

/** The only failures a DIFFERENT model can fix. `provider` is the provider rejecting or breaking
 *  (auth, outage, 5xx, model-not-supported); `unknown-model` is a ref that does not resolve at all.
 *  Everything else — a user stop, an idle timeout, a contract violation, the agent's own error —
 *  reproduces identically on any model, so retrying only burns tokens. `abort` above all must never
 *  retry: a stop that silently respawned work would be a stop that does not stop. */
export const RETRYABLE_MODEL_FAILURES = ["provider", "unknown-model"] as const satisfies readonly FailureKind[];

const retryable = new Set<string>(RETRYABLE_MODEL_FAILURES);

/** A planned single recovery. `reason` is always `"session"`: there is no other source. */
export interface ModelRetry extends ModelRecovery {
	reason: "session";
}

export interface ModelRetryDeps {
	/** The model's `provider/id` — the run's MAIN model. */
	sessionModel?: string;
	/** The model this leg ASKED for (`spec.model`), which the engine may never have resolved. */
	requested?: string;
}

/**
 * Plan at most one recovery for one failed leg, or `null` when nothing is worth re-running:
 * the leg succeeded, the failure was not model-caused, no main model is known, or the main model is
 * the one that just failed (resolved OR requested) — re-running there is a second bill for an
 * identical outcome.
 */
export function planModelRecovery(result: AgentResult, deps: ModelRetryDeps): ModelRetry | null {
	if (result.ok || !result.failureKind || !retryable.has(result.failureKind)) return null;
	const main = deps.sessionModel?.trim();
	if (!main) return null;
	if (main === result.modelUsed || main === deps.requested) return null;
	return {
		...(result.modelUsed ? { from: result.modelUsed } : {}),
		to: main,
		reason: "session",
	};
}

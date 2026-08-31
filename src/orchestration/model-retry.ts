/**
 * Peer-model retry policy — when one council member fails for a MODEL reason, which model
 * should it be re-run on?
 *
 * This is the roster-level complement to `engine/fallback.ts`. That decorator reroutes the SAME
 * model id to a family-compatible provider (anthropic/x → bedrock/x) and knows nothing about the
 * other members; this decides to hand a broken core a DIFFERENT model that a sibling just proved
 * works in this very session. The two compose: the engine exhausts provider routes first, and only
 * a run that still comes back `provider`/`unknown-model` reaches here.
 *
 * The order of preference is evidence, strongest first:
 *   1. the session's own model, when a peer proved it — the user is running on it, so it is the
 *      most likely to be authed, in budget, and available;
 *   2. otherwise the first healthy peer's model in roster order (deterministic, not iteration order);
 *   3. otherwise the session model unproven — the case where the failing core is the first or the
 *      only one left, so no peer evidence exists at all.
 *
 * A council's whole value is UNCORRELATED errors from distinct reasoners, so this deliberately
 * never runs as a preference: it is what keeps a broken core from silently dropping out of the
 * vote, and callers are expected to surface it. Pure — no engine, no I/O, no clock.
 */

import type { AgentResult, FailureKind } from "./types.ts";

/** The only failures a DIFFERENT model can fix. `provider` is the provider rejecting or breaking
 *  (auth, outage, 5xx, model-not-supported); `unknown-model` is a ref that does not resolve at all.
 *  Everything else — a user stop, an idle timeout, a contract violation, the agent's own error —
 *  reproduces identically on any model, so retrying only burns tokens. `abort` above all must never
 *  retry: a stop that silently respawned work would be a stop that does not stop. */
export const RETRYABLE_MODEL_FAILURES = ["provider", "unknown-model"] as const satisfies readonly FailureKind[];

const retryable = new Set<string>(RETRYABLE_MODEL_FAILURES);

export interface ModelRetry {
	/** Position in the round's results, so the caller can re-run exactly this member. */
	index: number;
	agent: string;
	/** The model that just failed, when the engine resolved one. */
	from?: string;
	/** The model to re-run on — never the one that just failed. */
	model: string;
	/** Which evidence chose it, for an honest breadcrumb in the log and the tree. */
	reason: "peer" | "session";
}

export interface ModelRetryDeps {
	/** The model the user's own session runs on (`provider/id`), when known. */
	sessionModel?: string;
}

/**
 * Plan at most one retry per failed member. Returns an empty list when nothing is worth
 * re-running — no model-caused failure, or no model available that differs from the one that
 * already failed.
 */
export function planModelRetries(results: readonly AgentResult[], deps: ModelRetryDeps): ModelRetry[] {
	const healthy = results.filter((r) => r.ok && r.modelUsed).map((r) => r.modelUsed as string);
	const session = deps.sessionModel?.trim() || undefined;
	// A peer's model is evidence; the session model is evidence too when a peer used it, and a
	// reasonable guess when nothing survived to prove anything.
	const candidates = session && healthy.includes(session)
		? [session, ...healthy.filter((model) => model !== session)]
		: healthy.length > 0
			? healthy
			: session
				? [session]
				: [];

	const plan: ModelRetry[] = [];
	results.forEach((result, index) => {
		if (result.ok || !result.failureKind || !retryable.has(result.failureKind)) return;
		// Re-running on the model that just failed cannot produce a different outcome. Keep walking:
		// a later healthy peer may still provide a distinct model worth trying.
		const candidate = candidates.find((model) => model !== result.modelUsed);
		if (!candidate) return;
		plan.push({
			index,
			agent: result.agent,
			...(result.modelUsed ? { from: result.modelUsed } : {}),
			model: candidate,
			reason: healthy.includes(candidate) ? "peer" : "session",
		});
	});
	return plan;
}

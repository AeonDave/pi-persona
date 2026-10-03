/**
 * Orchestration-layer types shared by the SDK, strategies, and reducers.
 */

import type { ChildUsage } from "../engine/stream.ts";

export type { ChildUsage };

/** Machine-readable cause of an `ok:false` run — so callers can react by CAUSE, not by
 *  string-matching the error. Only `"provider"` (the model's provider rejected/broke:
 *  auth, outage, 5xx, model-not-supported) is retryable by switching provider; the rest
 *  are terminal for that model. `"verification"` is the one value that never appears on an
 *  `AgentResult` itself — it appears only on `map`'s per-item ledger entry (`ItemLedgerEntry`,
 *  `orchestration/reducers.ts`), where it means the worker LEG succeeded but a separate
 *  `params.verify` reviewer rejected that item's work after the fact. */
export type FailureKind = "provider" | "abort" | "timeout" | "contract" | "unknown-agent" | "unknown-model" | "agent" | "verification";

/**
 * This leg did NOT answer on the model it asked for: the SDK re-ran it once on the session's own
 * (main) model after a `provider`/`unknown-model` failure. Carried on the logical result so no
 * consumer — a strategy's ruling, the UI, the operator — can claim the initial model produced it.
 */
export interface ModelRecovery {
	/** The model that failed, when the engine resolved one. */
	from?: string;
	/** The main model the recovery ran on. */
	to: string;
}

/** The result of running one agent through the engine, as strategies see it. */
export interface AgentResult {
	agent: string;
	output: string;
	/** Validated structured fields (when the agent ran against a contract). */
	structured?: Record<string, unknown>;
	usage: ChildUsage;
	ok: boolean;
	error?: string;
	/** The canonical `provider/id` the run actually used (drives provider fallback + UI). */
	modelUsed?: string;
	/** Why it failed (set only when `ok` is false) — drives the model-fallback decision. */
	failureKind?: FailureKind;
	/** Set when this result comes from a recovered retry (see {@link ModelRecovery}). Its `usage`
	 *  already includes BOTH attempts, each counted once. */
	modelRecovery?: ModelRecovery;
}

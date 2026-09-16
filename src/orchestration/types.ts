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
}

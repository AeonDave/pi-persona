/**
 * Model provider-fallback decorator. Wraps a `StrategyEngine` so a run that fails with a
 * PROVIDER error (the model's provider rejected or broke — auth, outage, 5xx, model-not-
 * supported) may be retried on the SAME model id through a family-compatible provider route.
 * An unpinned selection may reroute when its provider fails at call time. A provider-qualified
 * `spec.model` is an explicit billing/provider pin and is strict by default; callers must opt it
 * into cross-provider recovery.
 *
 * Only `failureKind === "provider"` retries. abort / timeout / contract / unknown-agent /
 * unknown-model / agent failures pass straight through (a different provider can't fix
 * them). The abort signal is honoured between attempts, so a user stop ends the chain.
 *
 * Engine-agnostic and pure over its injected deps (the model list + preferred provider),
 * so it's testable with a stub engine and a fake registry — no live model.
 */

import type { ModelLite, ModelRoutingPolicy } from "../core/models.ts";
import { DEFAULT_MODEL_ROUTING_POLICY, providerFallbacks } from "../core/models.ts";
import { sumUsage } from "../orchestration/reducers.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import { resetFreshWorkerSession } from "./worker-session.ts";

export interface FallbackDeps {
	/** The authenticated model list to draw alternates from (NOT every registry model). */
	models: ModelLite[];
	/** The session/loader provider — tried first among alternates (most likely authed). */
	preferProvider?: string;
	/** Optional deployment policy for automatic fallback; safe first-party defaults otherwise. */
	routingPolicy?: ModelRoutingPolicy;
	/** Explicitly opt a provider-qualified model into cross-provider recovery. */
	allowCrossProviderFallback?: boolean;
	/** Notified on each reroute, for transparency: the extension wires this to a warning toast, not
	 *  a tree/log breadcrumb. */
	onFallback?: (info: { from: string; to: string; agent: string }) => void;
}

export function withModelFallback(engine: StrategyEngine, deps: FallbackDeps): StrategyEngine {
	return {
		async run(spec, onProgress, signal, onSteerable) {
			// A saved conversation has one writer and one provider. Never replay a failed turn
			// into the same transcript under another route.
			if (spec.session?.resume) return engine.run(spec, onProgress, signal, onSteerable);
			const tried = new Set<string>();
			let result = await engine.run(spec, onProgress, signal, onSteerable);
			if (result.modelUsed) tried.add(result.modelUsed);
			const providerPinned = spec.model?.includes("/") === true;
			const mayCrossProvider = !providerPinned || deps.allowCrossProviderFallback === true;
			while (mayCrossProvider && result.failureKind === "provider" && !result.worktreeRecovery && !signal?.aborted) {
				const from = result.modelUsed ?? spec.model;
				if (!from) break;
				const next = providerFallbacks(from, deps.models, deps.preferProvider, deps.routingPolicy ?? DEFAULT_MODEL_ROUTING_POLICY).find((r) => !tried.has(r));
				if (!next) break;
				if (spec.session && (result.sessionQuiescent !== true || !await resetFreshWorkerSession(spec.session))) break;
				if (signal?.aborted) break;
				tried.add(next);
				try {
					deps.onFallback?.({ from, to: next, agent: spec.agent });
				} catch {
					// Notification only: a broken toast cannot discard billed work or stop recovery.
				}
				const attempt: AgentRunSpec = { ...spec, model: next };
				const nextResult = await engine.run(attempt, onProgress, signal, onSteerable);
				// Every route is billable; only the final attempt supplies the outcome and live
				// context snapshot. Never mutate the engine-owned results while folding usage.
				result = { ...nextResult, usage: { ...sumUsage([result.usage, nextResult.usage]), contextTokens: nextResult.usage.contextTokens } };
				if (result.modelUsed) tried.add(result.modelUsed);
			}
			return result;
		},
	};
}

/**
 * Model provider-fallback decorator. Wraps a `StrategyEngine` so a run that fails with a
 * PROVIDER error (the model's provider rejected or broke — auth, outage, 5xx, model-not-
 * supported) is retried on the SAME model id under another authenticated provider, walking
 * the whole candidate chain until one responds or it's exhausted. This is the runtime half
 * of "priority to the supervisor's provider, but try others and switch on error": the
 * engine picks the intended model first; only when its provider *fails at call time* does
 * this reroute — silently and transparently (the working `modelUsed` shows in the tree).
 *
 * Only `failureKind === "provider"` retries. abort / timeout / contract / unknown-agent /
 * unknown-model / agent failures pass straight through (a different provider can't fix
 * them). The abort signal is honoured between attempts, so a user stop ends the chain.
 *
 * Engine-agnostic and pure over its injected deps (the model list + preferred provider),
 * so it's testable with a stub engine and a fake registry — no live model.
 */

import type { ModelLite } from "../core/models.ts";
import { providerFallbacks } from "../core/models.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";

export interface FallbackDeps {
	/** The authenticated model list to draw alternates from (NOT every registry model). */
	models: ModelLite[];
	/** The session/loader provider — tried first among alternates (most likely authed). */
	preferProvider?: string;
	/** Notified on each reroute, for transparency (a tree/log breadcrumb). */
	onFallback?: (info: { from: string; to: string; agent: string }) => void;
}

export function withModelFallback(engine: StrategyEngine, deps: FallbackDeps): StrategyEngine {
	return {
		async run(spec, onProgress, signal, onSteerable) {
			const tried = new Set<string>();
			let result = await engine.run(spec, onProgress, signal, onSteerable);
			if (result.modelUsed) tried.add(result.modelUsed);
			while (result.failureKind === "provider" && !signal?.aborted) {
				const from = result.modelUsed ?? spec.model;
				if (!from) break;
				const next = providerFallbacks(from, deps.models, deps.preferProvider).find((r) => !tried.has(r));
				if (!next) break;
				tried.add(next);
				deps.onFallback?.({ from, to: next, agent: spec.agent });
				const attempt: AgentRunSpec = { ...spec, model: next };
				result = await engine.run(attempt, onProgress, signal, onSteerable);
				if (result.modelUsed) tried.add(result.modelUsed);
			}
			return result;
		},
	};
}

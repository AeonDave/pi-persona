/**
 * Engine adapter — bridges the Strategy SDK's `StrategyEngine` seam to the real
 * ChildProcessEngine. Resolves an agent name to its config (model/tools/prompt),
 * runs the child, and (when a contract is requested) validates the structured
 * output, attaching it or failing the result.
 */

import type { AgentConfig } from "../agents/agent.ts";
import { type ContractDef, parseAndValidate, pinContract, type PinnedContract } from "../core/contract.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { type ChildEngineOptions, type ChildRunSpec, runChildAgent } from "./child.ts";
import { combineSignals } from "./signals.ts";
import { emptyUsage } from "./stream.ts";

export interface EngineAdapterDeps {
	resolveAgent: (name: string) => AgentConfig | undefined;
	contracts?: (name: string) => ContractDef | undefined;
	signal?: AbortSignal;
	/** Per-agent model override (e.g. a persona's configured ensemble models).
	 *  Precedence: explicit spec.model > modelFor(agent) > the agent's own default. */
	modelFor?: (agent: string) => string | undefined;
	/** Explicit thinking level appended to the child model (`model:level`) so it can't
	 *  fall into a model's default "adaptive" mode, which some models reject. */
	childThinking?: string;
	/** Forwarded to the child engine (e.g. a test invocation resolver). */
	childOptions?: ChildEngineOptions;
	cwd?: string;
}

export function makeEngine(deps: EngineAdapterDeps): StrategyEngine {
	// Per-run contract pinning (I3): an engine instance is created per run, so the first
	// time a contract is used we pin `name@hash` and reuse that frozen snapshot for the
	// rest of the run — hot-reloading a contract file can't change an in-flight run.
	const pinned = new Map<string, PinnedContract>();
	const pinnedDef = (name: string): ContractDef | undefined => {
		const cached = pinned.get(name);
		if (cached) return cached.def;
		const def = deps.contracts?.(name);
		if (!def) return undefined;
		const fresh = pinContract(def);
		pinned.set(name, fresh);
		return fresh.def;
	};

	return {
		async run(
			spec: AgentRunSpec,
			onProgress?: (p: { output: string; tokens?: number; activity?: string }) => void,
			callSignal?: AbortSignal,
		): Promise<AgentResult> {
			const cfg = deps.resolveAgent(spec.agent);
			if (!cfg) {
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `[${spec.agent}] unknown agent (not found in registry)`, failureKind: "unknown-agent" };
			}

			const task =
				spec.skills && spec.skills.length > 0
					? `Load these skills before starting (use the nearest affine if one is missing): ${spec.skills.join(", ")}.\n\n${spec.task}`
					: spec.task;
			const childSpec: ChildRunSpec = { task };
			let model = spec.model ?? deps.modelFor?.(spec.agent) ?? cfg.model;
			// Append an explicit thinking level (model:level) unless one is already present —
			// a child without it defaults to "adaptive", which some models reject.
			if (model && deps.childThinking && !model.includes(":")) model = `${model}:${deps.childThinking}`;
			if (model) childSpec.model = model;
			const tools = spec.tools ?? cfg.tools;
			if (tools) childSpec.tools = tools;
			// The agent's own persona + any on-the-fly `role` specialisation from the spec.
			const personaPrompt = [cfg.systemPrompt?.trim(), spec.role?.trim()].filter(Boolean).join("\n\n");
			if (personaPrompt) childSpec.systemPrompt = personaPrompt;
			if (deps.cwd) childSpec.cwd = deps.cwd;

			const childOptions: ChildEngineOptions = { ...deps.childOptions };
			if (onProgress) {
				childOptions.onProgress = (snap) =>
					onProgress({ output: snap.output, tokens: snap.tokens, ...(snap.activity ? { activity: snap.activity } : {}) });
			}
			// The run aborts if EITHER the whole-run signal or this agent's own (UI stop) fires.
			const signal = combineSignals(deps.signal, callSignal);
			const child = await runChildAgent(childSpec, signal, childOptions);

			const result: AgentResult = { agent: spec.agent, output: child.output, usage: child.usage, ok: child.ok };
			// The provider/id the child ran on (drop any `:thinking` suffix) — for the UI and
			// as the seed of the provider-fallback chain on a provider failure.
			const modelUsed = (childSpec.model ?? spec.model ?? cfg.model)?.split(":")[0];
			if (modelUsed) result.modelUsed = modelUsed;
			// Diagnostic tag: agent · model ref · dynamic overrides. Same shape as inproc engine,
			// so failed follow-ups always say WHICH agent+model died and WHY.
			const overrides: string[] = [];
			if (spec.model) overrides.push("model");
			if (spec.skills && spec.skills.length > 0) overrides.push("skills");
			if (spec.tools && spec.tools.length > 0) overrides.push("tools");
			const dyn = overrides.length > 0 ? ` +dyn(${overrides.join(",")})` : "";
			const modelRef = childSpec.model ?? "(no model)";
			const tag = `[${spec.agent} · ${modelRef}${dyn}]`;
			if (child.errorMessage) result.error = `${tag} ${child.errorMessage}`;
			else if (!child.ok) result.error = `${tag} ${child.stderr.trim() || `agent failed (exit ${child.exitCode})`}`;

			// Classify the failure so the fallback decorator reroutes ONLY provider errors
			// (a stream `error`), never an abort/timeout/spawn-miss/agent failure.
			if (!child.ok) result.failureKind = child.timedOut ? "timeout" : child.aborted ? "abort" : child.stopReason === "error" ? "provider" : "agent";

			if (spec.outputContract && deps.contracts) {
				const def = pinnedDef(spec.outputContract);
				if (def) {
					// Shared parse+validate (unwraps ```json fences / prose first) — a member's
					// fenced output must not void its structured result.
					const v = parseAndValidate(child.output, def);
					if (v.value) result.structured = v.value;
					if (!v.ok) {
						result.ok = false;
						if (v.error) result.error = v.error;
						if (result.failureKind === undefined) result.failureKind = "contract";
					}
				}
			}

			return result;
		},
	};
}

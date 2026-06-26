/**
 * Engine adapter — bridges the Strategy SDK's `StrategyEngine` seam to the real
 * ChildProcessEngine. Resolves an agent name to its config (model/tools/prompt),
 * runs the child, and (when a contract is requested) validates the structured
 * output, attaching it or failing the result.
 */

import type { AgentConfig } from "../agents/agent.ts";
import { type ContractDef, extractJsonCandidate, pinContract, type PinnedContract, validateAgainst, type ValidationResult } from "../core/contract.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { type ChildEngineOptions, type ChildRunSpec, runChildAgent } from "./child.ts";
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

/** One signal that fires when any of the given signals fires (ignores undefined). */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return undefined;
	if (live.length === 1) return live[0];
	return AbortSignal.any(live);
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
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `unknown agent: ${spec.agent}` };
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
			if (cfg.systemPrompt) childSpec.systemPrompt = cfg.systemPrompt;
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
			if (child.errorMessage) result.error = child.errorMessage;
			else if (!child.ok) result.error = child.stderr.trim() || `agent failed (exit ${child.exitCode})`;

			if (spec.outputContract && deps.contracts) {
				const def = pinnedDef(spec.outputContract);
				if (def) {
					let parsed: unknown;
					try {
						// Strip ```json fences / surrounding prose first — models routinely wrap
						// structured output, and a raw parse would fail every fenced member's vote.
						parsed = JSON.parse(extractJsonCandidate(child.output));
					} catch {
						parsed = undefined;
					}
					const v: ValidationResult =
						parsed === undefined ? { ok: false, errors: ["output was not valid JSON"] } : validateAgainst(def, parsed);
					if (v.ok && v.value) {
						result.structured = v.value;
					} else {
						result.ok = false;
						result.error = `contract ${spec.outputContract} failed: ${v.errors.join("; ")}`;
					}
				}
			}

			return result;
		},
	};
}

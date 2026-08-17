/**
 * Persona definition + parsing — the supervisor identity and its orchestration
 * grammar. Pure module (uses only the core helpers, no Pi imports).
 *
 * A persona file is Markdown: YAML-subset frontmatter + a body (the supervisor
 * system prompt). `persona: true` marks it switchable. The optional
 * `orchestration:` block is the control surface; absent ⇒ L0 (opportunistic).
 */

import { asBoolean, asPermission, asStringArray, parseYamlSubset, splitFrontmatter } from "../core/frontmatter.ts";
import type { Permission } from "../core/permissions.ts";
import { asSystemPromptMode, type SystemPromptMode } from "../core/types.ts";

export type OrchestrationMode = "solo" | "parallel" | "pipeline" | "strategy" | "flow";
const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ["solo", "parallel", "pipeline", "strategy", "flow"];

/** The declarative orchestration grammar carried by a persona (§4.2 of the spec). */
export interface OrchestrationGrammar {
	mode: OrchestrationMode;
	strategy?: string;
	flow?: string;
	roster?: string;
	/** Strategy parameters (e.g. rounds, aggregate, critic). */
	params?: Record<string, unknown>;
}

/**
 * A tool-driven council: which strategy + roster + params the `council` tool runs
 * on demand. Unlike `orchestration` it does NOT trigger the mandatory input-hook —
 * the supervisor calls the council, then executes the ruling. Fully data-driven: a
 * new ensemble (more members, a different vote, a multi-round strategy) is just a
 * new team + (optional) strategy + a persona declaring them here.
 */
export interface CouncilSpec {
	strategy: string;
	roster?: string;
	params?: Record<string, unknown>;
}

/** A council block as authored — `strategy` may be supplied by a `preset` (expanded at load). */
export interface CouncilDraft {
	strategy?: string;
	roster?: string;
	params?: Record<string, unknown>;
	/** A named preset (presets/<name>.preset.json) providing defaults; authored fields override. */
	preset?: string;
}

/** Optional, fully data-driven runtime discipline for any persona. No persona name has special
 * behavior: a project/user persona opts into the same packet, contract, and write-set gates by
 * declaring this block in frontmatter. */
export interface DelegationPolicy {
	/** Require every delegate leg to carry the complete structured `brief`. */
	requireBrief?: boolean;
	/** Default output contract applied to delegate legs that omit one. */
	outputContract?: string;
	/** Require ownership declarations for parallel writers and reject overlapping paths. */
	requireDisjointWrites?: boolean;
	/** Require declared verifier agents to start after, not concurrently with, a mutation. */
	requireFreshVerification?: boolean;
	/** Agents treated as verifiers for the runtime stale-verification concurrency gate. */
	verificationAgents?: string[];
}

export interface Persona {
	name: string;
	label: string;
	/** `persona: true` marks a file as a switchable supervisor persona. */
	isPersona: boolean;
	description?: string;
	model?: string;
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	delegate?: Permission;
	tools?: Permission;
	/** Absent ⇒ L0 opportunistic delegation. */
	orchestration?: OrchestrationGrammar;
	/** Tool-driven council the `council` tool runs (no mandatory firing). After load, any
	 *  `preset` is expanded so `strategy`/`roster`/`params` are concrete. */
	council?: CouncilDraft;
	/** Optional delegation runtime/brief policy; usable by any custom persona. */
	delegation?: DelegationPolicy;
	/** Opt into the comm plane: give async children a `contact_supervisor` tool (§4.9). */
	coaching?: boolean;
	/** `spine: false` opts this persona out of the shared behavioral layer (docs/SPINE.md) —
	 *  for short verdict personas that do not need the baseline. Only an explicit false is
	 *  recorded; absent ⇒ the session-level setting decides. */
	spine?: boolean;
	/** The Markdown body — the supervisor system prompt. */
	body: string;
	/** Where it was loaded from (for diagnostics / `/doctor`). */
	source: string;
}

function parseOrchestration(raw: unknown): OrchestrationGrammar | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const mode: OrchestrationMode =
		typeof o.mode === "string" && (ORCHESTRATION_MODES as readonly string[]).includes(o.mode)
			? (o.mode as OrchestrationMode)
			: "solo";
	const grammar: OrchestrationGrammar = { mode };
	if (typeof o.strategy === "string" && o.strategy.trim()) grammar.strategy = o.strategy.trim();
	if (typeof o.flow === "string" && o.flow.trim()) grammar.flow = o.flow.trim();
	if (typeof o.roster === "string" && o.roster.trim()) grammar.roster = o.roster.trim();
	if (o.params && typeof o.params === "object" && !Array.isArray(o.params)) {
		grammar.params = o.params as Record<string, unknown>;
	}
	return grammar;
}

/**
 * Parse a persona file. Returns `null` when `name` is missing (required).
 * `systemPromptMode` defaults to `append` (a persona augments Pi's base prompt).
 */
export function parsePersona(content: string, source: string): Persona | null {
	const { frontmatter, body } = splitFrontmatter(content);
	const fm = parseYamlSubset(frontmatter);
	const name = typeof fm.name === "string" ? fm.name.trim() : "";
	if (!name) return null;

	const label = typeof fm.label === "string" && fm.label.trim() ? fm.label : name;
	const persona: Persona = {
		name,
		label,
		isPersona: fm.persona === true,
		systemPromptMode: asSystemPromptMode(fm.systemPromptMode, "append"),
		body,
		source,
	};
	if (typeof fm.description === "string" && fm.description.trim()) persona.description = fm.description.trim();
	if (typeof fm.model === "string" && fm.model.trim()) persona.model = fm.model.trim();
	if (typeof fm.thinking === "string" && fm.thinking.trim()) persona.thinking = fm.thinking.trim();

	const delegate = asPermission(fm.delegate);
	if (delegate) persona.delegate = delegate;
	const tools = asPermission(fm.tools);
	if (tools) persona.tools = tools;

	const orchestration = parseOrchestration(fm.orchestration);
	if (orchestration) persona.orchestration = orchestration;
	const council = parseCouncil(fm.council);
	if (council) persona.council = council;
	const delegation = parseDelegationPolicy(fm.delegation);
	if (delegation) persona.delegation = delegation;
	if (asBoolean(fm.coaching) === true) persona.coaching = true;
	if (asBoolean(fm.spine) === false) persona.spine = false;

	return persona;
}

function parseDelegationPolicy(value: unknown): DelegationPolicy | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const policy: DelegationPolicy = {};
	const requireBrief = asBoolean(o.requireBrief);
	if (requireBrief !== undefined) policy.requireBrief = requireBrief;
	const requireDisjointWrites = asBoolean(o.requireDisjointWrites);
	if (requireDisjointWrites !== undefined) policy.requireDisjointWrites = requireDisjointWrites;
	const requireFreshVerification = asBoolean(o.requireFreshVerification);
	if (requireFreshVerification !== undefined) policy.requireFreshVerification = requireFreshVerification;
	const verificationAgents = asStringArray(o.verificationAgents);
	if (verificationAgents) policy.verificationAgents = verificationAgents;
	if (typeof o.outputContract === "string" && o.outputContract.trim()) policy.outputContract = o.outputContract.trim();
	return Object.keys(policy).length > 0 ? policy : undefined;
}

/** Parse a persona's `council:` block (strategy + roster + params, or just a `preset`). */
function parseCouncil(value: unknown): CouncilDraft | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const strategy = typeof o.strategy === "string" && o.strategy.trim() ? o.strategy.trim() : "";
	const preset = typeof o.preset === "string" && o.preset.trim() ? o.preset.trim() : "";
	if (!strategy && !preset) return undefined; // a council needs at least a strategy or a preset
	const spec: CouncilDraft = {};
	if (strategy) spec.strategy = strategy;
	if (preset) spec.preset = preset;
	if (typeof o.roster === "string" && o.roster.trim()) spec.roster = o.roster.trim();
	if (o.params && typeof o.params === "object" && !Array.isArray(o.params)) {
		spec.params = o.params as Record<string, unknown>;
	}
	return spec;
}

/** Expand a council `preset` (presets/<name>.preset.json) into concrete fields: the preset
 *  supplies defaults, authored fields win, and `params` shallow-merge (authored over preset).
 *  The `preset` key is consumed. An unknown preset just drops the key (authored fields kept). */
export function expandCouncilPreset(draft: CouncilDraft, presets: Record<string, Partial<CouncilSpec>>): CouncilDraft {
	if (!draft.preset) return draft;
	const base = presets[draft.preset];
	const { preset: _consumed, ...authored } = draft;
	if (!base) return authored;
	const merged: CouncilDraft = { ...base, ...authored };
	if (base.params || authored.params) merged.params = { ...base.params, ...authored.params };
	return merged;
}

/** Per-call council selection. `persona` borrows only that persona's expanded
 * council declaration; it never activates the persona or imports its prompt,
 * model, tools, or permissions. Explicit strategy/roster/params remain local
 * overrides for backward compatibility. */
export interface CouncilInvocation {
	persona?: string | undefined;
	strategy?: string | undefined;
	roster?: string | undefined;
	params?: Record<string, unknown> | undefined;
}

export interface ResolvedCouncilInvocation {
	strategy: string;
	roster: string;
	params: Record<string, unknown>;
	/** Persona whose council declaration supplied the defaults, when any. */
	persona?: string;
}

export type CouncilInvocationResolution =
	| { ok: true; value: ResolvedCouncilInvocation }
	| { ok: false; error: string };

/** Resolve a council call without mutating the active persona.
 *
 * An explicit persona is intentionally strict: it must exist and declare a
 * usable council. Silently falling back to MAGI would make `persona: "solo"`
 * look authoritative while actually running an unrelated ensemble.
 */
export function resolveCouncilInvocation(
	personas: readonly Persona[],
	activePersona: Persona | undefined,
	request: CouncilInvocation,
): CouncilInvocationResolution {
	const requestedName = request.persona?.trim();
	let sourcePersona: Persona | undefined;

	if (requestedName) {
		sourcePersona = personas.find((persona) => persona.isPersona && persona.name === requestedName);
		if (!sourcePersona) {
			const available = personas
				.filter((persona) => persona.isPersona && Boolean(persona.council?.strategy))
				.map((persona) => persona.name)
				.sort();
			return {
				ok: false,
				error: `no persona named "${requestedName}". Council personas: ${available.join(", ") || "(none)"}`,
			};
		}
		if (!sourcePersona.council?.strategy) {
			return {
				ok: false,
				error: `persona "${requestedName}" declares no usable council`,
			};
		}
	} else if (activePersona?.council?.strategy) {
		sourcePersona = activePersona;
	}

	const base = sourcePersona?.council;
	const strategy = request.strategy?.trim() || base?.strategy || "magi";
	const roster =
		request.roster?.trim() ||
		base?.roster ||
		sourcePersona?.orchestration?.roster ||
		(!requestedName ? activePersona?.orchestration?.roster : undefined) ||
		"magi";
	const value: ResolvedCouncilInvocation = {
		strategy,
		roster,
		params: { ...(base?.params ?? {}), ...(request.params ?? {}) },
	};
	if (sourcePersona) value.persona = sourcePersona.name;
	return { ok: true, value };
}

/** Compose the turn's system prompt from the base prompt, the spine, and a persona.
 *  The spine is the shared behavioral layer (docs/SPINE.md); absent/empty — the default —
 *  leaves the composition byte-identical to the pre-spine one. */
export function composeSystemPrompt(base: string, persona: Persona, spine?: string): string {
	const layer = persona.spine === false ? "" : (spine ?? "").trim();
	// No layer (the default, and `spine: false`) ⇒ the pre-spine composition, byte for byte.
	// The `replace` test HAS to come first here, exactly as it did pre-spine: a replace persona
	// with an empty body yielded an empty prompt, and quietly promoting that to Pi's base prompt
	// would be a behavior change on the OFF path — which docs/SPINE.md promises there isn't one.
	if (!layer) {
		if (persona.systemPromptMode === "replace") return persona.body;
		if (!persona.body.trim()) return base;
		return `${base}\n\n${persona.body}`;
	}
	// An empty body has nothing to append — and nothing to replace with: the turn keeps Pi's
	// base prompt, lifted by the spine exactly like a persona-less turn.
	if (!persona.body.trim()) return `${base}\n\n${layer}`;
	// `replace` drops Pi's base, so the spine becomes the only scaffolding that persona gets.
	const head = persona.systemPromptMode === "replace" ? layer : `${base}\n\n${layer}`;
	return `${head}\n\n${persona.body}`;
}

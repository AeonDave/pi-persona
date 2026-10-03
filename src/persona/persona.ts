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
import { parseRuntimeRosterMember, type RosterMember } from "../orchestration/roster.ts";

export type OrchestrationMode = "solo" | "parallel" | "pipeline" | "strategy" | "flow";
const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ["solo", "parallel", "pipeline", "strategy", "flow"];

/** The declarative orchestration grammar carried by a persona (§4.2 of the spec). */
export interface OrchestrationGrammar {
	mode: OrchestrationMode;
	strategy?: string;
	flow?: string;
	roster?: string;
	/** Ephemeral members for THIS run — validated inline specialisations that win `roster`
	 *  (see `resolveOrchestrationMembers`). Never written back to a team or persona file. */
	members?: RosterMember[];
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
	/** Ephemeral members declared inline (bare agent names or `{ agent, … }` maps), validated
	 *  at parse. They win `roster` for the calls this persona convenes. */
	members?: RosterMember[];
	/** Set when a `members:` block was AUTHORED but unusable (not a list, empty, or an entry
	 *  that is not a member). Kept as a diagnostic so the call fails loudly instead of
	 *  quietly convening some other roster. */
	membersProblem?: string;
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

/** Parse a persona's `council:` block (strategy + roster + members + params, or just a `preset`). */
function parseCouncil(value: unknown): CouncilDraft | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const strategy = typeof o.strategy === "string" && o.strategy.trim() ? o.strategy.trim() : "";
	const preset = typeof o.preset === "string" && o.preset.trim() ? o.preset.trim() : "";
	// Validate `members:` BEFORE the a-council-needs-a-strategy gate: a members-only block
	// with a broken list is a broken declaration, and returning undefined here would drop the
	// diagnostic and let the call quietly convene the MAGI fallback instead.
	const parsedMembers = Object.hasOwn(o, "members") ? parseMembersBlock(o.members) : undefined;
	if (!strategy && !preset && !parsedMembers) return undefined;
	const spec: CouncilDraft = {};
	if (strategy) spec.strategy = strategy;
	if (preset) spec.preset = preset;
	if (typeof o.roster === "string" && o.roster.trim()) spec.roster = o.roster.trim();
	if (parsedMembers) {
		if (parsedMembers.ok) spec.members = parsedMembers.members;
		else spec.membersProblem = parsedMembers.error;
	}
	if (o.params && typeof o.params === "object" && !Array.isArray(o.params)) {
		spec.params = o.params as Record<string, unknown>;
	}
	return spec;
}

/**
 * Validate an authored `members:` block into roster members. A block that was explicitly
 * supplied but is not a usable list is an ERROR, never a silent absence: dropping it would
 * fall back to the persona's named team (or MAGI) and present an unrelated ensemble as the
 * one the author asked for. Members are validated with the STRICT runtime parser, so a
 * malformed specialisation field (`tools: ["read", 42]`, `model: 42`) is a diagnostic rather
 * than a silently dropped field that widens or narrows what the leg may do.
 */
export function parseMembersBlock(value: unknown): { ok: true; members: RosterMember[] } | { ok: false; error: string } {
	if (!Array.isArray(value)) return { ok: false, error: "council.members must be a list of agent names or { agent, … } members" };
	if (value.length === 0) return { ok: false, error: "council.members is empty — declare at least one member or drop the key" };
	const members: RosterMember[] = [];
	for (const [i, raw] of value.entries()) {
		const parsed = parseRuntimeRosterMember(raw);
		if (!parsed.ok) return { ok: false, error: `council.members[${i}]: ${parsed.error}` };
		members.push(parsed.member);
	}
	return { ok: true, members };
}

/** Expand a council `preset` (presets/<name>.preset.json) into concrete fields: the preset
 *  supplies defaults, authored fields win, and `params` shallow-merge (authored over preset).
 *  The `preset` key is consumed. An unknown preset just drops the key (authored fields kept). */
export function expandCouncilPreset(draft: CouncilDraft, presets: Record<string, Partial<CouncilSpec>>): CouncilDraft {
	if (!draft.preset) return draft;
	const base = presets[draft.preset];
	const { preset: _consumed, ...authored } = draft;
	if (!base) return authored;
	// Presets only declare strategy, roster, and params. Copy that allowlist instead of
	// spreading a runtime object, so an extra `members` key cannot bypass parseMembersBlock.
	const defaults: CouncilDraft = {};
	if (typeof base.strategy === "string" && base.strategy.trim()) defaults.strategy = base.strategy.trim();
	if (typeof base.roster === "string" && base.roster.trim()) defaults.roster = base.roster.trim();
	if (base.params && typeof base.params === "object" && !Array.isArray(base.params)) defaults.params = base.params;
	const merged: CouncilDraft = { ...defaults, ...authored };
	if (defaults.params || authored.params) merged.params = { ...defaults.params, ...authored.params };
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
	/** Raw `members:` from the call — validated HERE so an unusable block is a diagnostic
	 *  rather than a silent fall back to the named team (a tool schema cannot validate it). */
	members?: unknown;
	params?: Record<string, unknown> | undefined;
}

export interface ResolvedCouncilInvocation {
	strategy: string;
	/** The named team. EMPTY when inline `members` are in effect — there is no named team for
	 *  an ephemeral call, and a misleading team name would mislabel the card and the tree. */
	roster: string;
	/** The ephemeral members actually in effect (validated), when any. */
	members?: RosterMember[];
	params: Record<string, unknown>;
	/** Persona whose council declaration supplied the defaults, when any. */
	persona?: string;
}

export type CouncilInvocationResolution =
	| { ok: true; value: ResolvedCouncilInvocation }
	| { ok: false; error: string };

function hasCouncilDeclaration(council: CouncilDraft | undefined): boolean {
	return Boolean(council?.strategy || council?.members || council?.membersProblem);
}

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
				.filter((persona) => persona.isPersona && hasCouncilDeclaration(persona.council))
				.map((persona) => persona.name)
				.sort();
			return {
				ok: false,
				error: `no persona named "${requestedName}". Council personas: ${available.join(", ") || "(none)"}`,
			};
		}
		if (!hasCouncilDeclaration(sourcePersona.council)) {
			return {
				ok: false,
				error: `persona "${requestedName}" declares no usable council`,
			};
		}
	} else if (hasCouncilDeclaration(activePersona?.council)) {
		sourcePersona = activePersona;
	}

	const base = sourcePersona?.council;
	if (base?.membersProblem) {
		return { ok: false, error: `${requestedName ? `persona "${requestedName}"` : `the active persona "${activePersona?.name ?? "?"}"`}: ${base.membersProblem}` };
	}
	const strategy = request.strategy?.trim() || base?.strategy || "magi";
	// Ephemeral members win the named team, for this call only: nothing is written back to
	// teams.yaml, the persona file, or any model/prompt/capability the profile would imply.
	let members = base?.members;
	if (request.members !== undefined) {
		const parsed = parseMembersBlock(request.members);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		members = parsed.members;
	}
	const roster = members
		? ""
		: request.roster?.trim() ||
			base?.roster ||
			sourcePersona?.orchestration?.roster ||
			(!requestedName ? activePersona?.orchestration?.roster : undefined) ||
			"magi";
	// Profile params belong to the profile's strategy. A per-call strategy switch starts
	// with that strategy's own defaults; only explicitly supplied params cross the switch.
	const inheritedParams = strategy !== (base?.strategy || "magi") ? {} : base?.params ?? {};
	const value: ResolvedCouncilInvocation = {
		strategy,
		roster,
		params: { ...inheritedParams, ...(request.params ?? {}) },
	};
	if (sourcePersona) value.persona = sourcePersona.name;
	if (members) value.members = members;
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

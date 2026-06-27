/**
 * Persona definition + parsing — the supervisor identity and its orchestration
 * grammar. Pure module (uses only the core helpers, no Pi imports).
 *
 * A persona file is Markdown: YAML-subset frontmatter + a body (the supervisor
 * system prompt). `persona: true` marks it switchable. The optional
 * `orchestration:` block is the control surface; absent ⇒ L0 (opportunistic).
 */

import { asPermission, parseYamlSubset, splitFrontmatter } from "../core/frontmatter.ts";
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
	/** Tool-driven council the `council` tool runs (no mandatory firing). */
	council?: CouncilSpec;
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

	return persona;
}

/** Parse a persona's `council:` block (strategy + roster + params). */
function parseCouncil(value: unknown): CouncilSpec | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	const strategy = typeof o.strategy === "string" && o.strategy.trim() ? o.strategy.trim() : "";
	if (!strategy) return undefined;
	const spec: CouncilSpec = { strategy };
	if (typeof o.roster === "string" && o.roster.trim()) spec.roster = o.roster.trim();
	if (o.params && typeof o.params === "object" && !Array.isArray(o.params)) {
		spec.params = o.params as Record<string, unknown>;
	}
	return spec;
}

/** Compose the turn's system prompt from the base prompt and a persona. */
export function composeSystemPrompt(base: string, persona: Persona): string {
	if (persona.systemPromptMode === "replace") return persona.body;
	if (!persona.body.trim()) return base;
	return `${base}\n\n${persona.body}`;
}

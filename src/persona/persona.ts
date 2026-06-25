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
	/** A structured field to fan out one child per item (L1). */
	per?: string;
}

export interface Persona {
	name: string;
	label: string;
	/** `persona: true` marks a file as a switchable supervisor persona. */
	isPersona: boolean;
	model?: string;
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	delegate?: Permission;
	tools?: Permission;
	skills?: Permission;
	/** Absent ⇒ L0 opportunistic delegation. */
	orchestration?: OrchestrationGrammar;
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
	if (typeof o.per === "string" && o.per.trim()) grammar.per = o.per.trim();
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
	if (typeof fm.model === "string" && fm.model.trim()) persona.model = fm.model.trim();
	if (typeof fm.thinking === "string" && fm.thinking.trim()) persona.thinking = fm.thinking.trim();

	const delegate = asPermission(fm.delegate);
	if (delegate) persona.delegate = delegate;
	const tools = asPermission(fm.tools);
	if (tools) persona.tools = tools;
	const skills = asPermission(fm.skills);
	if (skills) persona.skills = skills;

	const orchestration = parseOrchestration(fm.orchestration);
	if (orchestration) persona.orchestration = orchestration;

	return persona;
}

/** Compose the turn's system prompt from the base prompt and a persona. */
export function composeSystemPrompt(base: string, persona: Persona): string {
	if (persona.systemPromptMode === "replace") return persona.body;
	if (!persona.body.trim()) return base;
	return `${base}\n\n${persona.body}`;
}

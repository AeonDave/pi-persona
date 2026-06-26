/**
 * Agent definition parsing — the executors a persona delegates to. Same MD+YAML
 * engine as personas; the body is the agent's system prompt. Agents default to
 * `systemPromptMode: replace` (narrow-by-default: a clean prompt, no base).
 *
 * Pure module — no Pi imports.
 */

import { asStringArray, parseYamlSubset, splitFrontmatter } from "../core/frontmatter.ts";
import { asSystemPromptMode, type SystemPromptMode } from "../core/types.ts";

export interface AgentConfig {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	systemPromptMode: SystemPromptMode;
	source: string;
}

export function parseAgent(content: string, source: string): AgentConfig | null {
	const { frontmatter, body } = splitFrontmatter(content);
	const fm = parseYamlSubset(frontmatter);
	const name = typeof fm.name === "string" ? fm.name.trim() : "";
	if (!name) return null;

	const agent: AgentConfig = {
		name,
		systemPrompt: body,
		systemPromptMode: asSystemPromptMode(fm.systemPromptMode, "replace"),
		source,
	};
	if (typeof fm.description === "string" && fm.description.trim()) agent.description = fm.description.trim();
	if (typeof fm.model === "string" && fm.model.trim()) agent.model = fm.model.trim();
	const tools = asStringArray(fm.tools);
	if (tools) agent.tools = tools;

	return agent;
}

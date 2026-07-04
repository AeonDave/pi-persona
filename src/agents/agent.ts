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
	/** `worktree` runs this agent in an isolated git worktree (its edits never touch the
	 *  main tree); `none` (default) shares the working tree. */
	isolation?: "none" | "worktree";
	/** `mcp: true` routes this agent through the CHILD engine so `session_start`-scoped
	 *  extensions (notably `pi-mcp-adapter`) initialize and its `mcp*`/direct tools work.
	 *  The default in-process engine never fires `session_start`, so those tools are dead
	 *  ("MCP not initialized"). The child gets its OWN MCP session; for a server-keyed
	 *  backend (HTTP MCP, session id passed as a tool argument) pass the id to share state. */
	mcp?: boolean;
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
	if (fm.isolation === "worktree") agent.isolation = "worktree";
	if (fm.mcp === true) agent.mcp = true;

	return agent;
}

/**
 * Agent definition parsing — the executors a persona delegates to. Same MD+YAML
 * engine as personas; the body is the agent's system prompt, which BOTH engines append to
 * Pi's base prompt (child: `--append-system-prompt`; in-process: `appendSystemPrompt`).
 * There is deliberately no `systemPromptMode` here — the persona path owns that knob, and
 * a copy on the agent would be a mode nothing honours.
 *
 * Pure module — no Pi imports.
 */

import { asBoolean, asPermission, parseYamlSubset, splitFrontmatter } from "../core/frontmatter.ts";

export interface AgentConfig {
	name: string;
	description?: string;
	model?: string;
	/** Tool allowlist passed to Pi. Absent means the session default tool set. */
	tools?: string[];
	/** Tool denylist applied after the allowlist/session default. */
	excludeTools?: string[];
	/** `worktree` runs this agent in an isolated git worktree (its edits never touch the
	 *  main tree); `none` (default) shares the working tree. */
	isolation?: "none" | "worktree";
	/** `mcp: true` routes this agent through the CHILD engine so `session_start`-scoped
	 *  extensions (notably `pi-mcp-adapter`) initialize and its `mcp*`/direct tools work.
	 *  The default in-process engine never fires `session_start`, so those tools are dead
	 *  ("MCP not initialized"). The child gets its OWN MCP session; for a server-keyed
	 *  backend (HTTP MCP, session id passed as a tool argument) pass the id to share state. */
	mcp?: boolean;
	/** `spine: false` opts this agent out of the shared behavioral layer (docs/SPINE.md).
	 *  Only an explicit false is recorded; absent ⇒ the session-level setting decides. */
	spine?: boolean;
	systemPrompt: string;
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
		source,
	};
	if (typeof fm.description === "string" && fm.description.trim()) agent.description = fm.description.trim();
	if (typeof fm.model === "string" && fm.model.trim()) agent.model = fm.model.trim();
	const tools = asPermission(fm.tools);
	if (tools?.allow) agent.tools = tools.allow;
	if (tools?.deny) agent.excludeTools = tools.deny;
	if (fm.isolation === "worktree") agent.isolation = "worktree";
	if (fm.mcp === true) agent.mcp = true;
	if (asBoolean(fm.spine) === false) agent.spine = false;

	return agent;
}

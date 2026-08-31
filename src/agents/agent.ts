/**
 * Agent definition parsing — the executors a persona delegates to. Same MD+YAML
 * engine as personas; the body is the agent's system prompt, which BOTH engines append to
 * Pi's base prompt (child: `--append-system-prompt`; in-process: `appendSystemPrompt`).
 * There is deliberately no `systemPromptMode` here — the persona path owns that knob, and
 * a copy on the agent would be a mode nothing honours.
 *
 * Pure module — no Pi imports.
 */

import { sanitizeStatusLabel } from "../core/display-label.ts";
import { asBoolean, asPermission, parseYamlSubset, splitFrontmatter } from "../core/frontmatter.ts";

export interface AgentConfig {
	name: string;
	description?: string;
	/** The agent's standing verticalization — one or two words naming the lens it argues from
	 *  ("Propulsore", "Critico", "Scienziato"). Shown beside the name wherever a council member
	 *  is chosen or watched, so a roster reads as a set of ROLES rather than a set of names. Not
	 *  prompt text: the body already carries the behaviour, this only labels it. */
	purpose?: string;
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

/** A verticalization is a one- or two-word lens, not a sentence. Kept short deliberately: it shares a
 *  tree/overlay row with the core's name AND its model, and at 32 it could push the model off. The
 *  shipped cores are 10-13 characters ("Catalizzatore"). */
export const MAX_PURPOSE_CHARS = 24;

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
	// Bounded at the EDGE, once, rather than at each render site: a purpose is interpolated straight
	// into a tree row and a picker title, and an agent file is project data. One folded line, no
	// terminal control sequences, and short enough that it cannot crowd out the name or the model.
	if (typeof fm.purpose === "string" && fm.purpose.trim()) {
		// `sanitizeStatusLabel` substitutes its own "agent" literal when a value reduces to nothing,
		// which for a purpose would invent a lens out of pure control characters — so drop it instead.
		const purpose = sanitizeStatusLabel(fm.purpose, "", MAX_PURPOSE_CHARS);
		if (purpose && purpose !== "agent") agent.purpose = purpose;
	}
	if (typeof fm.model === "string" && fm.model.trim()) agent.model = fm.model.trim();
	const tools = asPermission(fm.tools);
	if (tools?.allow) agent.tools = tools.allow;
	if (tools?.deny) agent.excludeTools = tools.deny;
	if (fm.isolation === "worktree") agent.isolation = "worktree";
	if (fm.mcp === true) agent.mcp = true;
	if (asBoolean(fm.spine) === false) agent.spine = false;

	return agent;
}

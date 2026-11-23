import { type AgentNode, projectAgentTreeSummary, type RenderOptions, renderAgentTreeRows } from "../../src/ui/agent-tree.ts";
import { rowText } from "../../src/ui/styled-row.ts";

/** The plain lines production paints, composed from the styled-row projections it actually uses. */
export function renderAgentTree(nodes: AgentNode[], opts: RenderOptions = {}): string[] {
	return renderAgentTreeRows(nodes, opts).map(rowText);
}

export function renderAgentTreeSummary(nodes: AgentNode[], maxRows = 8, opts: RenderOptions = {}): string[] {
	return projectAgentTreeSummary(nodes, maxRows, opts).map((row) => row.text);
}

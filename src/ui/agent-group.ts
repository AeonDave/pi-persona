import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AgentNode, effortTag, isNonAgentNode, isQueuedMarker } from "./agent-tree.ts";
import { compactInlineText } from "./presentation.ts";
import { formatUsage } from "./usage.ts";

/** Semantic containers stay containers even while their next phase has no children. */
export function isAgentGroup(node: AgentNode, nodes: readonly AgentNode[]): boolean {
	return hasGroupKind(node)
		|| nodes.some((candidate) => candidate.parentId === node.id);
}

function hasGroupKind(node: AgentNode): boolean {
	return node.kind === "delegate" || node.kind === "council" || node.kind === "flow" || node.kind === "phase";
}

export function groupLegStatus(node: AgentNode, waiting = false): string {
	if (node.status !== "running") return node.status;
	return isQueuedMarker(node.detail) ? "queued" : waiting ? "waiting" : "running";
}

export interface AgentGroup {
	root: AgentNode;
	legs: AgentNode[];
	summary: string;
}

/** Project workers once, excluding aggregate run/phase rows and local wake/activity rows. */
export function projectAgentGroup(nodes: readonly AgentNode[], rootId: string, waitingIds?: ReadonlySet<string>): AgentGroup | undefined {
	const root = nodes.find((node) => node.id === rootId);
	if (!root) return undefined;
	const children = new Map<string, AgentNode[]>();
	for (const node of nodes) {
		if (node.parentId === undefined) continue;
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const legs: AgentNode[] = [];
	const visited = new Set<string>([rootId]);
	const visit = (node: AgentNode): void => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		if (!isNonAgentNode(node) && !children.has(node.id) && !hasGroupKind(node)) legs.push(node);
		for (const child of children.get(node.id) ?? []) visit(child);
	};
	for (const child of children.get(rootId) ?? []) visit(child);
	// Attention states come first so narrow summaries keep failures and asks visible.
	const counts = ["failed", "waiting", "running", "queued", "done", "stopped"].flatMap((status) => {
		const count = legs.filter((leg) => groupLegStatus(leg, waitingIds?.has(leg.id)) === status).length;
		return count > 0 ? [`${count} ${status}`] : [];
	});
	return { root, legs, summary: [`${legs.length} legs`, ...counts].join(" · ") };
}

/** Bounded findings first; trailing archive/retrieval instructions are not the result. */
export function groupLegBrief(node: AgentNode): string {
	const detail = node.usage && node.detail === formatUsage(node.usage) ? undefined : node.detail;
	if (node.status === "running") return `activity: ${compactInlineText(detail || "working…", { maxChars: 240 })}`;
	const excerpt = node.output?.slice(0, 4096).trimStart().split(/\n\s*\n/, 1)[0]?.split("\n").filter((line) => line.trim()).slice(0, 2).join(" ");
	const brief = node.status === "failed" && detail ? detail : excerpt || detail || "(no output retained)";
	return `result: ${compactInlineText(brief, { maxChars: 240 })}`;
}

export function groupLegMetadata(node: AgentNode, columns: number): string {
	const effort = effortTag(node.thinking, node.thinkingEffective);
	const model = compactInlineText(node.model ?? "pending / unknown", { maxChars: 240 });
	return truncateToWidth(`model: ${model}`, Math.max(0, columns - visibleWidth(effort)), "…") + effort;
}

/** Same known usage snapshot as runtime cards; never sum containers with their own workers. */
export function cumulativeUsageLine(node: AgentNode): string | undefined {
	return node.usage ? `cumulative usage: ${formatUsage(node.usage) || "0"}` : undefined;
}

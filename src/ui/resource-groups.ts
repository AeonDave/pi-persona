import type { AgentNode, RenderOptions } from "./agent-tree.ts";
import { flattenTree, renderAgentTreeSummary } from "./agent-tree.ts";

export type ResourceKind = "timer" | "monitor" | "script";
export const RESOURCE_GROUP_IDS: Record<ResourceKind, string> = {
	timer: "ui:resources:timer", monitor: "ui:resources:monitor", script: "ui:resources:script",
};
const kinds: readonly ResourceKind[] = ["timer", "monitor", "script"];
export const PEER_GROUP_ID = "ui:resources:peers";
export interface PeerPresence {
	key: string;
	name: string;
	persona?: string;
	model?: string;
	contextPercent?: number;
	status: "online" | "idle";
}

/** A peer presence is display-only and never enters the runtime tree or stop registry. */
export function projectPeers(peers: readonly PeerPresence[]): AgentNode[] {
	if (peers.length === 0) return [];
	return [
		{ id: PEER_GROUP_ID, label: "Exocom peers", parentId: undefined, status: "running", kind: "resource-group", detail: `${peers.length} peer${peers.length === 1 ? "" : "s"}` },
		...peers.map((peer): AgentNode => ({
			id: `${PEER_GROUP_ID}:${peer.key}`, label: peer.name, parentId: PEER_GROUP_ID, status: "running", kind: "peer",
			detail: peer.status,
			output: [`status: ${peer.status}`, ...(peer.persona ? [`persona: ${peer.persona}`] : []), ...(peer.model ? [`model: ${peer.model}`] : []), ...(peer.contextPercent !== undefined ? [`context: ${peer.contextPercent}%`] : [])].join("\n"),
		})),
	];
}

export function isResourceGroup(id: string): boolean {
	return id === PEER_GROUP_ID || kinds.some((kind) => RESOURCE_GROUP_IDS[kind] === id);
}

/** Presentation-only categories; the runtime tree and its stop/telemetry identifiers stay intact. */
export function projectResourceGroups(nodes: readonly AgentNode[]): AgentNode[] {
	const result = nodes.filter((node) => !kinds.some((kind) => node.kind === kind && node.parentId === undefined));
	for (const kind of kinds) {
		const children = nodes.filter((node) => node.kind === kind && node.parentId === undefined);
		if (!children.length) continue;
		const id = RESOURCE_GROUP_IDS[kind];
		result.push({ id, label: `${kind[0]!.toUpperCase()}${kind.slice(1)}s`, parentId: undefined,
			status: "running", kind: "resource-group", detail: `${children.length} active` });
		for (const child of children) result.push({ ...child, parentId: id });
	}
	return result;
}

/** Keep click targets aligned with the actual bounded summary, including synthetic digest rows. */
export function resourceSummary(nodes: readonly AgentNode[], collapsed: ReadonlySet<string>, maxRows: number, opts: RenderOptions = {}): { lines: string[]; targets: (string | undefined)[] } {
	const projected = projectResourceGroups(nodes).filter((node) => node.parentId === undefined || !collapsed.has(node.parentId));
	const lines = renderAgentTreeSummary(projected, maxRows, opts);
	const fullLines = renderAgentTreeSummary(projected, Number.MAX_SAFE_INTEGER, opts);
	const flat = flattenTree(projected);
	const targets = lines.map((_, index) => {
		const row = flat[index];
		return row && isResourceGroup(row.node.id) && lines[index] === fullLines[index] ? row.node.id : undefined;
	});
	// A fan-out can fill the bounded digest before the resource roots. Reserve a visible
	// control for each category, while keeping failure and supervisor-waiting digests.
	for (let index = flat.length - 1; index >= 0; index--) {
		const row = flat[index];
		if (!row || !isResourceGroup(row.node.id) || targets.includes(row.node.id)) continue;
		let replace = -1;
		for (let candidate = lines.length - 1; candidate >= 0; candidate--) {
			if (targets[candidate] || lines[candidate]?.startsWith("✗ ") || lines[candidate]?.startsWith("? ") || lines[candidate]?.includes("F9 or /agents")) continue;
			replace = candidate;
			break;
		}
		if (replace < 0) break;
		lines[replace] = fullLines[index]!;
		targets[replace] = row.node.id;
	}
	for (let i = 0; i < lines.length; i++) {
		const id = targets[i];
		if (id) lines[i] = `${collapsed.has(id) ? "▸" : "▾"} ${lines[i]}`;
	}
	return { lines, targets };
}

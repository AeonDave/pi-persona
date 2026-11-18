import type { ThinkingLevel } from "../core/types.ts";
import type { AgentNode, RenderOptions } from "./agent-tree.ts";
import { modelEffortText } from "./model-effort.ts";
import { flattenTree, isStalledNode, projectAgentTreeSummary, type FlatRow } from "./agent-tree.ts";
import { rowText, type StyledRow } from "./styled-row.ts";

export type ResourceKind = "timer" | "monitor" | "script";
export const RESOURCE_GROUP_IDS: Record<ResourceKind, string> = {
	timer: "ui:resources:timer", monitor: "ui:resources:monitor", script: "ui:resources:script",
};
const kinds: readonly ResourceKind[] = ["timer", "monitor", "script"];
export const PEER_GROUP_ID = "ui:resources:peers";
/** F9-only completed-worker projection; never enters the runtime tree or widget. */
export const RECENT_WORKERS_GROUP_ID = "ui:resources:recent-workers";
export interface PeerPresence {
	key: string;
	name: string;
	persona?: string;
	model?: string;
	/** Self-reported Pi effort, shown after the model wherever the model is shown. */
	thinking?: ThinkingLevel;
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
			output: [`status: ${peer.status}`, ...(peer.persona ? [`persona: ${peer.persona}`] : []), ...(peer.model ? [`model: ${modelEffortText(peer.model, peer.thinking)}`] : []), ...(peer.contextPercent !== undefined ? [`context: ${peer.contextPercent}%`] : [])].join("\n"),
		})),
	];
}

export function isResourceGroup(id: string): boolean {
	return id === PEER_GROUP_ID || id === RECENT_WORKERS_GROUP_ID || kinds.some((kind) => RESOURCE_GROUP_IDS[kind] === id);
}

/** Retain category preferences but release fold state for delegate batches removed from the tree. */
export function pruneFoldState(collapsed: Set<string>, nodes: readonly AgentNode[]): void {
	const live = new Set(nodes.filter((node) => node.kind === "delegate").map((node) => node.id));
	for (const id of collapsed) if (!isResourceGroup(id) && !live.has(id)) collapsed.delete(id);
}

/** Runtime delegate roots and presentation resource groups share one fold state. */
export function isFoldableRow(node: AgentNode, nodes: readonly AgentNode[]): boolean {
	return isResourceGroup(node.id) || (node.kind === "delegate" && nodes.some((child) => child.parentId === node.id));
}

function foldedAlerts(descendants: AgentNode[], opts: RenderOptions): string[] {
	const parents = new Set(descendants.flatMap((node) => node.parentId ? [node.parentId] : []));
	const workers = descendants.filter((node) => !parents.has(node.id) && node.kind === "subagent");
	const failed = descendants.filter((node) => node.status === "failed").length;
	const waiting = workers.filter((node) => node.status === "running" && opts.waitingForSupervisor?.has(node.id)).length;
	const stalled = opts.now === undefined ? 0 : workers.filter((node) => isStalledNode(node, opts.now!, opts.stallMs ?? 0, opts.waitingForSupervisor?.has(node.id))).length;
	return [failed ? `${failed} failed` : "", waiting ? `${waiting} waiting` : "", stalled ? `${stalled} stalled` : ""].filter(Boolean);
}

/** Hide all descendants while keeping actionable aggregate signals on a folded delegate root. */
export function foldedRows(nodes: AgentNode[], collapsed: ReadonlySet<string>, opts: RenderOptions = {}): FlatRow[] {
	const { rows, alerts } = foldRows(nodes, collapsed, opts);
	return rows.map((row) => {
		const leading = alerts.get(row.node.id);
		return leading ? { ...row, node: { ...row.node, detail: [...leading, row.node.detail].filter(Boolean).join(" · ") } } : row;
	});
}

/** The folding walk with each folded root's alerts kept apart from its detail, so the widget can
 *  paint them as attention spans that survive clipping. */
function foldRows(nodes: AgentNode[], collapsed: ReadonlySet<string>, opts: RenderOptions): { rows: FlatRow[]; alerts: Map<string, string[]> } {
	const flat = flattenTree(nodes);
	const hiddenDepths: number[] = [];
	const alerts = new Map<string, string[]>();
	const rows = flat.flatMap((row, index) => {
		while (hiddenDepths.length && hiddenDepths[hiddenDepths.length - 1]! >= row.depth) hiddenDepths.pop();
		if (hiddenDepths.length) return [];
		if (!collapsed.has(row.node.id) || !isFoldableRow(row.node, nodes)) return [row];
		hiddenDepths.push(row.depth);
		if (row.node.kind !== "delegate") return [row];
		let end = index + 1;
		while (end < flat.length && flat[end]!.depth > row.depth) end++;
		const found = foldedAlerts(flat.slice(index + 1, end).map((item) => item.node), opts);
		if (found.length) alerts.set(row.node.id, found);
		return [row];
	});
	return { rows, alerts };
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

/** Keep click targets aligned with the actual bounded summary, including synthetic digest rows.
 *  `styled[i]` paints `lines[i]` (`rowText(styled[i]) === lines[i]`); `targets[i]` is its control.
 *  Only collapsed controls are reserved: an expanded group header whose children fall below the
 *  fold folds into the wake digest, so its row goes to legs. */
export function resourceSummary(nodes: readonly AgentNode[], collapsed: ReadonlySet<string>, maxRows: number, opts: RenderOptions = {}): { lines: string[]; targets: (string | undefined)[]; styled: StyledRow[] } {
	const all = projectResourceGroups(nodes);
	const folded = foldRows(all, collapsed, opts);
	const projected = folded.rows.map((row) => row.node);
	const flat = flattenTree(projected);
	const preferred = flat.filter((row) => collapsed.has(row.node.id) && (isResourceGroup(row.node.id) || row.node.kind === "delegate")).map((row) => row.node.id);
	const summary = projectAgentTreeSummary(projected, maxRows, { ...opts, alerts: folded.alerts }, preferred);
	const styled: StyledRow[] = summary.map((row) => row.spans);
	const targets = summary.map((item) => {
		const node = item.nodeId ? all.find((candidate) => candidate.id === item.nodeId) : undefined;
		return node && isFoldableRow(node, all) ? node.id : undefined;
	});
	// When many folded batches fill every row, retain one aggregate for alerts in omitted
	// batches. A projection-only digest must not turn an unresolved ask or failure invisible.
	const fullFlat = flattenTree(all);
	const omitted: AgentNode[] = [];
	const allFolded: AgentNode[] = [];
	for (let i = 0; i < fullFlat.length; i++) {
		const row = fullFlat[i]!;
		if (row.node.kind !== "delegate" || !collapsed.has(row.node.id)) continue;
		let end = i + 1;
		while (end < fullFlat.length && fullFlat[end]!.depth > row.depth) end++;
		const descendants = fullFlat.slice(i + 1, end).map((item) => item.node);
		allFolded.push(...descendants);
		if (!targets.includes(row.node.id)) omitted.push(...descendants);
		i = end - 1;
	}
	const alerts = foldedAlerts(omitted, opts);
	if (alerts.length) {
		const counts = foldedAlerts(allFolded, opts);
		if (styled.length) {
			const navigation = summary.findIndex((item) => item.kind === "overflow");
			const lastDigest = summary.findLastIndex((item) => item.kind !== "node");
			const index = navigation >= 0 ? navigation : lastDigest >= 0 ? lastDigest : styled.length - 1;
			styled[index] = [
				...summary[index]!.compactSpans,
				{ text: " · ⚠ folded delegates", token: "warning" },
				...counts.flatMap((count) => [
					{ text: " · ", token: "dim" as const, keep: true },
					{ text: count, token: "warning" as const, keep: true },
				]),
				...(navigation >= 0 ? [{ text: " · F9 or /agents", token: "dim" as const }] : []),
			];
		}
	}
	for (let i = 0; i < styled.length; i++) {
		const id = targets[i];
		if (id) styled[i] = [{ text: `${collapsed.has(id) ? "▸" : "▾"} `, token: "muted" }, ...styled[i]!];
	}
	return { lines: styled.map(rowText), targets, styled };
}

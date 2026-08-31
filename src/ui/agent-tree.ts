import { compactInlineText } from "./presentation.ts";

/**
 * The unified agent tree — a single live model of *every* agent in flight,
 * regardless of how it was spawned: strategy cores (magi/fanout/critic), the
 * `delegate` tool's sub-agents, and dynamic specialists. The UI layer renders
 * one sticky tree above the input from this model, and (later) lets the user
 * drill into a node. Sources only push status/detail; rendering is pure.
 */

export type AgentNodeStatus = "running" | "done" | "failed" | "stopped";
export type AgentNodeKind = "subagent" | "delegate" | "council" | "flow" | "phase";

export interface AgentNode {
	id: string;
	label: string;
	parentId: string | undefined;
	status: AgentNodeStatus;
	/** Semantic role in the orchestration graph; omitted by legacy callers. */
	kind?: AgentNodeKind;
	/** Configured agent definition (operator/reviewer/…), if known. */
	agent?: string;
	model?: string;
	/** A short trailing annotation (usage, current activity), shown after the label. */
	detail: string | undefined;
	/** The agent's output buffer, shown when the user drills into the node. */
	output?: string;
}

export type AgentTreeChange =
	| { type: "added"; node: AgentNode }
	| { type: "updated"; node: AgentNode }
	| { type: "removed"; nodes: AgentNode[] }
	| { type: "cleared"; nodes: AgentNode[] };

export interface FlatRow {
	node: AgentNode;
	depth: number;
}

/** Flatten the tree into display order (root, then its children…) with depth. Pure. */
export function flattenTree(nodes: AgentNode[]): FlatRow[] {
	const rows: FlatRow[] = [];
	const walk = (parentId: string | undefined, depth: number): void => {
		for (const node of nodes.filter((n) => n.parentId === parentId)) {
			rows.push({ node, depth });
			walk(node.id, depth + 1);
		}
	};
	walk(undefined, 0);
	return rows;
}

/** Status → glyph, shared by every agent surface (tree, overlay). */
export const GLYPH: Record<AgentNodeStatus, string> = { running: "⏳", done: "✓", failed: "✗", stopped: "■" };

function safeInline(value: string): string {
	return compactInlineText(value, { maxChars: 96 });
}

/** Render the tree as plain lines with ├─/└─ branches and status glyphs. Pure. */
export function renderAgentTree(nodes: AgentNode[]): string[] {
	const lines: string[] = [];
	const childrenOf = (parentId: string | undefined): AgentNode[] => nodes.filter((n) => n.parentId === parentId);

	const walk = (parentId: string | undefined, prefix: string): void => {
		const kids = childrenOf(parentId);
		kids.forEach((node, i) => {
			const isRoot = parentId === undefined;
			const isLast = i === kids.length - 1;
			const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
			const label = safeInline(node.label) || safeInline(node.id) || "agent";
			const detailText = node.detail ? safeInline(node.detail) : "";
			const detail = detailText ? `  ${detailText}` : "";
			lines.push(`${prefix}${branch}${GLYPH[node.status]} ${label}${detail}`);
			const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
			walk(node.id, childPrefix);
		});
	};

	walk(undefined, "");
	return lines;
}

/**
 * Bounded above-editor digest. Large fan-outs belong in the scrollable F9
 * overlay; they must not push the editor and conversation off the screen.
 */
export function renderAgentTreeSummary(nodes: AgentNode[], maxRows = 8): string[] {
	const rows = renderAgentTree(nodes);
	const limit = Math.max(1, Math.floor(maxRows));
	if (rows.length <= limit) return rows;
	const failed = nodes.filter((node) => node.status === "failed");
	if (failed.length > 0) {
		const names = failed.slice(0, 2).map((node) => {
			const label = safeInline(node.label) || "agent";
			const detail = node.detail ? safeInline(node.detail) : "";
			return detail ? `${label} (${detail})` : label;
		});
		const extra = failed.length - names.length;
		const failureLine = `✗ ${failed.length} failed: ${names.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
		if (limit === 1) return [failureLine];
		const visibleCount = Math.max(0, limit - 2);
		return [
			...rows.slice(0, visibleCount),
			failureLine,
			`… +${rows.length - visibleCount} more · F9 or /agents for the full live tree`,
		];
	}
	const visibleCount = Math.max(0, limit - 1);
	return [
		...rows.slice(0, visibleCount),
		`… +${rows.length - visibleCount} more · F9 or /agents for the full live tree`,
	];
}

export interface AddNodeInput {
	id: string;
	label: string;
	parentId?: string;
	status?: AgentNodeStatus;
	kind?: AgentNodeKind;
	agent?: string;
	model?: string;
	detail?: string;
	output?: string;
}

export interface AgentNodePatch {
	status?: AgentNodeStatus;
	kind?: AgentNodeKind;
	agent?: string;
	model?: string;
	detail?: string;
	output?: string;
}

/** A small mutable registry with change notification. The extension owns one. */
export class AgentTree {
	private nodes: AgentNode[] = [];
	private listeners = new Set<(change: AgentTreeChange) => void>();

	/** Insert a node, or upsert (relabel / restatus / reparent) when the id already exists. */
	add(input: AddNodeInput): void {
		const existing = this.nodes.find((n) => n.id === input.id);
		if (existing) {
			const before = { ...existing };
			existing.label = input.label;
			if (input.parentId !== undefined) existing.parentId = input.parentId;
			if (input.status) existing.status = input.status;
			if (input.kind !== undefined) existing.kind = input.kind;
			if (input.agent !== undefined) existing.agent = input.agent;
			if (input.model !== undefined) existing.model = input.model;
			if (input.detail !== undefined) existing.detail = input.detail;
			if (input.output !== undefined) existing.output = input.output;
			if (!sameNode(before, existing)) this.emit({ type: "updated", node: { ...existing } });
			return;
		}
		const node: AgentNode = {
			id: input.id,
			label: input.label,
			parentId: input.parentId,
			status: input.status ?? "running",
			detail: input.detail,
			...(input.kind !== undefined ? { kind: input.kind } : {}),
			...(input.agent !== undefined ? { agent: input.agent } : {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.output !== undefined ? { output: input.output } : {}),
		};
		this.nodes.push(node);
		this.emit({ type: "added", node: { ...node } });
	}

	update(id: string, patch: AgentNodePatch): void {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		const before = { ...node };
		if (patch.status) node.status = patch.status;
		if (patch.kind !== undefined) node.kind = patch.kind;
		if (patch.agent !== undefined) node.agent = patch.agent;
		if (patch.model !== undefined) node.model = patch.model;
		if (patch.detail !== undefined) node.detail = patch.detail;
		if (patch.output !== undefined) node.output = patch.output;
		if (!sameNode(before, node)) this.emit({ type: "updated", node: { ...node } });
	}

	/** Remove a node and all its descendants. */
	remove(id: string): void {
		const doomed = new Set<string>([id]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const n of this.nodes) {
				if (n.parentId !== undefined && doomed.has(n.parentId) && !doomed.has(n.id)) {
					doomed.add(n.id);
					grew = true;
				}
			}
		}
		const removed = this.nodes.filter((n) => doomed.has(n.id)).map((n) => ({ ...n }));
		if (removed.length === 0) return;
		this.nodes = this.nodes.filter((n) => !doomed.has(n.id));
		this.emit({ type: "removed", nodes: removed });
	}

	clear(): void {
		if (this.nodes.length === 0) return;
		const removed = this.snapshot();
		this.nodes = [];
		this.emit({ type: "cleared", nodes: removed });
	}

	snapshot(): AgentNode[] {
		return this.nodes.map((n) => ({ ...n }));
	}

	isEmpty(): boolean {
		return this.nodes.length === 0;
	}

	hasRunning(): boolean {
		return this.nodes.some((n) => n.status === "running");
	}

	onChange(fn: (change: AgentTreeChange) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private emit(change: AgentTreeChange): void {
		for (const fn of this.listeners) fn(change);
	}
}

function sameNode(a: AgentNode, b: AgentNode): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => a[key as keyof AgentNode] === b[key as keyof AgentNode]);
}

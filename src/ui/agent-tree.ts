/**
 * The unified agent tree — a single live model of *every* agent in flight,
 * regardless of how it was spawned: strategy cores (magi/fanout/critic), the
 * `delegate` tool's sub-agents, and dynamic specialists. The UI layer renders
 * one sticky tree above the input from this model, and (later) lets the user
 * drill into a node. Sources only push status/detail; rendering is pure.
 */

export type AgentNodeStatus = "running" | "done" | "failed" | "stopped";

export interface AgentNode {
	id: string;
	label: string;
	parentId: string | undefined;
	status: AgentNodeStatus;
	/** A short trailing annotation (usage, current activity), shown after the label. */
	detail: string | undefined;
	/** The agent's output buffer, shown when the user drills into the node. */
	output?: string;
}

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
			const detail = node.detail ? `  ${node.detail}` : "";
			lines.push(`${prefix}${branch}${GLYPH[node.status]} ${node.label}${detail}`);
			const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
			walk(node.id, childPrefix);
		});
	};

	walk(undefined, "");
	return lines;
}

export interface AddNodeInput {
	id: string;
	label: string;
	parentId?: string;
	status?: AgentNodeStatus;
	detail?: string;
	output?: string;
}

/** A small mutable registry with change notification. The extension owns one. */
export class AgentTree {
	private nodes: AgentNode[] = [];
	private listeners = new Set<() => void>();

	/** Insert a node, or upsert (relabel / restatus / reparent) when the id already exists. */
	add(input: AddNodeInput): void {
		const existing = this.nodes.find((n) => n.id === input.id);
		if (existing) {
			existing.label = input.label;
			if (input.parentId !== undefined) existing.parentId = input.parentId;
			if (input.status) existing.status = input.status;
			if (input.detail !== undefined) existing.detail = input.detail;
			if (input.output !== undefined) existing.output = input.output;
		} else {
			const node: AgentNode = {
				id: input.id,
				label: input.label,
				parentId: input.parentId,
				status: input.status ?? "running",
				detail: input.detail,
			};
			if (input.output !== undefined) node.output = input.output;
			this.nodes.push(node);
		}
		this.emit();
	}

	update(id: string, patch: { status?: AgentNodeStatus; detail?: string; output?: string }): void {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		if (patch.status) node.status = patch.status;
		if (patch.detail !== undefined) node.detail = patch.detail;
		if (patch.output !== undefined) node.output = patch.output;
		this.emit();
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
		this.nodes = this.nodes.filter((n) => !doomed.has(n.id));
		this.emit();
	}

	clear(): void {
		if (this.nodes.length === 0) return;
		this.nodes = [];
		this.emit();
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

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}
}

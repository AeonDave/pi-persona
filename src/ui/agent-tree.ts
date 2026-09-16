import { compactTokens } from "../core/format.ts";
import { formatDuration } from "../core/time.ts";
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
	/** Clock data (ms since epoch). Set by the tree on add; `lastAdvanceAt` moves on real progress.
	 *  Excluded from change notifications — the live clock paints them. */
	startedAt?: number;
	lastAdvanceAt?: number;
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

export interface RenderOptions {
	/** Current time; omitted ⇒ no elapsed/stall annotation (pure renders stay byte-identical). */
	now?: number;
	/** Quiet time after which a running row shows the stall badge; 0/omitted ⇒ never. */
	stallMs?: number;
}

/** Whether `detail` is the literal "queued" marker a seeded-but-not-yet-live leg carries — shared
 *  by `runningAnnotation` (suppresses the clock) and `telemetryStatus` (`extension.ts`, reports the
 *  `queued` state). One predicate so the two readings of the marker cannot drift apart. */
export function isQueuedMarker(detail: string | undefined): boolean {
	return detail?.trim().toLowerCase() === "queued";
}

/** "1m 15s" while a running node keeps advancing; "⚠ stalled 1m 30s" once it has been quiet
 *  for `stallMs`. Undefined for settled nodes, nodes without clock data, or a node still carrying
 *  the "queued" marker — it was seeded ahead of the concurrency gate and has not started running
 *  yet, so its clock (stamped at seed time) has nothing true to report. Pure. */
export function runningAnnotation(node: Pick<AgentNode, "status" | "startedAt" | "lastAdvanceAt" | "detail">, now: number, stallMs: number): string | undefined {
	if (node.status !== "running" || node.startedAt === undefined) return undefined;
	if (isQueuedMarker(node.detail)) return undefined;
	const quietSince = node.lastAdvanceAt ?? node.startedAt;
	if (stallMs > 0 && now - quietSince >= stallMs) return `⚠ stalled ${formatDuration(now - quietSince)}`;
	return formatDuration(now - node.startedAt);
}

/** The tree patch for one progress snapshot: every snapshot is an advance; activity wins over
 *  a bare token count as the visible detail. One helper for every progress site. */
export function progressPatch(snap: { output?: string; activity?: string; tokens?: number }, now: number): AgentNodePatch {
	const patch: AgentNodePatch = { lastAdvanceAt: now };
	if (snap.output) patch.output = snap.output;
	if (snap.activity) patch.detail = snap.activity;
	else if (snap.tokens) patch.detail = `${compactTokens(snap.tokens)} tok`;
	return patch;
}

function safeInline(value: string): string {
	return compactInlineText(value, { maxChars: 96 });
}

/** Render the tree as plain lines with ├─/└─ branches and status glyphs. Pure. */
export function renderAgentTree(nodes: AgentNode[], opts: RenderOptions = {}): string[] {
	const lines: string[] = [];
	// Build the hierarchy once. Filtering the complete node array at every recursive step made
	// wide fan-outs quadratic, exactly where progress snapshots cause the most UI activity.
	const childrenByParent = new Map<string | undefined, AgentNode[]>();
	for (const node of nodes) {
		const siblings = childrenByParent.get(node.parentId);
		if (siblings) siblings.push(node);
		else childrenByParent.set(node.parentId, [node]);
	}

	const walk = (parentId: string | undefined, prefix: string): void => {
		const kids = childrenByParent.get(parentId);
		if (!kids) return;
		kids.forEach((node, i) => {
			const isRoot = parentId === undefined;
			const isLast = i === kids.length - 1;
			const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
			const label = safeInline(node.label) || safeInline(node.id) || "agent";
			const detailText = node.detail ? safeInline(node.detail) : "";
			const clock = opts.now !== undefined ? runningAnnotation(node, opts.now, opts.stallMs ?? 0) : undefined;
			const tail = [detailText, clock].filter((s): s is string => Boolean(s)).join(" · ");
			const detail = tail ? `  ${tail}` : "";
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
export function renderAgentTreeSummary(nodes: AgentNode[], maxRows = 8, opts: RenderOptions = {}): string[] {
	const rows = renderAgentTree(nodes, opts);
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
	startedAt?: number;
	lastAdvanceAt?: number;
}

export interface AgentNodePatch {
	status?: AgentNodeStatus;
	kind?: AgentNodeKind;
	agent?: string;
	model?: string;
	detail?: string;
	output?: string;
	startedAt?: number;
	lastAdvanceAt?: number;
}

/** Apply the fields `add`'s upsert branch and `update` both accept, in place — the one place
 *  that lists them, so the two callers can never let a field drift out of sync between them. */
function applyPatch(node: AgentNode, patch: AgentNodePatch): void {
	if (patch.status) node.status = patch.status;
	if (patch.kind !== undefined) node.kind = patch.kind;
	if (patch.agent !== undefined) node.agent = patch.agent;
	if (patch.model !== undefined) node.model = patch.model;
	if (patch.detail !== undefined) node.detail = patch.detail;
	if (patch.output !== undefined) node.output = patch.output;
	if (patch.startedAt !== undefined) node.startedAt = patch.startedAt;
	if (patch.lastAdvanceAt !== undefined) node.lastAdvanceAt = patch.lastAdvanceAt;
}

/** A small mutable registry with change notification. The extension owns one. */
export class AgentTree {
	private nodes: AgentNode[] = [];
	private listeners = new Set<(change: AgentTreeChange) => void>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Insert a node, or upsert (relabel / restatus / reparent) when the id already exists. */
	add(input: AddNodeInput): void {
		const existing = this.nodes.find((n) => n.id === input.id);
		if (existing) {
			const before = { ...existing };
			existing.label = input.label;
			if (input.parentId !== undefined) existing.parentId = input.parentId;
			applyPatch(existing, input);
			if (!sameNode(before, existing)) this.emit({ type: "updated", node: { ...existing } });
			return;
		}
		const t = this.now();
		const node: AgentNode = {
			id: input.id,
			label: input.label,
			parentId: input.parentId,
			status: input.status ?? "running",
			detail: input.detail,
			startedAt: input.startedAt ?? t,
			lastAdvanceAt: input.lastAdvanceAt ?? input.startedAt ?? t,
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
		applyPatch(node, patch);
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

const CLOCK_KEYS = new Set<keyof AgentNode>(["startedAt", "lastAdvanceAt"]);
function sameNode(a: AgentNode, b: AgentNode): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof AgentNode>);
	return [...keys].every((key) => CLOCK_KEYS.has(key) || a[key] === b[key]);
}

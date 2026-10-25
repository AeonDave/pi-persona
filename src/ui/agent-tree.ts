import { compactTokens } from "../core/format.ts";
import { effortFullName, effortSigla } from "../core/leg-thinking.ts";
import { formatDuration } from "../core/time.ts";
import type { ThinkingLevel } from "../core/types.ts";
import type { ChildUsage } from "../engine/stream.ts";
import { compactInlineText } from "./presentation.ts";
import { formatUsage } from "./usage.ts";

/**
 * The unified agent tree — a single live model of *every* agent in flight,
 * regardless of how it was spawned: strategy cores (magi/fanout/critic), the
 * `delegate` tool's sub-agents, and dynamic specialists. The UI layer renders
 * one sticky tree above the input from this model, and (later) lets the user
 * drill into a node. Sources only push status/detail; rendering is pure.
 */

export type AgentNodeStatus = "running" | "done" | "failed" | "stopped";
export type AgentNodeKind = "subagent" | "delegate" | "council" | "flow" | "phase" | "monitor" | "timer";

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
	/** Requested per-leg thinking effort, known at launch (the spec-level value the launch row
	 *  carried). Rendered as the compact sigla right after the model; absent/off render nothing. */
	thinking?: ThinkingLevel;
	/** Observed effective Pi effort from the terminal result. Set ONLY from a real
	 *  AgentResult.thinkingEffective (never invented); when it diverges from `thinking`, the row
	 *  renders the honest `xh→h` form. */
	thinkingEffective?: ThinkingLevel;
	/** A short trailing annotation (usage, current activity), shown after the label. */
	detail: string | undefined;
	/** The agent's output buffer, shown when the user drills into the node. */
	output?: string;
	/** Clock data (ms since epoch). Set by the tree on add; `lastAdvanceAt` moves on real progress.
	 *  Excluded from change notifications — the live clock paints them. */
	startedAt?: number;
	lastAdvanceAt?: number;
	/** Epoch ms when a wake source is due: a monitor's deadline or a timer's fire time. Its countdown replaces the elapsed/stall clock. Set once by the source; a change notifies (it is not a clock key). */
	dueAt?: number;
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

/** A wake source is a row that is not an agent (never counted, steered, or stopped in bulk). */
export function isWakeSource(node: Pick<AgentNode, "kind">): boolean {
	return node.kind === "monitor" || node.kind === "timer";
}

/** The kind-aware glyph shared by every surface (tree, overlay): a running timer is ⏰, a running
 *  monitor ◉; everything else, settled wake rows included, uses the ordinary status glyph. */
export function nodeGlyph(node: Pick<AgentNode, "status" | "kind">): string {
	if (node.status === "running") {
		if (node.kind === "timer") return "⏰";
		if (node.kind === "monitor") return "◉";
	}
	return GLYPH[node.status];
}

export interface RenderOptions {
	/** Current time; omitted ⇒ no elapsed/stall annotation (pure renders stay byte-identical). */
	now?: number;
	/** Quiet time after which a running row shows the stall badge; 0/omitted ⇒ never. */
	stallMs?: number;
	/** Live ids whose exact engine handle currently has a pending supervisor ask. */
	waitingForSupervisor?: ReadonlySet<string>;
}

/** The frozen compact effort tag for a tree/overlay row: ` · xh` after the model, or ` · xh→h`
 *  when the terminal result reported a DIFFERENT observed effective level. `off`/absent render
 *  nothing — absence means off, and an observation is never invented: the divergence form shows
 *  only when both sides are known and genuinely differ (an observed `off` never leaves a dangling
 *  `→`). Pure. */
export function effortTag(requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	const req = requested !== undefined ? effortSigla(requested) : "";
	if (!req) return "";
	const obs = effective !== undefined ? effortSigla(effective) : "";
	return obs && obs !== req ? ` · ${req}→${obs}` : ` · ${req}`;
}

/** The F9 drill-in line for a leg's effort — FULL names, the drill-in has the room (the compact
 *  siglas live only on the rows): `thinking: requested xhigh → observed high`. Same honesty rules
 *  as {@link effortTag}; the line is omitted entirely when nothing was requested. Pure. */
export function thinkingDetailLine(requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	const req = requested !== undefined ? effortFullName(requested) : "";
	if (!req) return "";
	const obs = effective !== undefined && effective !== requested ? effortFullName(effective) : "";
	return obs ? `thinking: requested ${req} → observed ${obs}` : `thinking: requested ${req}`;
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
 *  yet, so its clock (stamped at seed time) has nothing true to report. A wake-source row (one with
 *  a `dueAt`) counts down instead — "fires in 49m 12s" for a timer, "12m 3s · deadline in 1h 47m"
 *  for a monitor — and NEVER shows the stall badge: a quiet monitor is waiting for its event,
 *  not stalled. Pure. */
export function runningAnnotation(node: Pick<AgentNode, "status" | "startedAt" | "lastAdvanceAt" | "detail" | "kind" | "dueAt">, now: number, stallMs: number, waitingForSupervisor = false): string | undefined {
	if (node.status !== "running" || node.startedAt === undefined) return undefined;
	if (isQueuedMarker(node.detail)) return undefined;
	if (waitingForSupervisor) return "waiting for supervisor";
	if (node.dueAt !== undefined) {
		const left = node.dueAt - now;
		if (node.kind === "timer") return left > 0 ? `fires in ${formatDuration(left)}` : "firing…";
		const elapsed = formatDuration(now - node.startedAt);
		return left > 0 ? `${elapsed} · deadline in ${formatDuration(left)}` : `${elapsed} · deadline reached`;
	}
	const quietSince = node.lastAdvanceAt ?? node.startedAt;
	if (stallMs > 0 && now - quietSince >= stallMs) return `⚠ stalled ${formatDuration(now - quietSince)}`;
	return formatDuration(now - node.startedAt);
}

/** Derive waiting rows from exact live-handle predicates. A running parent is waiting only when
 * every live leaf below it is waiting; a progressing or stalled sibling keeps the parent honest. */
export function deriveWaitingNodeIds(nodes: readonly AgentNode[], isWaiting: (id: string) => boolean): Set<string> {
	const children = new Map<string, AgentNode[]>();
	for (const node of nodes) {
		if (node.parentId === undefined) continue;
		const list = children.get(node.parentId) ?? [];
		list.push(node);
		children.set(node.parentId, list);
	}
	const waitingLeaves = new Map<string, { hasLive: boolean; allWaiting: boolean }>();
	const visit = (node: AgentNode): { hasLive: boolean; allWaiting: boolean } => {
		if (node.status === "running" && isQueuedMarker(node.detail)) return { hasLive: false, allWaiting: false };
		const descendants = (children.get(node.id) ?? []).map(visit).filter((state) => state.hasLive);
		if (node.status !== "running") return { hasLive: descendants.length > 0, allWaiting: descendants.every((state) => state.allWaiting) };
		if (descendants.length === 0) {
			const waiting = isWaiting(node.id);
			if (waiting) waitingLeaves.set(node.id, { hasLive: true, allWaiting: true });
			return { hasLive: true, allWaiting: waiting };
		}
		const allWaiting = descendants.every((state) => state.allWaiting);
		if (allWaiting) waitingLeaves.set(node.id, { hasLive: true, allWaiting: true });
		return { hasLive: true, allWaiting };
	};
	for (const node of nodes) if (node.parentId === undefined) visit(node);
	return new Set(waitingLeaves.keys());
}

/** The tree patch for one progress snapshot: every snapshot is an advance; activity wins over
 *  usage, formatted like a completed row. Legacy aggregate-only progress stays a neutral count. */
export function progressPatch(snap: { output?: string; activity?: string; tokens?: number; usage?: ChildUsage }, now: number): AgentNodePatch {
	const patch: AgentNodePatch = { lastAdvanceAt: now };
	if (snap.output) patch.output = snap.output;
	if (snap.activity) patch.detail = snap.activity;
	else if (snap.usage) patch.detail = formatUsage(snap.usage);
	else if (snap.tokens) patch.detail = compactTokens(snap.tokens);
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
			const base = safeInline(node.label) || safeInline(node.id) || "agent";
			// The compact effort sigla rides AFTER the label clamp — the existing per-part clipping is
			// untouched; the appended field is at most ` · xh→h` wide.
			const label = `${base}${effortTag(node.thinking, node.thinkingEffective)}`;
			const detailText = node.detail ? safeInline(node.detail) : "";
			const clock = opts.now !== undefined ? runningAnnotation(node, opts.now, opts.stallMs ?? 0, opts.waitingForSupervisor?.has(node.id) ?? false) : undefined;
			const tail = [detailText, clock].filter((s): s is string => Boolean(s)).join(" · ");
			const detail = tail ? `  ${tail}` : "";
			lines.push(`${prefix}${branch}${nodeGlyph(node)} ${label}${detail}`);
			const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
			walk(node.id, childPrefix);
		});
	};

	walk(undefined, "");
	return lines;
}

/** One digest line for the running wake sources (monitors, timers) that fell below the summary
 *  fold: counts by kind ("◉ 1 monitor · ⏰ 2 timers"), plus the countdown to the soonest finite
 *  `dueAt` when a clock is given. A monitor armed after a fan-out would otherwise hide behind the
 *  "… +N more" line — exactly the "armed but nothing visible" case wake rows exist to fix. Pure. */
function wakeDigestLine(hidden: readonly AgentNode[], now: number | undefined): string {
	const monitors = hidden.filter((node) => node.kind === "monitor").length;
	const timers = hidden.filter((node) => node.kind === "timer").length;
	const parts: string[] = [];
	if (monitors > 0) parts.push(`${nodeGlyph({ status: "running", kind: "monitor" })} ${monitors} monitor${monitors === 1 ? "" : "s"}`);
	if (timers > 0) parts.push(`${nodeGlyph({ status: "running", kind: "timer" })} ${timers} timer${timers === 1 ? "" : "s"}`);
	if (now !== undefined) {
		const due = hidden.map((node) => node.dueAt).filter((at): at is number => at !== undefined && Number.isFinite(at));
		if (due.length > 0) {
			const left = Math.min(...due) - now;
			parts.push(left > 0 ? `next due in ${formatDuration(left)}` : "next due now");
		}
	}
	return parts.join(" · ");
}

/**
 * Bounded above-editor digest. Large fan-outs belong in the scrollable F9
 * overlay; they must not push the editor and conversation off the screen.
 *
 * Below the fold, two kinds of row stay visible as one line each, because an operator must not
 * have to open F9 to learn them: failures (`✗ N failed: …`) and RUNNING wake sources (`◉ 1 monitor
 * · ⏰ 2 timers · next due in 4m 12s`). The layout when overflowing is
 * `[...rows, failureLine?, wakeDigest?, overflowLine]`, every line inside `maxRows`; when the budget
 * cannot hold them all the lowest-priority line goes first (failure > wake digest > overflow).
 */
export function renderAgentTreeSummary(nodes: AgentNode[], maxRows = 8, opts: RenderOptions = {}): string[] {
	const rows = renderAgentTree(nodes, opts);
	const limit = Math.max(1, Math.floor(maxRows));
	if (rows.length <= limit) return rows;
	let failureLine: string | undefined;
	const failed = nodes.filter((node) => node.status === "failed");
	if (failed.length > 0) {
		const names = failed.slice(0, 2).map((node) => {
			const label = safeInline(node.label) || "agent";
			const detail = node.detail ? safeInline(node.detail) : "";
			return detail ? `${label} (${detail})` : label;
		});
		const extra = failed.length - names.length;
		failureLine = `✗ ${failed.length} failed: ${names.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
	}
	// `flattenTree(nodes)[i]` is the node behind `rows[i]`: `renderAgentTree` and `flattenTree` walk the
	// same parent→children order, so a row's flat index doubles as its position in the rendered list.
	const flat = flattenTree(nodes);
	const hiddenWake = (from: number): AgentNode[] =>
		flat.slice(from).map((row) => row.node).filter((node) => isWakeSource(node) && node.status === "running");
	let visibleCount = Math.max(0, limit - (failureLine !== undefined ? 2 : 1));
	let hidden = hiddenWake(visibleCount);
	if (hidden.length > 0) {
		// The digest takes a slot of its own; one fewer visible row can only hide more wake rows.
		visibleCount = Math.max(0, visibleCount - 1);
		hidden = hiddenWake(visibleCount);
	}
	const tail = [
		...(failureLine !== undefined ? [failureLine] : []),
		...(hidden.length > 0 ? [wakeDigestLine(hidden, opts.now)] : []),
		`… +${rows.length - visibleCount} more · F9 or /agents for the full live tree`,
	];
	return [...rows.slice(0, visibleCount), ...tail.slice(0, Math.max(0, limit - visibleCount))];
}

export interface AddNodeInput {
	id: string;
	label: string;
	parentId?: string;
	status?: AgentNodeStatus;
	kind?: AgentNodeKind;
	agent?: string;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	thinkingEffective?: ThinkingLevel | undefined;
	detail?: string;
	output?: string;
	startedAt?: number;
	lastAdvanceAt?: number;
	dueAt?: number;
}

export interface AgentNodePatch {
	status?: AgentNodeStatus;
	kind?: AgentNodeKind;
	agent?: string;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	thinkingEffective?: ThinkingLevel | undefined;
	detail?: string;
	output?: string;
	startedAt?: number;
	lastAdvanceAt?: number;
	dueAt?: number;
}

/** Apply the fields `add`'s upsert branch and `update` both accept, in place — the one place
 *  that lists them, so the two callers can never let a field drift out of sync between them. */
function applyPatch(node: AgentNode, patch: AgentNodePatch): void {
	if (patch.status) node.status = patch.status;
	if (patch.kind !== undefined) node.kind = patch.kind;
	if (patch.agent !== undefined) node.agent = patch.agent;
	// Omission preserves metadata; explicit undefined clears a previous attempt's intent/observation.
	if (Object.hasOwn(patch, "model")) {
		if (patch.model === undefined) delete node.model;
		else node.model = patch.model;
	}
	if (Object.hasOwn(patch, "thinking")) {
		if (patch.thinking === undefined) delete node.thinking;
		else node.thinking = patch.thinking;
	}
	if (Object.hasOwn(patch, "thinkingEffective")) {
		if (patch.thinkingEffective === undefined) delete node.thinkingEffective;
		else node.thinkingEffective = patch.thinkingEffective;
	}
	if (patch.detail !== undefined) node.detail = patch.detail;
	if (patch.output !== undefined) node.output = patch.output;
	if (patch.startedAt !== undefined) node.startedAt = patch.startedAt;
	if (patch.lastAdvanceAt !== undefined) node.lastAdvanceAt = patch.lastAdvanceAt;
	if (patch.dueAt !== undefined) node.dueAt = patch.dueAt;
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
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
			...(input.thinkingEffective !== undefined ? { thinkingEffective: input.thinkingEffective } : {}),
			...(input.output !== undefined ? { output: input.output } : {}),
			...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
		};
		this.nodes.push(node);
		this.emit({ type: "added", node: { ...node } });
	}

	update(id: string, patch: AgentNodePatch): void {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		// Parent progress clocks are refreshed on every child tick. They never emit a change;
		// avoid cloning/comparing the whole node for that common clock-only path.
		if (Object.keys(patch).every((key) => CLOCK_KEYS.has(key as keyof AgentNode))) {
			applyPatch(node, patch);
			return;
		}
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

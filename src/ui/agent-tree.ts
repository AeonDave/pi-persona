import { compactTokens } from "../core/format.ts";
import { formatDuration } from "../core/time.ts";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
import type { WorkerChatSnapshot } from "../core/worker-chat.ts";
import type { ChildUsage } from "../engine/stream.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { summarizeFailure } from "./failure-summary.ts";
import { effortText } from "./model-effort.ts";
import { compactInlineText } from "./presentation.ts";
import { type RowSpan, rowText, type StyledRow } from "./styled-row.ts";
import { formatUsage } from "./usage.ts";

/**
 * The unified agent tree — a single live model of *every* agent in flight,
 * regardless of how it was spawned: strategy cores (magi/fanout/critic), the
 * `delegate` tool's sub-agents, and dynamic specialists. The UI layer renders
 * one sticky tree above the input and the navigable F9 detail views from this
 * model. Sources push observed state; rendering is pure.
 */

export type AgentNodeStatus = "running" | "done" | "failed" | "stopped";
export type AgentNodeKind = "subagent" | "delegate" | "council" | "flow" | "phase" | "monitor" | "timer" | "script" | "resource-group" | "peer" | "activity";

export interface AgentNode {
	id: string;
	label: string;
	parentId: string | undefined;
	status: AgentNodeStatus;
	/** Semantic role in the orchestration graph; absent on untyped presentation rows. */
	kind?: AgentNodeKind;
	/** Configured agent definition (operator/reviewer/…), if known. */
	agent?: string;
	model?: string;
	/** Requested per-leg thinking effort, known at launch (what the launch card showed). Rendered
	 *  by {@link effortTag} right after the model; absent renders nothing. */
	thinking?: ThinkingLevel;
	/** Observed effective Pi effort from the terminal result. Set ONLY from a real
	 *  AgentResult.thinkingEffective (never invented); when it diverges from `thinking`, the row
	 *  renders the honest `xhigh→high` form. */
	thinkingEffective?: ThinkingLevel;
	/** Latest cumulative usage snapshot, retained independently from the compact row detail. */
	usage?: ChildUsage;
	/** A short trailing annotation (usage, current activity), shown after the label. */
	detail: string | undefined;
	/** The agent's output buffer, shown when the user drills into the node. */
	output?: string;
	/** Bounded, immutable UI-only conversation; never a progress or control authority. */
	chat?: WorkerChatSnapshot;
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
	return node.kind === "monitor" || node.kind === "timer" || node.kind === "script";
}

/** Local companion work shares the view but is neither an agent nor a wake source. */
export function isNonAgentNode(node: Pick<AgentNode, "kind">): boolean {
	return isWakeSource(node) || node.kind === "activity" || node.kind === "resource-group" || node.kind === "peer";
}

type CountedNode = { id: string; parentId?: string | undefined; status: AgentNodeStatus; kind?: NonNullable<AgentNode["kind"]> };

/** Agents actually IN FLIGHT: a RUNNING node with no children of its own. "Has a parent" is not the
 *  same as "is an agent" — a flow phase is a container that also has a parent, a root-level `async:`
 *  run is a leaf that has none, and a settled leg still sits in the tree until its root is torn
 *  down. A fan-out's `delegate` header row is a container even in the beat after its last leg
 *  left, so it never counts. A wake source (a timer or monitor row) is not an agent at all and
 *  never counts, running or not. */
export function inFlightAgentCount(nodes: ReadonlyArray<CountedNode>): number {
	const parents = new Set<string>();
	for (const node of nodes) {
		if (node.parentId !== undefined) parents.add(node.parentId);
	}
	let count = 0;
	for (const node of nodes) {
		if (node.status === "running" && node.kind !== "delegate" && !isNonAgentNode(node) && !parents.has(node.id)) count++;
	}
	return count;
}

/** Extension status key owned by pi-persona: everything that will report back later. */
export const PERSONA_BACKGROUND_STATUS_KEY = "persona-background";

export interface BackgroundCounts {
	agents: number;
	monitors: number;
	timers: number;
	scripts: number;
}

/** In-flight agents (as `inFlightAgentCount` over the agent nodes alone — local companion work,
 *  wake rows and synthetic groups never shape the agent leaves) plus the running wake sources by
 *  kind: armed timers, active monitors, active scripts. Settled wake rows do not count. */
export function backgroundCounts(nodes: ReadonlyArray<CountedNode>): BackgroundCounts {
	const counts: BackgroundCounts = { agents: inFlightAgentCount(nodes.filter((node) => !isNonAgentNode(node))), monitors: 0, timers: 0, scripts: 0 };
	for (const node of nodes) {
		if (node.status !== "running") continue;
		if (node.kind === "monitor") counts.monitors++;
		else if (node.kind === "timer") counts.timers++;
		else if (node.kind === "script") counts.scripts++;
	}
	return counts;
}

const BACKGROUND_ORDER = ["agents", "monitors", "timers", "scripts"] as const;

/** `agents=2 monitors=1 timers=1 scripts=1` in that fixed order, zero counts omitted;
 *  `undefined` (clears the status) when nothing is in the background. */
export function formatBackgroundStatus(counts: BackgroundCounts): string | undefined {
	const parts = BACKGROUND_ORDER.filter((kind) => counts[kind] > 0).map((kind) => `${kind}=${counts[kind]}`);
	return parts.length === 0 ? undefined : parts.join(" ");
}

/** The kind-aware glyph shared by every surface (tree, overlay): a running timer is ⏰, a running
 *  monitor ◉; everything else, settled wake rows included, uses the ordinary status glyph. */
export function nodeGlyph(node: Pick<AgentNode, "status" | "kind">): string {
	if (node.status === "running") {
		if (node.kind === "activity") return "◈";
		if (node.kind === "timer") return "⏰";
		if (node.kind === "monitor") return "◉";
		if (node.kind === "script") return "⚙";
		if (node.kind === "resource-group") return "◆";
		if (node.kind === "peer") return "◉";
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
	/** Attention parts leading a row's tail (a folded batch's `1 failed`/`1 stalled`), by node id.
	 *  Rendered before the detail in the warning token and kept when the widget clips. */
	alerts?: ReadonlyMap<string, readonly string[]>;
}

/** The effort segment a row appends after a label that already carries the model: ` · medium`,
 *  ` · xhigh→high` on divergence, nothing when unknown — {@link effortText}'s rule. Pure. */
export function effortTag(requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	const text = effortText(requested, effective);
	return text ? ` · ${text}` : "";
}

/** The F9 drill-in line naming both sides explicitly: `thinking: requested xhigh → observed high`.
 *  Same honesty rules as {@link effortText}; omitted entirely when neither side is known. Pure. */
export function thinkingDetailLine(requested: ThinkingLevel | undefined, effective?: ThinkingLevel): string {
	const req = isThinkingLevel(requested) ? requested : undefined;
	const obs = isThinkingLevel(effective) && effective !== req ? effective : undefined;
	if (req === undefined) return obs === undefined ? "" : `thinking: observed ${obs}`;
	return obs === undefined ? `thinking: requested ${req}` : `thinking: requested ${req} → observed ${obs}`;
}

/** Whether `detail` is the literal "queued" marker a seeded-but-not-yet-live leg carries — shared
 *  by `runningAnnotation` (suppresses the clock) and `telemetryStatus` (`extension.ts`, reports the
 *  `queued` state). One predicate so the two readings of the marker cannot drift apart. */
export function isQueuedMarker(detail: string | undefined): boolean {
	return detail?.trim().toLowerCase() === "queued";
}

/** Runtime stall state shared by individual rows and folded group summaries. */
export function isStalledNode(node: Pick<AgentNode, "status" | "startedAt" | "lastAdvanceAt" | "detail" | "kind" | "dueAt">, now: number, stallMs: number, waitingForSupervisor = false): boolean {
	if (node.status !== "running" || node.startedAt === undefined || isQueuedMarker(node.detail) || waitingForSupervisor || node.dueAt !== undefined) return false;
	if (node.kind === "resource-group" || node.kind === "peer" || node.kind === "activity" || node.kind === "script") return false;
	return stallMs > 0 && now - (node.lastAdvanceAt ?? node.startedAt) >= stallMs;
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
	if (node.kind === "resource-group" || node.kind === "peer") return undefined;
	if (node.kind === "activity" || node.kind === "script") return formatDuration(now - node.startedAt);
	if (waitingForSupervisor) return "waiting for supervisor";
	if (node.dueAt !== undefined) {
		const left = node.dueAt - now;
		if (node.kind === "timer") return left > 0 ? `fires in ${formatDuration(left)}` : "firing…";
		const elapsed = formatDuration(now - node.startedAt);
		return left > 0 ? `${elapsed} · deadline in ${formatDuration(left)}` : `${elapsed} · deadline reached`;
	}
	const quietSince = node.lastAdvanceAt ?? node.startedAt;
	if (isStalledNode(node, now, stallMs, waitingForSupervisor)) return `⚠ stalled ${formatDuration(now - quietSince)}`;
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

/** Every snapshot advances the clock. Compact activity wins over usage while the detailed
 *  usage snapshot remains available independently. Aggregate-only progress stays a neutral count. */
export function progressPatch(snap: { output?: string; activity?: string; tokens?: number; usage?: ChildUsage; chat?: WorkerChatSnapshot }, now: number): AgentNodePatch {
	const patch: AgentNodePatch = { lastAdvanceAt: now };
	if (snap.output) patch.output = snap.output;
	if (snap.chat !== undefined) patch.chat = snap.chat;
	if (snap.usage !== undefined) patch.usage = { ...snap.usage };
	if (snap.activity) patch.detail = snap.activity;
	else if (snap.usage) patch.detail = formatUsage(snap.usage);
	else if (snap.tokens) patch.detail = compactTokens(snap.tokens);
	return patch;
}

function safeInline(value: string): string {
	return compactInlineText(value, { maxChars: 96 });
}

export function compactNodeDetail(node: AgentNode, maxChars = 96): string {
	if (!node.detail) return "";
	const detail = node.status === "failed" && !isNonAgentNode(node) ? summarizeFailure(node.detail, node.agent) : node.detail;
	return compactInlineText(detail, { maxChars });
}

/** Shorter bounded text for one-line digest representatives. */
function safeDigestInline(value: string): string {
	return compactInlineText(value, { maxChars: 48 });
}

/** Status → theme token for a row's glyph: settled states use their state tokens. */
function glyphToken(node: Pick<AgentNode, "status">): ThemeColor {
	if (node.status === "done") return "success";
	if (node.status === "failed") return "error";
	if (node.status === "stopped") return "muted";
	return "accent";
}

/** Join tail parts with dim ` · ` separators; a kept part keeps its separator with it. */
function joinParts(parts: readonly RowSpan[]): RowSpan[] {
	return parts.flatMap((part, index) => index === 0 ? [part] : [{ text: " · ", token: "dim" as const, ...(part.keep ? { keep: true } : {}) }, part]);
}

/** Render the tree as styled spans with ├─/└─ branches: connectors dim, names text, effort and detail muted,
 *  glyphs and attention flags in their state tokens. `rowText` of each row is the plain line. Pure. */
export function renderAgentTreeRows(nodes: AgentNode[], opts: RenderOptions = {}): StyledRow[] {
	const lines: StyledRow[] = [];
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
			// The effort rides AFTER the label clamp — the existing per-part clipping is untouched;
			// the appended field is at most ` · minimal→xhigh` wide.
			const effort = effortTag(node.thinking, node.thinkingEffective);
			const detailText = compactNodeDetail(node);
			const waiting = opts.waitingForSupervisor?.has(node.id) ?? false;
			const clock = opts.now !== undefined ? runningAnnotation(node, opts.now, opts.stallMs ?? 0, waiting) : undefined;
			const flagged = clock !== undefined && opts.now !== undefined && node.status === "running"
				&& (waiting || isStalledNode(node, opts.now, opts.stallMs ?? 0, waiting));
			const tail: RowSpan[] = [
				...(opts.alerts?.get(node.id) ?? []).map((alert): RowSpan => ({ text: safeInline(alert), token: "warning", keep: true })),
				...(detailText ? [{ text: detailText, token: "muted" as const }] : []),
				...(clock ? [flagged ? { text: clock, token: "warning" as const, keep: true } : { text: clock, token: "muted" as const }] : []),
			];
			const row: RowSpan[] = [
				...(prefix || branch ? [{ text: `${prefix}${branch}`, token: "dim" as const }] : []),
				{ text: nodeGlyph(node), token: glyphToken(node) },
				{ text: ` ${base}`, token: "text" },
				...(effort ? [{ text: effort, token: "muted" as const }] : []),
				// A kept first tail part keeps its gap too, so a clipped row never glues the flag to the ellipsis.
				...(tail.length > 0 ? [{ text: "  ", token: "dim" as const, ...(tail[0]!.keep ? { keep: true } : {}) }, ...joinParts(tail)] : []),
			];
			lines.push(row);
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
function wakeDigestLine(hidden: readonly AgentNode[], now: number | undefined): StyledRow {
	const parts: RowSpan[][] = [];
	const activities = hidden.filter((node) => node.kind === "activity");
	if (activities.length > 0) {
		parts.push([{ text: "◈", token: "accent" }, { text: " mind", token: "text" }]);
		parts.push([{ text: safeInline(activities[activities.length - 1]!.detail ?? "local memory work"), token: "muted" }]);
	}
	for (const kind of ["monitor", "timer", "script"] as const) {
		const count = hidden.filter((node) => node.kind === kind).length;
		if (count > 0) parts.push([{ text: nodeGlyph({ status: "running", kind }), token: "accent" }, { text: ` ${count} ${kind}${count === 1 ? "" : "s"}`, token: "text" }]);
	}
	if (now !== undefined) {
		const due = hidden.map((node) => node.dueAt).filter((at): at is number => at !== undefined && Number.isFinite(at));
		if (due.length > 0) {
			const left = Math.min(...due) - now;
			parts.push([{ text: left > 0 ? `next due in ${formatDuration(left)}` : "next due now", token: "muted" }]);
		}
	}
	return parts.flatMap((part, index) => index === 0 ? part : [{ text: " · ", token: "dim" as const }, ...part]);
}

/** A worker is an agent leaf; an untyped parent is still a container. */
function isWorkerNode(node: AgentNode, parents: ReadonlySet<string>): boolean {
	return !parents.has(node.id) && !isNonAgentNode(node) && node.kind !== "delegate"
		&& node.kind !== "council" && node.kind !== "flow" && node.kind !== "phase";
}

type DigestLine = { spans: StyledRow; compactSpans: StyledRow };

/** A digest's representative reads like its own row would: the label, then its effort. */
function digestRepresentative(node: AgentNode): RowSpan[] {
	const identity = safeDigestInline(node.label) || safeDigestInline(node.agent ?? "") || safeDigestInline(node.id) || "worker";
	const effort = effortTag(node.thinking, node.thinkingEffective);
	return [{ text: `: ${identity}`, token: "text" }, ...(effort ? [{ text: effort, token: "muted" as const }] : [])];
}

function waitingDigestLine(hidden: readonly AgentNode[], parents: ReadonlySet<string>, waitingForSupervisor: ReadonlySet<string> | undefined): DigestLine | undefined {
	if (!waitingForSupervisor) return undefined;
	const waiting = hidden.filter((node) => node.status === "running" && isWorkerNode(node, parents) && !isQueuedMarker(node.detail) && waitingForSupervisor.has(node.id));
	if (waiting.length === 0) return undefined;
	const compact: RowSpan = { text: `? ${waiting.length} waiting for supervisor`, token: "warning", keep: true };
	return { spans: [compact, ...digestRepresentative(waiting[0]!)], compactSpans: [compact] };
}

/** A hidden running worker past the stall window: its own digest, so truncation never turns a
 *  stalled leg into an ordinary active one. Waiting workers are reported as waiting instead. */
function isHiddenStalledWorker(node: AgentNode, parents: ReadonlySet<string>, opts: RenderOptions): boolean {
	return opts.now !== undefined && isWorkerNode(node, parents) && !opts.waitingForSupervisor?.has(node.id)
		&& isStalledNode(node, opts.now, opts.stallMs ?? 0);
}

function stalledDigestLine(hidden: readonly AgentNode[], parents: ReadonlySet<string>, opts: RenderOptions): DigestLine | undefined {
	const stalled = hidden.filter((node) => isHiddenStalledWorker(node, parents, opts));
	if (stalled.length === 0) return undefined;
	const compact: RowSpan = { text: `⚠ ${stalled.length} stalled`, token: "warning", keep: true };
	return { spans: [compact, ...digestRepresentative(stalled[0]!)], compactSpans: [compact] };
}

/** Counts only hidden running workers and uses the first one in tree order as a stable representative. */
function activeWorkerDigestLine(hidden: readonly AgentNode[], parents: ReadonlySet<string>, opts: RenderOptions): DigestLine | undefined {
	const workers = hidden.filter((node) => node.status === "running" && isWorkerNode(node, parents)
		&& !isQueuedMarker(node.detail) && !opts.waitingForSupervisor?.has(node.id) && !isHiddenStalledWorker(node, parents, opts));
	if (workers.length === 0) return undefined;
	const representative = workers[0]!;
	const detail = representative.detail ? safeDigestInline(representative.detail) : "";
	const glyph: RowSpan = { text: nodeGlyph({ status: "running", kind: "subagent" }), token: "accent" };
	const count: RowSpan = { text: ` ${workers.length} active worker${workers.length === 1 ? "" : "s"}`, token: "text" };
	return {
		spans: [glyph, count, ...digestRepresentative(representative), ...(detail ? [{ text: " · ", token: "dim" as const }, { text: detail, token: "muted" as const }] : [])],
		compactSpans: [glyph, count],
	};
}

function summaryRow(kind: AgentSummaryRow["kind"], spans: StyledRow, compactSpans: StyledRow = spans, nodeId?: string): AgentSummaryRow {
	return { kind, text: rowText(spans), compact: rowText(compactSpans), spans, compactSpans, ...(nodeId !== undefined ? { nodeId } : {}) };
}

/**
 * Bounded above-editor digest. Large fan-outs belong in the scrollable F9
 * overlay; they must not push the editor and conversation off the screen.
 *
 * Below the fold, critical failures, truthful waiting-for-supervisor workers, stalled workers,
 * wake/activity rows, and active workers stay represented in a stable tree order. The overflow
 * hint has the lowest priority, and every line stays inside `maxRows`.
 */
export interface AgentSummaryRow {
	kind: "node" | "failure" | "waiting" | "stalled" | "wake" | "active" | "overflow";
	text: string;
	/** Concise equivalent for combining this row with other essential signals. */
	compact: string;
	/** `text` / `compact` as themed spans; `rowText(spans) === text`. */
	spans: StyledRow;
	compactSpans: StyledRow;
	nodeId?: string;
}

/** Build digest rows from the actual hidden nodes, regardless of how visible rows were chosen. */
export function projectAgentTreeDigests(nodes: AgentNode[], hidden: readonly AgentNode[], opts: RenderOptions = {}): AgentSummaryRow[] {
	let failureLine: DigestLine | undefined;
	const failed = nodes.filter((node) => node.status === "failed");
	if (failed.length > 0) {
		const names = failed.slice(0, 2).map((node) => {
			const label = safeInline(node.label) || "agent";
			const detail = compactNodeDetail(node);
			return detail ? `${label} (${detail})` : label;
		});
		const extra = failed.length - names.length;
		const compact: RowSpan = { text: `✗ ${failed.length} failed`, token: "error", keep: true };
		failureLine = { spans: [compact, { text: `: ${names.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`, token: "text" }], compactSpans: [compact] };
	}
	const parents = new Set(nodes.flatMap((node) => node.parentId === undefined ? [] : [node.parentId]));
	const hiddenWake = hidden.filter((node) => node.kind === "activity" || (isWakeSource(node) && node.status === "running"));
	const wakeLine = hiddenWake.length > 0 ? wakeDigestLine(hiddenWake, opts.now) : undefined;
	const waitingLine = waitingDigestLine(hidden, parents, opts.waitingForSupervisor);
	const stalledLine = stalledDigestLine(hidden, parents, opts);
	const activeLine = activeWorkerDigestLine(hidden, parents, opts);
	return [
		...(failureLine !== undefined ? [summaryRow("failure", failureLine.spans, failureLine.compactSpans)] : []),
		...(waitingLine !== undefined ? [summaryRow("waiting", waitingLine.spans, waitingLine.compactSpans)] : []),
		...(stalledLine !== undefined ? [summaryRow("stalled", stalledLine.spans, stalledLine.compactSpans)] : []),
		...(wakeLine !== undefined ? [summaryRow("wake", wakeLine)] : []),
		...(activeLine !== undefined ? [summaryRow("active", activeLine.spans, activeLine.compactSpans)] : []),
	];
}

/** A presentation group header (Timers/Monitors/Scripts) shown without any of its children only
 *  restates what the wake digest already counts; it yields its row to legs. */
function isOrphanGroupHeader(item: AgentSummaryRow, flat: readonly FlatRow[], visible: ReadonlySet<string>): boolean {
	if (item.kind !== "node" || !item.nodeId) return false;
	const id = item.nodeId;
	const children = flat.filter((row) => row.node.parentId === id);
	return children.length > 0 && flat.some((row) => row.node.id === id && row.node.kind === "resource-group")
		&& !children.some((row) => visible.has(row.node.id));
}

/** Tree rows first, in tree order, then digests in priority order — reservations never shuffle. */
function orderSummary(result: AgentSummaryRow[], flat: readonly FlatRow[]): AgentSummaryRow[] {
	const order = new Map(flat.map((row, index) => [row.node.id, index]));
	const priority: Record<AgentSummaryRow["kind"], number> = { node: -1, failure: 0, waiting: 1, stalled: 2, wake: 3, active: 4, overflow: 5 };
	return result.map((item, index) => ({ item, index })).sort((a, b) => {
		const ka = a.item.kind === "node" ? (order.get(a.item.nodeId ?? "") ?? a.index) : Number.POSITIVE_INFINITY;
		const kb = b.item.kind === "node" ? (order.get(b.item.nodeId ?? "") ?? b.index) : Number.POSITIVE_INFINITY;
		return ka !== kb ? ka - kb : priority[a.item.kind] - priority[b.item.kind] || a.index - b.index;
	}).map(({ item }) => item);
}

export function projectAgentTreeSummary(nodes: AgentNode[], maxRows = 8, opts: RenderOptions = {}, preferredIds: readonly string[] = []): AgentSummaryRow[] {
	const rows = renderAgentTreeRows(nodes, opts);
	const flat = flattenTree(nodes);
	const limit = Math.max(1, Math.floor(maxRows));
	const nodeRow = (index: number): AgentSummaryRow => summaryRow("node", rows[index]!, rows[index]!, flat[index]?.node.id);
	const visibleRows = (count: number): AgentSummaryRow[] => rows.slice(0, count).map((_, index) => nodeRow(index));
	if (rows.length <= limit) return visibleRows(rows.length);
	const summaryLines = (visibleCount: number): AgentSummaryRow[] => projectAgentTreeDigests(nodes, flat.slice(visibleCount).map((row) => row.node), opts);
	let visibleCount = Math.max(0, limit - 1);
	// Digest rows can expose more hidden categories as the visible prefix shrinks. The candidate
	// set only grows, and there are five bounded digest kinds, so this reaches a fixed point quickly.
	for (let pass = 0; pass < 7; pass++) {
		const selected = summaryLines(visibleCount).slice(0, limit);
		const hasOverflow = selected.length < limit;
		const nextVisibleCount = Math.max(0, limit - selected.length - (hasOverflow ? 1 : 0));
		if (nextVisibleCount === visibleCount) break;
		visibleCount = nextVisibleCount;
	}
	// A prefix ending on a group header whose children all fall below the fold would only restate
	// the wake digest (a header is never counted by a digest, so the digests do not change).
	while (visibleCount > 0 && flat[visibleCount - 1]!.node.kind === "resource-group" && flat[visibleCount]?.node.parentId === flat[visibleCount - 1]!.node.id) visibleCount--;
	const selected = summaryLines(visibleCount).slice(0, limit);
	const tail = [...selected, ...(selected.length < limit ? [overflowRow(rows.length - visibleCount)] : [])];
	const result = [...visibleRows(visibleCount), ...tail];
	// An expanded delegate header drawn with none of its legs reads as an expansion that shows
	// nothing. When every digest still fits, keep one leg under it — a failed, stalled or waiting
	// leg first; otherwise the header stays alone as the batch's fold control.
	const withDelegateLegs = (selection: AgentSummaryRow[]): AgentSummaryRow[] => {
		let current = selection;
		for (const header of flat) {
			if (header.node.kind !== "delegate") continue;
			const visible = new Set(current.flatMap((item) => item.kind === "node" && item.nodeId ? [item.nodeId] : []));
			if (!visible.has(header.node.id)) continue;
			const legs = flat.filter((row) => row.node.parentId === header.node.id).map((row) => row.node);
			if (legs.length === 0 || legs.some((leg) => visible.has(leg.id))) continue;
			const rank = (leg: AgentNode): number => leg.status === "failed" ? 0
				: opts.now !== undefined && leg.status === "running" && isStalledNode(leg, opts.now, opts.stallMs ?? 0, opts.waitingForSupervisor?.has(leg.id)) ? 1
					: opts.waitingForSupervisor?.has(leg.id) && leg.status === "running" ? 2 : 3;
			for (const leg of [...legs].sort((a, b) => rank(a) - rank(b))) {
				const ids = new Set([...visible, leg.id]);
				const nodeRows = flat.flatMap((row, index) => ids.has(row.node.id) ? [nodeRow(index)] : [])
					.filter((item) => !isOrphanGroupHeader(item, flat, ids));
				const digests = projectAgentTreeDigests(nodes, flat.filter((row) => !ids.has(row.node.id)).map((row) => row.node), opts);
				if (nodeRows.length + digests.length > limit) continue;
				const room = nodeRows.length + digests.length < limit && nodeRows.length < rows.length;
				current = [...nodeRows, ...digests, ...(room ? [overflowRow(0)] : [])];
				break;
			}
		}
		return current;
	};
	if (preferredIds.length === 0) return orderSummary(countOverflow(withDelegateLegs(result), rows.length), flat);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const visibleNode = (id: string): AgentSummaryRow | undefined => {
		const index = flat.findIndex((row) => row.node.id === id);
		return index < 0 ? undefined : nodeRow(index);
	};
	const replaceable = (item: AgentSummaryRow): boolean => {
		if (item.kind !== "node" || !item.nodeId) return false;
		const node = nodeById.get(item.nodeId);
		return node?.status !== "failed" && !opts.waitingForSupervisor?.has(item.nodeId)
			&& !(node && opts.now !== undefined && isStalledNode(node, opts.now, opts.stallMs ?? 0));
	};
	for (const id of [...preferredIds].reverse()) {
		if (result.some((item) => item.nodeId === id)) continue;
		const desired = visibleNode(id);
		// A row a folded header left free takes the reservation before any visible row is displaced.
		if (desired && result.length < limit) { result.push(desired); continue; }
		const index = result.findLastIndex((item) => replaceable(item) && !preferredIds.includes(item.nodeId!));
		if (desired && index >= 0) result[index] = desired;
	}
	// Reconcile the canonical digest priorities against the final visible IDs. A reservation
	// can reveal a new digest kind; make room by dropping overflow, then a preferred control,
	// then a lower-priority digest. Recompute whenever a visible node is displaced.
	const priority: Partial<Record<AgentSummaryRow["kind"], number>> = { failure: 0, waiting: 1, stalled: 2, wake: 3, active: 4, overflow: 5 };
	for (let pass = 0; pass < limit * 5 + 5; pass++) {
		const visible = new Set(result.flatMap((item) => item.kind === "node" && item.nodeId ? [item.nodeId] : []));
		const hidden = flat.filter((row) => !visible.has(row.node.id)).map((row) => row.node);
		const desired = projectAgentTreeDigests(nodes, hidden, opts);
		for (let index = 0; index < result.length; index++) {
			const replacement = desired.find((item) => item.kind === result[index]!.kind);
			if (replacement) result[index] = replacement;
		}
		const missing = desired.find((item) => !result.some((existing) => existing.kind === item.kind));
		if (!missing) break;
		if (result.length < limit) { result.push(missing); continue; }
		let index = result.findLastIndex((item) => item.kind === "overflow");
		if (index < 0) index = result.findLastIndex((item) => replaceable(item) && preferredIds.includes(item.nodeId!));
		if (index < 0) index = result.findLastIndex((item) => replaceable(item));
		if (index < 0) index = result.findLastIndex((item) => (priority[item.kind] ?? -1) > (priority[missing.kind] ?? -1));
		if (index < 0) break;
		result[index] = missing;
	}
	// A reservation may displace the only visible child of an expanded group: drop the orphan
	// header rather than spend a row restating the digest.
	const legged = withDelegateLegs(result);
	const visible = new Set(legged.flatMap((item) => item.kind === "node" && item.nodeId ? [item.nodeId] : []));
	return orderSummary(countOverflow(legged.filter((item) => !isOrphanGroupHeader(item, flat, visible)), rows.length), flat);
}

function overflowRow(hidden: number): AgentSummaryRow {
	return summaryRow("overflow", [{ text: `… +${hidden} more · F9 or /agents for the full live tree`, token: "dim" }], [{ text: `+${hidden} more`, token: "dim" }]);
}

/** `… +N more` counts the tree rows the final selection does not draw — rows displaced by a
 *  reservation and folded-away group headers included, since F9 shows every one of them. */
function countOverflow(result: AgentSummaryRow[], treeRows: number): AgentSummaryRow[] {
	const hidden = treeRows - result.filter((item) => item.kind === "node").length;
	return result.map((item) => item.kind === "overflow" ? overflowRow(hidden) : item);
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
	usage?: ChildUsage | undefined;
	detail?: string;
	output?: string;
	chat?: WorkerChatSnapshot | undefined;
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
	usage?: ChildUsage | undefined;
	detail?: string;
	output?: string;
	chat?: WorkerChatSnapshot | undefined;
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
	if (Object.hasOwn(patch, "usage")) {
		if (patch.usage === undefined) delete node.usage;
		else node.usage = { ...patch.usage };
	}
	if (patch.detail !== undefined) node.detail = patch.detail;
	if (patch.output !== undefined) node.output = patch.output;
	if (Object.hasOwn(patch, "chat")) {
		if (patch.chat === undefined) delete node.chat;
		else node.chat = patch.chat;
	}
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
			if (!sameNode(before, existing)) this.emit({ type: "updated", node: copyNode(existing) });
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
			...(input.usage !== undefined ? { usage: { ...input.usage } } : {}),
			...(input.output !== undefined ? { output: input.output } : {}),
			...(input.chat !== undefined ? { chat: input.chat } : {}),
			...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
		};
		this.nodes.push(node);
		this.emit({ type: "added", node: copyNode(node) });
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
		if (!sameNode(before, node)) this.emit({ type: "updated", node: copyNode(node) });
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
		const removed = this.nodes.filter((n) => doomed.has(n.id)).map(copyNode);
		if (removed.length === 0) return;
		this.nodes = this.nodes.filter((n) => !doomed.has(n.id));
		this.emit({ type: "removed", nodes: removed });
	}

	/** Explicit lifecycle reset: readers may retain a pruned node after the registry empties. */
	clear(): void {
		const removed = this.snapshot();
		this.nodes = [];
		this.emit({ type: "cleared", nodes: removed });
	}

	snapshot(): AgentNode[] {
		return this.nodes.map(copyNode);
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
		// Same policy as AsyncRunTracker: iterate a snapshot, and one listener's throw must neither
		// skip the later ones nor propagate into the engine/strategy callback that updated the tree.
		for (const fn of [...this.listeners]) {
			try {
				fn(change);
			} catch (e) {
				if (process.env.PI_PERSONA_DEBUG) {
					process.stderr.write(`[pi-persona] agent tree listener threw on ${change.type}: ${e instanceof Error ? e.message : String(e)}\n`);
				}
			}
		}
	}
}

const CLOCK_KEYS = new Set<keyof AgentNode>(["startedAt", "lastAdvanceAt"]);
function copyNode(node: AgentNode): AgentNode {
	return { ...node, ...(node.usage !== undefined ? { usage: { ...node.usage } } : {}) };
}

function sameUsage(a: ChildUsage | undefined, b: ChildUsage | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined &&
		a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite && a.cost === b.cost && a.contextTokens === b.contextTokens && a.turns === b.turns);
}

function sameNode(a: AgentNode, b: AgentNode): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof AgentNode>);
	return [...keys].every((key) => CLOCK_KEYS.has(key) || (key === "usage" ? sameUsage(a.usage, b.usage) : a[key] === b[key]));
}

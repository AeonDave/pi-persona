/**
 * A focusable overlay over the unified agent tree, opened with ctx.ui.custom
 * (overlay: true). ↑↓ navigate workers and inspectable groups, ⏎ opens a group
 * overview or a worker's live output in an
 * auto-scrolling viewport sized to the terminal — `x` stops it, `X` (twice) stops every
 * running agent, `s` steers it (from the list too), esc backs out / closes. Subscribes to the tree, so it
 * re-renders live as agents stream.
 *
 * The pure parts (flatten/order, glyphs, scroll window) live in agent-tree.ts /
 * model-picker.ts and are unit-tested; this file is the thin pi-tui glue
 * (focus + keyboard + framing).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { type AgentNode, type AgentTree, type FlatRow, deriveWaitingNodeIds, effortTag, flattenTree, isWakeSource, isNonAgentNode, nodeGlyph, runningAnnotation, thinkingDetailLine } from "./agent-tree.ts";
import { LiveClock } from "./live-clock.ts";
import { cumulativeUsageLine, groupLegBrief, groupLegMetadata, groupLegStatus, isAgentGroup, projectAgentGroup } from "./agent-group.ts";
import { visibleWindow } from "./model-picker.ts";
import { compactInlineText, OPEN_SEQUENCE_TAIL, sanitizeTerminalText } from "./presentation.ts";

function safeInline(value: string, maxChars = 96): string {
	return compactInlineText(value, { maxChars });
}

/** Rows the terminal has (fallback for exotic hosts). */
function termRows(): number {
	return process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
}

/** Is this keystroke a single printable character (a steer-input keystroke)? */
function isPrintable(key: string): boolean {
	if (key.length !== 1) return false;
	const c = key.charCodeAt(0);
	return c >= 0x20 && c !== 0x7f;
}

/** Pure inputs for one list row: everything {@link composeAgentRow} needs and nothing it can
 *  reach into the overlay for. Keeping this a plain function (not a method) means the frame-width
 *  invariant is testable directly, without constructing a whole overlay. */
export interface AgentRowInput {
	node: AgentNode;
	depth: number;
	selected: boolean;
	inner: number;
	now: number;
	stallMs: number;
	waitingForSupervisor?: boolean;
	theme: Theme;
}

/**
 * One list row, guaranteed to fit within `inner` columns. The clock suffix (elapsed/stall badge)
 * is reserved and appended *after* the label+detail body is clamped, so a tight budget always
 * eats into the label/detail — truncating a stall badge would hide the one signal it exists to
 * show. `safeInline` has its own internal floor (never truncates below ~16 columns), so the
 * computed label/detail budgets are best-effort; the final clamp on the body is what makes the
 * overall width hold regardless.
 */
export function composeAgentRow(input: AgentRowInput): string {
	const { node, depth, selected, inner, now, stallMs, theme: t } = input;
	const indent = "  ".repeat(depth);
	const clock = runningAnnotation(node, now, stallMs, input.waitingForSupervisor);
	// Reserve the clock's exact width plus its widest separator (" · ") up front — this portion
	// of the row is never truncated.
	const clockCols = clock ? visibleWidth(clock) + visibleWidth(" · ") : 0;
	const bodyMax = Math.max(0, inner - clockCols);

	const prefixCols = 2 + visibleWidth(indent); // "▸ " or "  ", then the indent
	const avail = Math.max(0, bodyMax - prefixCols - 2); // 2 = glyph + space
	// The compact effort sigla rides the label (` · xh` / ` · xh→h`); its width comes out of the
	// label budget so the appended field never becomes the part a tight row eats first. The final
	// clamp below still guarantees the row fits either way.
	const effort = effortTag(node.thinking, node.thinkingEffective);
	const labelMax = Math.max(8, Math.floor(avail * 0.62) - visibleWidth(effort));
	const label = (safeInline(node.label, labelMax) || "agent") + effort;
	const detailMax = node.detail ? Math.max(0, avail - labelMax - 2) : 0;
	const detail = detailMax > 0 ? safeInline(node.detail ?? "", detailMax) : "";
	const detailText = detail ? t.fg("dim", `  ${detail}`) : "";

	const labelLine = `${indent}${nodeGlyph(node)} ${label}`;
	const prefixed = selected ? t.fg("accent", `▸ ${labelLine}`) : `  ${labelLine}`;
	let body = `${prefixed}${detailText}`;
	if (visibleWidth(body) > bodyMax) body = truncateToWidth(body, bodyMax, "");

	const clockText = clock ? t.fg("dim", `${detail ? " · " : "  "}${clock}`) : "";
	return `${body}${clockText}`;
}

/** Trailing callbacks and clock config for {@link AgentOverlay}, grouped as one object so a
 *  new capability (stall threshold, injected clock) does not grow the constructor's arity. */
export interface AgentOverlayActions {
	onStop?: (nodeId: string) => boolean;
	onSteer?: (nodeId: string, text: string) => boolean;
	canSteer?: (nodeId: string) => boolean;
	canStop?: (nodeId: string) => boolean;
	/** Live predicate for the exact engine handle behind a row. */
	isWaitingForSupervisor?: (nodeId: string) => boolean;
	/** Stall threshold for the ⚠ badge; 0/omitted ⇒ no badge. */
	stallMs?: number;
	/** Clock; tests inject a fixed one. */
	now?: () => number;
}

export class AgentOverlay extends Container {
	private tree: AgentTree;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private readonly actions: AgentOverlayActions;
	private readonly clock: LiveClock;
	private readonly now: () => number;
	private notice: string | undefined;
	private unsubscribe: () => void;
	private selectedId: string | undefined; // the selected agent's *id*, never its row index
	private aimLost = false; // the aimed-at agent settled: swallow the next directed keystroke
	private stopAllArmed: string | undefined; // the stoppable set the "press X again" prompt armed on
	private listScroll = 0; // list rows scrolled off the top (keeps the selection visible)
	private detailId: string | undefined;
	private groupId: string | undefined;
	private groupSelectedId: string | undefined;
	private groupAimLost = false;
	private groupScroll = 0;
	private detailScroll = 0; // output lines scrolled up from the bottom (0 = latest)
	private steering = false; // typing a steer message into the drilled-in agent
	private steerBuffer = "";
	private lastWidth = 100;
	/** State changed since the last host paint. Rebuilding here (instead of in the tree listener)
	 *  lets Pi-TUI's own 16ms frame coalescer absorb a burst of streamed progress snapshots. */
	private dirty = false;
	/** A host frame has already been requested for the current invalidation burst. */
	private frameRequested = false;
	private displayCache: { source: string; width: number; rows: string[] } | undefined;

	constructor(tree: AgentTree, tui: TUI, theme: Theme, done: () => void, actions: AgentOverlayActions = {}) {
		super();
		this.tree = tree;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.now = actions.now ?? Date.now;
		this.clock = new LiveClock({ intervalMs: 1_000, isLive: () => tree.hasRunning(), onTick: () => this.refresh() });
		this.unsubscribe = tree.onChange(() => {
			// A tree change can arrive while a compose is open. If its live handle disappeared,
			// retire the compose state now; the next key must not be interpreted with stale text
			// while the lazy rebuild waits for the host's paint.
			if (this.steering && this.detailId && !(this.actions.canSteer?.(this.detailId) ?? false)) {
				this.steering = false;
				this.steerBuffer = "";
			}
			this.scheduleRefresh();
			this.clock.start(); // new work may have appeared while the clock was stopped
		});
		this.rebuild();
		this.clock.start();
	}

	private refresh(): void {
		this.scheduleRefresh();
	}

	/** Mark the component stale and ask the host for one paint. The actual rebuild happens from
	 *  render(), so several tree changes before that paint do not repeatedly clear/recompose all
	 *  children (or re-wrap a streamed detail buffer). */
	private scheduleRefresh(): void {
		this.dirty = true;
		if (this.frameRequested) return;
		this.frameRequested = true;
		this.tui.requestRender();
	}

	/** Frame the panel in a box so it stands out from the chat background. */
	override render(width: number): string[] {
		this.frameRequested = false;
		if (this.lastWidth !== width) this.dirty = true;
		this.lastWidth = width;
		if (this.dirty) {
			this.rebuild();
			this.dirty = false;
		}
		const inner = this.inner();
		const t = this.theme;
		const b = (s: string): string => t.fg("accent", s);
		const framed = super.render(inner).map((line) => {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			return `${b("│")} ${line}${pad} ${b("│")}`;
		});
		return [b(`┌${"─".repeat(inner + 2)}┐`), ...framed, b(`└${"─".repeat(inner + 2)}┘`)];
	}

	private inner(): number {
		// Use the whole width the host gives us (the overlay itself is sized ~90% of the
		// terminal) — a hard 100-column cap made wide terminals waste most of the screen.
		return Math.max(24, this.lastWidth - 4);
	}

	/** Detail-output rows that fit: terminal height minus the overlay chrome. */
	private detailViewport(reservedRows: number): number {
		// Borders and both scroll markers occupy four rows independently of the
		// measured header/footer. New metadata must reduce output space, not overflow.
		return Math.max(1, termRows() - reservedRows - 4);
	}

	/** List rows that fit: terminal height minus the overlay chrome. */
	private listViewport(): number {
		return Math.max(6, termRows() - 10);
	}

	private waitingNodeIds(nodes: readonly AgentNode[] = this.tree.snapshot()): Set<string> {
		return deriveWaitingNodeIds(nodes, (id) => this.actions.isWaitingForSupervisor?.(id) === true);
	}

	/** Every row can be inspected; inspection does not confer a stop or steer handle. */
	private selectableRows(snap: AgentNode[] = this.tree.snapshot()): FlatRow[] {
		return flattenTree(snap);
	}

	/**
	 * The selected leaf, re-anchored by id on every use. The list is recomputed from the
	 * live tree, and agents are pruned from it as they settle: an index would slide `x`
	 * (stop) and `s` (steer) onto a *different* agent whenever an earlier sibling went
	 * away. When the aimed-at agent is the one that vanishes, fall back to the head of
	 * the list, where the ▸ marker visibly shows the user their target changed — and
	 * record that the aim was lost, for the directed keys (see `aimedLeaf`). The (re-)anchor
	 * prefers an agent row: a monitor or timer that merely happens to be listed first must not
	 * inherit the marker, or the next `x` could cancel a two-hour watch. A wake row takes it only
	 * when no agent is left.
	 */
	private selectedLeaf(leaves: FlatRow[]): FlatRow | undefined {
		const anchored = this.selectedId !== undefined ? leaves.find((r) => r.node.id === this.selectedId) : undefined;
		const nodes = leaves.map((row) => row.node);
		const leaf = anchored ?? leaves.find((r) => !isNonAgentNode(r.node) && (!isAgentGroup(r.node, nodes) || this.actions.canStop?.(r.node.id) === true)) ?? leaves.find((r) => !isNonAgentNode(r.node)) ?? leaves[0];
		if (this.selectedId !== undefined && anchored === undefined && leaf !== undefined) this.aimLost = true;
		this.selectedId = leaf?.node.id;
		return leaf;
	}

	/**
	 * The leaf a *directed* key (`x` stop, `s` steer) may act on. A keystroke is always in flight
	 * while runs settle underneath it, and stopping an agent cannot be undone — so the first such
	 * key after the aimed-at agent vanished only re-anchors and re-renders. The user then acts on
	 * the target the ▸ marker actually shows, rather than on whichever agent inherited the aim.
	 */
	private aimedLeaf(leaves: FlatRow[]): FlatRow | undefined {
		const leaf = this.selectedLeaf(leaves);
		if (!this.aimLost) return leaf;
		this.aimLost = false;
		this.refresh();
		return undefined;
	}

	/** Move the selection by whole rows, keeping it anchored on an id. */
	private moveSelection(leaves: FlatRow[], delta: number): void {
		const current = this.selectedLeaf(leaves);
		if (!current) return;
		const index = leaves.findIndex((r) => r.node.id === current.node.id);
		this.selectedId = leaves[Math.min(leaves.length - 1, Math.max(0, index + delta))]?.node.id;
		this.aimLost = false; // moving the marker by hand *is* taking aim
	}

	private rebuild(): void {
		this.clear();
		if (this.detailId) this.renderDetail();
		else if (this.groupId) this.renderGroup();
		else this.renderList();
		this.dirty = false;
	}

	private renderList(): void {
		const t = this.theme;
		const nodes = this.tree.snapshot();
		const rows = flattenTree(nodes);
		const selected = this.selectedLeaf(this.selectableRows(nodes))?.node;
		this.addChild(new Text(t.fg("accent", t.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));
		if (rows.length === 0) {
			this.addChild(new Text(t.fg("dim", "(no agents running)"), 1, 0));
		} else {
			// Scroll window over the rows (a big fan-out must not overflow the screen);
			// the window follows the selection, ▲/▼ markers show what's off-screen.
			const waitingIds = this.waitingNodeIds(nodes);
			const vp = this.listViewport();
			const selIdx = Math.max(0, rows.findIndex((r) => r.node.id === selected?.id));
			this.listScroll = visibleWindow(selIdx, vp, rows.length, this.listScroll);
			const end = Math.min(rows.length, this.listScroll + vp);
			if (this.listScroll > 0) this.addChild(new Text(t.fg("dim", `▲ ${this.listScroll} above`), 1, 0));
			for (const row of rows.slice(this.listScroll, end)) {
				const composed = composeAgentRow({
					node: row.node,
					depth: row.depth,
					selected: row.node.id === selected?.id,
					inner: this.inner(),
					now: this.now(),
					stallMs: this.actions.stallMs ?? 0,
					waitingForSupervisor: waitingIds.has(row.node.id),
					theme: t,
				});
				this.addChild(new Text(composed, 1, 0));
			}
			if (end < rows.length) this.addChild(new Text(t.fg("dim", `▼ ${rows.length - end} below`), 1, 0));
		}
		this.addChild(new Spacer(1));
		const stoppable = selected !== undefined && this.canStopNode(selected, nodes);
		const steerable = selected !== undefined && this.canSteerNode(selected, nodes);
		this.addChild(new Text(t.fg("dim", `↑↓ navigate   ⏎ open${this.hintLine("list", stoppable, steerable, this.stoppableIds(nodes).length)}   esc close`), 1, 0));
		this.renderNotice();
	}

	/** A group has its own stable cursor; returning from a worker keeps that same aim. */
	private selectedGroupLeg(legs: AgentNode[]): AgentNode | undefined {
		const anchored = legs.find((node) => node.id === this.groupSelectedId);
		if (this.groupSelectedId !== undefined && !anchored) this.groupAimLost = true;
		const selected = anchored ?? legs[0];
		this.groupSelectedId = selected?.id;
		return selected;
	}

	private renderGroup(): void {
		const nodes = this.tree.snapshot();
		const waitingIds = this.waitingNodeIds(nodes);
		const group = this.groupId ? projectAgentGroup(nodes, this.groupId, waitingIds) : undefined;
		if (!group) {
			this.groupId = undefined;
			this.renderList();
			return;
		}
		const t = this.theme;
		const line = (text: string, accent = false): void => {
			this.addChild(new Text(t.fg(accent ? "accent" : "dim", sanitizeTerminalText(truncateToWidth(safeInline(text, 600), this.inner(), "…"))), 0, 0));
		};
		line(`Group overview · ${group.root.label}`, true);
		line(group.summary);
		this.addChild(new Spacer(1));
		const selected = this.selectedGroupLeg(group.legs);
		const navigationHint = "↑↓ select · ⏎ output · esc back";
		const controlHint = [selected !== undefined && this.canStopNode(selected, nodes) ? "x stop leg" : "", selected !== undefined && this.canSteerNode(selected, nodes) ? "s steer leg" : ""].filter(Boolean).join(" · ");
		const fullHint = [navigationHint, controlHint].filter(Boolean).join(" · ");
		const footerLines = visibleWidth(fullHint) <= this.inner() ? [fullHint] : [navigationHint, controlHint].filter(Boolean);
		// Four rows per card; reserve real footer height and both overflow markers
		// only when cards do overflow. Long metadata never silently adds wrapped rows.
		const available = termRows() - 6 - footerLines.length - (this.notice ? 1 : 0);
		const capacity = Math.max(1, Math.floor(available / 4));
		const viewport = group.legs.length <= capacity ? capacity : Math.max(1, Math.floor((available - 2) / 4));
		const selectedIndex = Math.max(0, group.legs.findIndex((leg) => leg.id === selected?.id));
		this.groupScroll = visibleWindow(selectedIndex, viewport, group.legs.length, this.groupScroll);
		const end = Math.min(group.legs.length, this.groupScroll + viewport);
		if (this.groupScroll > 0) line(`▲ ${this.groupScroll} legs above`);
		for (const leg of group.legs.slice(this.groupScroll, end)) {
			const clock = runningAnnotation(leg, this.now(), this.actions.stallMs ?? 0, waitingIds.has(leg.id));
			const prefix = `${leg.id === selected?.id ? "▸" : " "} ${nodeGlyph(leg)} `;
			const suffix = ` · ${waitingIds.has(leg.id) ? "waiting for supervisor" : `${groupLegStatus(leg)}${clock ? ` · ${clock}` : ""}`}`;
			const label = truncateToWidth(safeInline(leg.label), Math.max(0, this.inner() - visibleWidth(prefix + suffix)), "…");
			line(prefix + label + suffix, leg.id === selected?.id);
			line(`  ${groupLegMetadata(leg, this.inner() - 2)}`);
			line(`  ${groupLegBrief(leg)}`);
			const usage = cumulativeUsageLine(leg);
			if (usage) line(`  ${usage}`);
		}
		if (end < group.legs.length) line(`▼ ${group.legs.length - end} legs below`);
		if (group.legs.length === 0) line("(no worker legs yet)");
		this.addChild(new Spacer(1));
		for (const hint of footerLines) line(hint);
		this.renderNotice();
	}

	/**
	 * Wrap long lines instead of truncating — the user must be able to read the full text.
	 * The viewport + scroll then operate over the wrapped display lines, so a long message
	 * spans several rows rather than being cut off with an ellipsis.
	 */
	private wrapRows(text: string, width: number): string[] {
		return text.split("\n").flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, width);
			return wrapped.length > 0 ? wrapped : [""]; // keep blank lines (paragraph spacing)
		});
	}

	/** Rows for a run of *completed* lines: the empty string after the final \n is not a row. */
	private settledRows(chunk: string, width: number): string[] {
		if (!chunk) return [];
		const lines = sanitizeTerminalText(chunk).split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.flatMap((line) => this.wrapRows(line, width));
	}

	/**
	 * Sanitized, wrapped display rows for the drilled-in buffer. A progress snapshot carries
	 * the whole accumulated output, and one fires per streamed chunk, so redoing the entire
	 * buffer every tick is quadratic in the report size — slow enough at a few hundred KB
	 * that `x` (stop) and the scroll keys queue behind the rebuild. Completed lines never
	 * change once written, so only the unfinished tail is redone.
	 *
	 * The seam has to fall *outside* a control sequence, or the sequence would be erased in
	 * two halves and leak its payload. Bailing on any ESC is not enough of a rule: agents
	 * colour their output, so a single `ESC[32m` would put every tick back on the whole
	 * buffer. Instead the seam retreats to the line an unterminated sequence opened on, and
	 * only a chunk that is still open after that gives up on reuse.
	 */
	private displayRows(raw: string, width: number): string[] {
		const cache = this.displayCache;
		let settled = raw.slice(0, raw.lastIndexOf("\n") + 1);
		const reusable = cache && cache.width === width && settled.startsWith(cache.source) ? cache : undefined;
		let added = reusable ? settled.slice(reusable.source.length) : settled;
		if (OPEN_SEQUENCE_TAIL.test(added)) {
			const opened = added.lastIndexOf("\u001B");
			added = added.slice(0, added.lastIndexOf("\n", opened) + 1);
			settled = (reusable?.source ?? "") + added;
		}
		if (OPEN_SEQUENCE_TAIL.test(added)) {
			// An earlier sequence spans the whole chunk: the only sound seam is no seam.
			this.displayCache = undefined;
			const whole = raw.slice(0, raw.lastIndexOf("\n") + 1);
			return this.settledRows(whole, width).concat(this.wrapRows(sanitizeTerminalText(raw.slice(whole.length)), width));
		}
		const rows = reusable ? reusable.rows : [];
		for (const row of this.settledRows(added, width)) rows.push(row);
		this.displayCache = { source: settled, width, rows };
		return rows.concat(this.wrapRows(sanitizeTerminalText(raw.slice(settled.length)), width));
	}

	private renderDetail(): void {
		const t = this.theme;
		const nodes = this.tree.snapshot();
		const node = nodes.find((n) => n.id === this.detailId);
		if (!node) {
			this.detailId = undefined;
			// The compose belonged to *that* agent — drop it, or the next drill-in would
			// re-open it pre-filled and send it to a different sub-agent. Re-rendering the
			// list also loses the anchor (the selection *is* the drilled-in agent), so an
			// `x` still in flight for it is refused instead of landing on the list beneath.
			this.steering = false;
			this.steerBuffer = "";
			if (this.groupId) this.renderGroup();
			else this.renderList();
			return;
		}
		const live = node.status === "running";
		// A wake source is armed, not a live agent: it has no steer handle, so the agent-only "● live"
		// badge and the steer-unavailable hint below would both be wrong for it.
		const wake = isWakeSource(node);
		const localActivity = node.kind === "activity";
		const metadata = (text: string): void => { this.addChild(new Text(truncateToWidth(text, Math.max(1, this.inner() - 2), "…"), 1, 0)); };
		metadata(`${nodeGlyph(node)} ${t.fg("accent", t.bold(safeInline(node.label) || "agent"))}${live ? t.fg("success", localActivity ? "  ● local work" : wake ? "  ● armed" : "  ● live") : ""}`);
		if (this.waitingNodeIds(nodes).has(node.id)) metadata(t.fg("dim", "waiting for supervisor"));
		const usageLine = cumulativeUsageLine(node);
		if (node.detail && usageLine !== `cumulative usage: ${node.detail}`) metadata(t.fg("dim", safeInline(node.detail)));
		if (!isNonAgentNode(node)) metadata(t.fg("dim", `model: ${safeInline(node.model ?? "pending / unknown", 160)}`));
		if (usageLine) metadata(t.fg("dim", usageLine));
		// The drill-in has room for FULL effort names (the rows stay compact): an observed level
		// appears only once a terminal result actually reported one.
		const effortLine = thinkingDetailLine(node.thinking, node.thinkingEffective);
		if (effortLine) metadata(t.fg("dim", effortLine));
		this.addChild(new Spacer(1));
		const w = this.inner() - 1;
		const footer = new Container();
		const steerable = this.canSteerNode(node, nodes);
		const stoppable = this.canStopNode(node, nodes);
		if (this.steering && !steerable) this.steering = false;
		footer.addChild(new Spacer(1));
		if (this.steering) {
			const composed = `${t.fg("accent", "steer ▸ ")}${this.steerBuffer}${t.fg("dim", "▌")}`;
			for (const line of wrapTextWithAnsi(composed, w)) footer.addChild(new Text(line, 1, 0));
			footer.addChild(new Text(t.fg("dim", "⏎ send   ·   esc cancel"), 1, 0));
		} else {
			footer.addChild(new Text(t.fg("dim", `esc back   ·   ↑↓ scroll${this.hintLine("detail", stoppable, steerable)}`), 1, 0));
			this.renderNotice(footer);
			if (live && !steerable && !isNonAgentNode(node)) footer.addChild(new Text(t.fg("dim", "(steer unavailable: no live handle yet, or this engine/broker does not expose one)"), 1, 0));
		}

		const raw = node.output?.trim()
			? node.output
			: live
				? "(working… the report appears here when the agent writes text — see its current tool above)"
				: "(no output)";
		const all = this.displayRows(raw, w);
		const viewport = this.detailViewport(super.render(this.inner()).length + footer.render(this.inner()).length);
		const maxScroll = Math.max(0, all.length - viewport);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const end = all.length - this.detailScroll;
		const start = Math.max(0, end - viewport);
		if (start > 0) this.addChild(new Text(t.fg("dim", `▲ ${start} earlier`), 1, 0));
		for (const line of all.slice(start, end)) this.addChild(new Text(t.fg("toolOutput", line), 1, 0));
		if (this.detailScroll > 0) this.addChild(new Text(t.fg("dim", `▼ ${this.detailScroll} newer`), 1, 0));

		this.addChild(footer);
	}

	handleInput(keyData: string): void {
		const hadNotice = this.notice !== undefined;
		this.notice = undefined; // any key clears a previous refusal notice
		const armed = this.stopAllArmed;
		this.stopAllArmed = undefined; // only an immediately repeated X confirms
		const kb = getKeybindings();
		if (this.detailId) {
			// Steer mode: type a message into the running agent. Capture all printable keys
			// (so j/k/x type normally); ⏎ sends, esc cancels.
			if (this.steering) {
				if (kb.matches(keyData, "tui.select.cancel")) {
					this.steering = false;
					this.steerBuffer = "";
					this.refresh();
				} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
					const text = this.steerBuffer.trim();
					this.steering = false;
					this.steerBuffer = "";
					if (text) {
						const nodes = this.tree.snapshot();
						const node = nodes.find((candidate) => candidate.id === this.detailId);
						if (!node || !this.canSteerNode(node, nodes) || !this.actions.onSteer?.(node.id, text)) this.notice = "steer unavailable for this worker";
					}
					this.refresh();
				} else if (keyData === "\x7f" || keyData === "\b") {
					this.steerBuffer = this.steerBuffer.slice(0, -1);
					this.refresh();
				} else if (isPrintable(keyData)) {
					this.steerBuffer += keyData;
					this.refresh();
				} else if (hadNotice) this.refresh();
				return;
			}
			const detailNode = this.tree.snapshot().find((node) => node.id === this.detailId);
			if (keyData === "s" && detailNode && this.canSteerNode(detailNode, this.tree.snapshot())) {
				this.steering = true;
				this.steerBuffer = "";
				this.refresh();
			} else if (keyData === "x") this.tryStop(this.detailId);
			else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
				this.detailScroll += 1;
				this.refresh();
			} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
				this.detailScroll = Math.max(0, this.detailScroll - 1);
				this.refresh();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.detailId = undefined;
				this.refresh();
			} else if (hadNotice) this.refresh(); // unhandled key: still repaint so a cleared notice disappears
			return;
		}
		if (this.groupId) {
			this.handleGroupInput(keyData, hadNotice);
			return;
		}
		const nodes = this.tree.snapshot();
		const leaves = this.selectableRows(nodes);
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(leaves, -1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(leaves, 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const leaf = this.selectedLeaf(leaves);
			if (leaf) {
				if (isAgentGroup(leaf.node, nodes)) {
					this.groupId = leaf.node.id;
					this.groupSelectedId = undefined;
					this.groupAimLost = false;
					this.groupScroll = 0;
				} else this.detailId = leaf.node.id;
				this.detailScroll = 0; // open at the latest output (auto-scroll to bottom)
				this.aimLost = false; // reading a row is harmless, and it re-takes aim on it
				this.refresh();
			}
		} else if (keyData === "s") {
			// Steer straight from the list: drill into the selected agent with the
			// compose line already open (same gate as the detail view's `s`).
			const leaf = this.aimedLeaf(leaves);
			if (leaf && this.canSteerNode(leaf.node, nodes)) {
				this.detailId = leaf.node.id;
				this.detailScroll = 0;
				this.steering = true;
				this.steerBuffer = "";
				this.refresh();
			}
		} else if (keyData === "x") {
			const leaf = this.aimedLeaf(leaves);
			if (leaf) this.tryStop(leaf.node.id);
		} else if (keyData === "X") {
			this.stopAll(armed);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
		} else if (hadNotice) this.refresh(); // unhandled key: still repaint so a cleared notice disappears
	}

	private handleGroupInput(keyData: string, hadNotice: boolean): void {
		const nodes = this.tree.snapshot();
		const group = this.groupId ? projectAgentGroup(nodes, this.groupId) : undefined;
		if (!group) {
			// Consume this key in the disappeared view. It cannot fall through to a new tree target.
			this.groupId = undefined;
			this.refresh();
			return;
		}
		const kb = getKeybindings();
		const selected = this.selectedGroupLeg(group.legs);
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.groupId = undefined;
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k" || kb.matches(keyData, "tui.select.down") || keyData === "j") {
			const delta = kb.matches(keyData, "tui.select.up") || keyData === "k" ? -1 : 1;
			const index = group.legs.findIndex((node) => node.id === selected?.id);
			this.groupSelectedId = group.legs[Math.max(0, Math.min(group.legs.length - 1, index + delta))]?.id;
			this.groupAimLost = false;
			this.refresh();
		} else if ((kb.matches(keyData, "tui.select.confirm") || keyData === "\n") && selected) {
			this.detailId = selected.id;
			this.detailScroll = 0;
			this.groupAimLost = false;
			this.refresh();
		} else if (keyData === "x" || keyData === "s") {
			if (this.groupAimLost) {
				this.groupAimLost = false;
				this.refresh();
				return;
			}
			if (selected && keyData === "x") this.tryStop(selected.id);
			else if (selected && this.canSteerNode(selected, nodes)) {
				this.detailId = selected.id;
				this.detailScroll = 0;
				this.steering = true;
				this.steerBuffer = "";
				this.refresh();
			}
		} else if (hadNotice) this.refresh();
	}

	private canSteerNode(node: AgentNode, nodes: readonly AgentNode[]): boolean {
		return !isNonAgentNode(node) && !isAgentGroup(node, nodes) && node.status === "running" && (this.actions.canSteer?.(node.id) ?? false);
	}

	/** Whether an agent can be stopped right now: it must be running, and the caller's `canStop`
	 *  gate (defaulting to "yes" when omitted) must agree. Shared by both hints and `tryStop`, so
	 *  the hint that advertises "x stop" and the handler that actually gates it never diverge. */
	private canStopNode(node: AgentNode, nodes: readonly AgentNode[] = this.tree.snapshot()): boolean {
		return node.kind !== "activity" && node.status === "running" && (this.actions.canStop?.(node.id) ?? !isAgentGroup(node, nodes));
	}

	/** The agents `X` would stop: every leaf that `x` could stop, wake sources excluded. `X` means
	 *  "stop every agent"; a monitor's job (it may be a two-hour batch) or a timer's alarm is cancelled
	 *  only by an explicit `x` on its own row. One list feeds the hint count, the confirmation prompt
	 *  and the bulk stop, so the three always agree. */
	private stoppableIds(snap: AgentNode[] = this.tree.snapshot()): string[] {
		return this.selectableRows(snap).filter((r) => !isNonAgentNode(r.node) && this.canStopNode(r.node, snap)).map((r) => r.node.id);
	}

	/** The trailing "x stop"/"X stop all"/"s steer" hint fragment for an action line — the list's
	 *  three-space style or the detail view's " · " style, the two views' only difference here.
	 *  `stopAll` (list only) is the stoppable count; one agent is what plain `x` is for. */
	private hintLine(kind: "list" | "detail", stoppable: boolean, steerable: boolean, stopAll = 0): string {
		const sep = kind === "list" ? "   " : "   ·   ";
		return `${stoppable ? `${sep}x stop` : ""}${stopAll >= 2 ? `${sep}X stop all (${stopAll})` : ""}${steerable ? `${sep}s steer` : ""}`;
	}

	/** The one-line refusal notice, shown identically under the list and the detail view. */
	private renderNotice(target: Container = this): void {
		if (this.notice) target.addChild(new Text(this.theme.fg("dim", sanitizeTerminalText(truncateToWidth(safeInline(this.notice, 240), Math.max(1, this.inner() - 2), "…"))), 1, 0));
	}

	/** Stop (abort) one agent by id. A refusal — the node is gone, not stoppable, or the caller
	 *  declines — surfaces as a one-line notice rather than doing nothing: the user pressed a key
	 *  and deserves feedback, in the list view and the detail view alike. */
	private tryStop(nodeId: string): void {
		const node = this.tree.snapshot().find((n) => n.id === nodeId);
		if (!node || !this.canStopNode(node) || !this.actions.onStop?.(nodeId)) {
			this.notice = `nothing to stop for ${node?.label ?? nodeId}`;
		}
		this.refresh();
	}

	/** `X`: stop every stoppable agent after one confirming press. The prompt states how many agents
	 *  it covers and arms on the exact set it saw, so a set that changed since (or any key in
	 *  between) asks again — a bulk, irreversible stop is never fired on a stale confirmation. */
	private stopAll(armed: string | undefined): void {
		const ids = this.stoppableIds();
		const key = ids.join("|");
		if (ids.length >= 2) {
			if (armed === key) {
				let stopped = 0;
				for (const id of ids) if (this.actions.onStop?.(id)) stopped++;
				this.notice = `stop requested for ${stopped} agent${stopped === 1 ? "" : "s"}; queued or later stages may still start`;
			} else {
				this.stopAllArmed = key;
				this.notice = `press X again to stop ${ids.length} running agents`;
			}
		}
		this.refresh();
	}

	private close(): void {
		this.dispose();
		this.done();
	}

	dispose(): void {
		this.clock.stop();
		this.unsubscribe();
	}

	/** Read-only for tests: whether the live-clock tick is still armed. */
	get clockRunning(): boolean {
		return this.clock.running;
	}
}

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
	setKeybindings,
	Input,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	type Focusable,
	type KeybindingsManager,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { type AgentNode, type AgentTree, type FlatRow, deriveWaitingNodeIds, effortTag, isWakeSource, isNonAgentNode, nodeGlyph, runningAnnotation, thinkingDetailLine } from "./agent-tree.ts";
import { LiveClock } from "./live-clock.ts";
import { inspectorFrame } from "./inspector-frame.ts";
import { cumulativeUsageLine, groupLegBrief, groupLegMetadata, groupLegStatus, isAgentGroup, projectAgentGroup } from "./agent-group.ts";
import { visibleWindow } from "./model-picker.ts";
import { compactInlineText, OPEN_SEQUENCE_TAIL, sanitizeTerminalText } from "./presentation.ts";
import { foldedRows, isFoldableRow, projectPeers, projectResourceGroups, RECENT_WORKERS_GROUP_ID, type PeerPresence } from "./resource-groups.ts";
import { WorkerChatView } from "./worker-chat.ts";
import { fieldPrefix, keyLabel, legendRows, navigationKeys, TITLED_FIELD_MIN_WIDTH, titledField, windowRule, type LabelledAction } from "./window-chrome.ts";

function safeInline(value: string, maxChars = 96): string {
	return compactInlineText(value, { maxChars });
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
	/** Shared presentation state with the above-editor widget. */
	collapsedGroups?: Set<string>;
	onGroupToggle?: () => void;
	peerSnapshot?: () => readonly PeerPresence[];
	onPeersChanged?: (listener: () => void) => () => void;
	/** Existing tracker retention, projected here only; settled workers never regain controls. */
	recentWorkers?: () => readonly AgentNode[];
	keybindings?: KeybindingsManager;
	/** Same row allocation used by the host's overlay options. */
	viewportHeight?: () => number;
}

export class AgentOverlay extends Container implements Focusable {
	private tree: AgentTree;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private readonly actions: AgentOverlayActions;
	private readonly clock: LiveClock;
	private readonly now: () => number;
	private notice: string | undefined;
	private unsubscribe: () => void;
	private readonly unsubscribePeers: () => void;
	private selectedId: string | undefined; // the selected agent's *id*, never its row index
	private aimLost = false; // the aimed-at agent settled: swallow the next directed keystroke
	private stopAllArmed: string | undefined; // the stoppable set the "press X again" prompt armed on
	private listScroll = 0; // list rows scrolled off the top (keeps the selection visible)
	private mouseListIds: string[] = [];
	private mouseListStart = 3;
	private mouseInputRow = -1;
	private detailId: string | undefined;
	private groupId: string | undefined;
	private groupSelectedId: string | undefined;
	private groupAimLost = false;
	private groupScroll = 0;
	private readonly collapsedGroups: Set<string>;
	private detailScroll = 0; // output lines scrolled up from the bottom (0 = latest)
	private steering = false; // typing a steer message into the drilled-in agent
	private steerInput = new Input({ prompt: "" });
	/** Whether the composer was last drawn as a titled field; pointer mapping uses the same prompt. */
	private steerTitled = false;
	private _focused = false;
	private readonly keybindings: KeybindingsManager;
	readonly capturesViewportInput = true;
	private lastWidth = 100;
	private lastHeight = 0;
	private listCapacity = 1;
	private groupCapacity = 1;
	private detailCapacity = 1;
	/** State changed since the last host paint. Rebuilding here (instead of in the tree listener)
	 *  lets Pi-TUI's own 16ms frame coalescer absorb a burst of streamed progress snapshots. */
	private dirty = false;
	/** A host frame has already been requested for the current invalidation burst. */
	private frameRequested = false;
	private displayCache: { source: string; width: number; rows: string[] } | undefined;
	private readonly workerChats = new Map<string, { node: AgentNode; view: WorkerChatView }>();
	private mouseChatStart = -1;
	private mouseChatRows = 0;
	private chatInfo = false;

	constructor(tree: AgentTree, tui: TUI, theme: Theme, done: () => void, actions: AgentOverlayActions = {}) {
		super();
		this.tree = tree;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.keybindings = actions.keybindings ?? getKeybindings();
		this.resetSteerInput();
		this.collapsedGroups = actions.collapsedGroups ?? new Set();
		this.collapsedGroups.add(RECENT_WORKERS_GROUP_ID);
		this.now = actions.now ?? Date.now;
		this.clock = new LiveClock({ intervalMs: 1_000, isLive: () => tree.hasRunning(), onTick: () => this.refresh() });
		this.unsubscribe = tree.onChange((change) => {
			if (change.type === "cleared") {
				this.workerChats.clear();
				this.displayCache = undefined;
			} else {
				const changed = change.type === "removed" ? change.nodes : [change.node];
				for (const node of changed) {
					// A reused row is a new attempt. Retiring its prior reader also clears search,
					// expansion and scroll state before identically named blocks arrive again.
					if (change.type === "added" || !node.chat) this.workerChats.delete(node.id);
					if (node.chat && !isNonAgentNode(node) && (node.id === this.detailId || this.workerChats.has(node.id))) this.chatFor(node);
				}
				this.pruneWorkerChats();
			}
			// A tree change can arrive while a compose is open. If its live handle disappeared,
			// retire the compose state now; the next key must not be interpreted with stale text
			// while the lazy rebuild waits for the host's paint.
			if (this.steering && this.detailId && !(this.actions.canSteer?.(this.detailId) ?? false)) {
				this.steering = false;
				this.resetSteerInput();
			}
			this.scheduleRefresh();
			this.clock.start(); // new work may have appeared while the clock was stopped
		});
		this.unsubscribePeers = actions.onPeersChanged?.(() => this.scheduleRefresh()) ?? (() => {});
		this.lastHeight = this.viewportRows();
		this.rebuild();
		this.clock.start();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.syncFocus(); }

	private syncFocus(): void {
		this.steerInput.focused = this._focused && this.steering;
		for (const [id, chat] of this.workerChats) chat.view.focused = this._focused && !this.steering && id === this.detailId;
	}

	private viewportRows(): number {
		return Math.max(1, Math.floor(this.actions.viewportHeight?.() ?? inspectorFrame.viewportRows(this.tui.terminal?.rows ?? 24)));
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
		const height = this.viewportRows();
		if (this.lastWidth !== width || this.lastHeight !== height) this.dirty = true;
		this.lastWidth = width;
		this.lastHeight = height;
		if (this.dirty) {
			this.rebuild();
			this.dirty = false;
		}
		return inspectorFrame.render(super.render(this.inner()), inspectorFrame.layout(width, height), (text) => this.theme.fg("border", text));
	}

	override invalidate(): void {
		this.dirty = true;
		this.steerInput.invalidate();
		for (const chat of this.workerChats.values()) chat.view.invalidate();
		super.invalidate();
	}

	private inner(): number {
		return inspectorFrame.layout(this.lastWidth, this.lastHeight).contentWidth;
	}

	private contentRows(): number { return inspectorFrame.layout(this.lastWidth, this.lastHeight).contentRows; }

	private addLine(text: string): void {
		// The SDK's Text draws nothing for blank text, which would drop every separator row while
		// the row budgets and pointer offsets still count it.
		if (text.trim() === "") { this.addChild(new Spacer(1)); return; }
		const fit = truncateToWidth(text, this.inner(), "…");
		// The SDK adds reset sequences when truncating even uncoloured text.
		this.addChild(new Text(text.includes("\x1b") ? fit : sanitizeTerminalText(fit), 0, 0));
	}

	private keyLabel(action: LabelledAction): string { return keyLabel(this.keybindings, action); }

	private hintRows(full: string, compact: string, primary: string): string[] {
		return legendRows(this.inner(), this.contentRows(), full, compact, primary);
	}

	private resetSteerInput(): void {
		this.steerInput = new Input({ prompt: "" });
		this.steerInput.onSubmit = () => this.submitSteer();
		this.steerInput.onEscape = () => {
			this.steering = false;
			this.resetSteerInput();
			this.refresh();
		};
		this.syncFocus();
	}

	/** The composer's prompt: a bare chevron under its titled rule, a labelled one when compact. */
	private steerPrefix(): string { return fieldPrefix(this.inner(), this.steerTitled, "steer"); }

	private rule(title = ""): string { return windowRule(this.theme, this.inner(), title); }

	/**
	 * The steering composer. With room it is a titled field closed by a rule, so the row being
	 * typed into reads as an input; a short host keeps the input and its keys. `input` is the
	 * index of the row that takes pointer events.
	 */
	private steerRows(target: string, roomy: boolean): { rows: string[]; input: number } {
		this.steerTitled = roomy && this.inner() >= TITLED_FIELD_MIN_WIDTH;
		roomy = this.steerTitled;
		const prefix = this.steerPrefix();
		const field = this.theme.fg("accent", prefix) + (this.steerInput.render(Math.max(1, this.inner() - visibleWidth(prefix)))[0] ?? "");
		const keys = this.hintRows(`${this.keyLabel("tui.input.submit")} send · ${this.keyLabel("tui.select.cancel")} cancel · F9 close`, `${this.keyLabel("tui.input.submit")} send · F9 close`, "F9 close").map((line) => this.theme.fg("dim", line));
		return roomy ? { rows: [...titledField(this.theme, this.inner(), `Steer ${target}`, field), ...keys], input: 1 } : { rows: [field, ...keys], input: 0 };
	}

	private navigationKeys(): string { return navigationKeys(this.keybindings); }

	private pageDelta(data: string, capacity: number): number | undefined {
		if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) return -Math.max(1, capacity);
		if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) return Math.max(1, capacity);
		return undefined;
	}

	private waitingNodeIds(nodes: readonly AgentNode[] = this.tree.snapshot()): Set<string> {
		return deriveWaitingNodeIds(nodes, (id) => this.actions.isWaitingForSupervisor?.(id) === true);
	}

	/** Every row can be inspected; inspection does not confer a stop or steer handle. */
	private viewNodes(): AgentNode[] {
		const nodes = projectResourceGroups(this.tree.snapshot());
		const ids = new Set(nodes.map((node) => node.id));
		const recent = (this.actions.recentWorkers?.() ?? []).filter((node) => node.status !== "running" && node.chat && !ids.has(node.id));
		if (recent.length) {
			nodes.push({ id: RECENT_WORKERS_GROUP_ID, label: "Recent workers", kind: "resource-group", status: "done", parentId: undefined, detail: `${recent.length} retained` });
			for (const node of recent) {
				if (ids.has(node.id)) continue;
				ids.add(node.id);
				nodes.push({ ...node, parentId: RECENT_WORKERS_GROUP_ID });
			}
		}
		return [...nodes, ...projectPeers(this.actions.peerSnapshot?.() ?? [])];
	}

	private selectableRows(snap: AgentNode[] = this.viewNodes()): FlatRow[] {
		return foldedRows(projectResourceGroups(snap), this.collapsedGroups, { now: this.now(), stallMs: this.actions.stallMs ?? 0, waitingForSupervisor: this.waitingNodeIds(snap) });
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
		const leaf = anchored ?? leaves.find((r) => !isNonAgentNode(r.node) && (!isAgentGroup(r.node, nodes) || this.actions.canStop?.(r.node.id) === true)) ?? leaves.find((r) => !isNonAgentNode(r.node)) ?? leaves.find((r) => r.node.kind !== "resource-group") ?? leaves[0];
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
		this.pruneWorkerChats();
		this.mouseInputRow = -1;
		this.mouseChatStart = -1;
		this.mouseChatRows = 0;
		if (this.detailId) this.renderDetail();
		else if (this.groupId) this.renderGroup();
		else this.renderList();
		this.syncFocus();
		this.dirty = false;
	}

	private renderList(): void {
		const t = this.theme;
		const nodes = this.viewNodes();
		const rows = this.selectableRows(nodes);
		const selected = this.selectedLeaf(rows)?.node;
		const available = this.contentRows();
		this.mouseListIds = [];
		const stoppable = selected !== undefined && this.canStopNode(selected, nodes);
		const steerable = selected !== undefined && this.canSteerNode(selected, nodes);
		const foldHint = selected && isFoldableRow(selected, nodes) ? " · space fold" : "";
		const closeHint = `${this.keyLabel("tui.select.cancel")}/F9 close`;
		const hint = `${this.navigationKeys()} navigate · ${this.keyLabel("tui.select.confirm")} open${foldHint}${this.hintLine(stoppable, steerable, this.stoppableIds(nodes).length)} · ${closeHint}`;
		const header = available >= 7 ? [t.fg("accent", t.bold("Agents")), this.rule()] : available >= 4 ? [t.fg("accent", t.bold("Agents"))] : [];
		const footer = available >= 3 ? this.hintRows(hint, `${this.navigationKeys()} select · ${this.keyLabel("tui.select.confirm")} open · ${closeHint}`, closeHint).map((line) => t.fg("dim", line)) : [];
		if (this.notice && available - header.length - footer.length >= 2) footer.push(t.fg("dim", safeInline(this.notice, 240)));
		const spaced = available - header.length - footer.length >= 5;
		if (spaced) footer.unshift(this.rule());
		let capacity = Math.max(1, available - header.length - footer.length);
		const showMarkers = rows.length > capacity && capacity >= 3;
		if (showMarkers) capacity -= 2;
		this.listCapacity = capacity;
		for (const line of header) this.addLine(line);
		if (!rows.length) this.addLine(t.fg("dim", "(no agents running)"));
		else {
			const waitingIds = this.waitingNodeIds(nodes);
			const selIdx = Math.max(0, rows.findIndex((r) => r.node.id === selected?.id));
			this.listScroll = visibleWindow(selIdx, capacity, rows.length, this.listScroll);
			const end = Math.min(rows.length, this.listScroll + capacity);
			const above = showMarkers && this.listScroll > 0;
			this.mouseListStart = inspectorFrame.layout(this.lastWidth, this.lastHeight).top + header.length + Number(above);
			this.mouseListIds = rows.slice(this.listScroll, end).map((row) => row.node.id);
			if (above) this.addLine(t.fg("dim", `▲ ${this.listScroll} above`));
			for (const row of rows.slice(this.listScroll, end)) this.addLine(this.inner() < 16 ? `${row.node.id === selected?.id ? "▸ " : ""}${safeInline(row.node.label)}` : composeAgentRow({
				node: isFoldableRow(row.node, nodes) ? { ...row.node, label: `${this.collapsedGroups.has(row.node.id) ? "▸" : "▾"} ${row.node.label}` } : row.node,
				depth: row.depth, selected: row.node.id === selected?.id, inner: this.inner(), now: this.now(),
				stallMs: this.actions.stallMs ?? 0, waitingForSupervisor: waitingIds.has(row.node.id), theme: t,
			}));
			if (showMarkers && end < rows.length) this.addLine(t.fg("dim", `▼ ${rows.length - end} below`));
		}
		for (const line of footer) this.addLine(line);
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
		const nodes = this.viewNodes();
		const waitingIds = this.waitingNodeIds(nodes);
		const group = this.groupId ? projectAgentGroup(nodes, this.groupId, waitingIds) : undefined;
		if (!group) { this.groupId = undefined; this.renderList(); return; }
		const t = this.theme;
		const available = this.contentRows();
		const selected = this.selectedGroupLeg(group.legs);
		const navigationHint = `${this.navigationKeys()} select · ${this.keyLabel("tui.select.confirm")} output · ${this.keyLabel("tui.select.cancel")} back · F9 close`;
		const controlHint = [selected !== undefined && this.canStopNode(selected, nodes) ? "x stop leg" : "", selected !== undefined && this.canSteerNode(selected, nodes) ? "s steer leg" : ""].filter(Boolean).join(" · ");
		const fullHint = [navigationHint, controlHint].filter(Boolean).join(" · ");
		const header = available >= 8 ? [`Group overview · ${group.root.label}`, group.summary, this.rule()] : available >= 4 ? [`Group overview · ${group.root.label}`] : [];
		const footer = available >= 3 ? this.hintRows(fullHint, navigationHint, `${this.keyLabel("tui.select.cancel")} back · F9 close`) : [];
		if (this.notice && available - header.length - footer.length >= 2) footer.push(safeInline(this.notice, 240));
		const expanded = available - header.length - footer.length >= 7;
		if (expanded) footer.unshift(this.rule());
		const cards = group.legs.map((leg) => {
			const clock = runningAnnotation(leg, this.now(), this.actions.stallMs ?? 0, waitingIds.has(leg.id));
			const prefix = `${leg.id === selected?.id ? "▸" : " "} ${nodeGlyph(leg)} `;
			const suffix = ` · ${waitingIds.has(leg.id) ? "waiting for supervisor" : `${groupLegStatus(leg)}${clock ? ` · ${clock}` : ""}`}`;
			const label = truncateToWidth(safeInline(leg.label), Math.max(0, this.inner() - visibleWidth(prefix + suffix)), "…");
			const card = [prefix + (expanded ? label + suffix : safeInline(leg.label))];
			if (expanded) {
				if (!isNonAgentNode(leg)) card.push(`  ${groupLegMetadata(leg, this.inner() - 2)}`);
				card.push(`  ${groupLegBrief(leg)}`);
				const usage = cumulativeUsageLine(leg);
				if (usage) card.push(`  ${usage}`);
			}
			return card;
		});
		const cardRows = Math.max(1, ...cards.map((card) => card.length));
		let bodyRows = Math.max(1, available - header.length - footer.length);
		const overflow = cards.length * cardRows > bodyRows;
		const showMarkers = overflow && bodyRows >= cardRows + 2;
		if (showMarkers) bodyRows -= 2;
		this.groupCapacity = Math.max(1, Math.floor(bodyRows / cardRows));
		const selectedIndex = Math.max(0, group.legs.findIndex((leg) => leg.id === selected?.id));
		this.groupScroll = visibleWindow(selectedIndex, this.groupCapacity, group.legs.length, this.groupScroll);
		const end = Math.min(group.legs.length, this.groupScroll + this.groupCapacity);
		for (const [i, text] of header.entries()) this.addLine(t.fg(i === 0 ? "accent" : "dim", sanitizeTerminalText(safeInline(text, 600))));
		if (showMarkers && this.groupScroll > 0) this.addLine(t.fg("dim", `▲ ${this.groupScroll} legs above`));
		for (let i = this.groupScroll; i < end; i++) for (const text of cards[i] ?? []) this.addLine(t.fg(group.legs[i]?.id === selected?.id ? "accent" : "dim", sanitizeTerminalText(text)));
		if (showMarkers && end < group.legs.length) this.addLine(t.fg("dim", `▼ ${group.legs.length - end} legs below`));
		if (!group.legs.length) this.addLine(t.fg("dim", "(no worker legs yet)"));
		for (const text of footer) this.addLine(t.fg("dim", text));
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
		const nodes = this.viewNodes();
		const node = nodes.find((n) => n.id === this.detailId);
		if (!node) {
			const retained = this.detailId ? this.workerChats.get(this.detailId) : undefined;
			if (retained) { this.renderChatDetail(retained.node, nodes, false); return; }
			this.detailId = undefined;
			this.steering = false;
			this.resetSteerInput();
			this.syncFocus();
			if (this.groupId) this.renderGroup(); else this.renderList();
			return;
		}
		if (node.chat && !isNonAgentNode(node)) { this.renderChatDetail(node, nodes, true); return; }
		const live = node.status === "running";
		const wake = isWakeSource(node);
		const localActivity = node.kind === "activity";
		const effort = effortTag(node.thinking, node.thinkingEffective);
		const header = [`${nodeGlyph(node)} ${t.fg("accent", t.bold(safeInline(node.label) || "agent"))}${effort ? t.fg("muted", effort) : ""}${live ? t.fg("success", node.kind === "peer" ? "  ● peer" : localActivity ? "  ● local work" : node.kind === "script" ? "  ● running" : wake ? "  ● armed" : "  ● live") : ""}`];
		if (this.waitingNodeIds(nodes).has(node.id)) header.push(t.fg("dim", "waiting for supervisor"));
		const usageLine = cumulativeUsageLine(node);
		if (node.detail && usageLine !== `cumulative usage: ${node.detail}`) header.push(t.fg("dim", safeInline(node.detail)));
		if (!isNonAgentNode(node)) header.push(t.fg("dim", `model: ${safeInline(node.model ?? "pending / unknown", 160)}`));
		if (usageLine) header.push(t.fg("dim", usageLine));
		const effortLine = thinkingDetailLine(node.thinking, node.thinkingEffective);
		if (effortLine) header.push(t.fg("dim", effortLine));
		const steerable = this.canSteerNode(node, nodes);
		const stoppable = this.canStopNode(node, nodes);
		if (this.steering && !steerable) { this.steering = false; this.resetSteerInput(); }
		this.syncFocus();
		const footer: string[] = [];
		// A titled composer brings its own top rule; the plain footer gets one when there is room.
		const composer = this.steering ? this.steerRows(safeInline(node.label) || "agent", this.contentRows() >= header.length + 9) : undefined;
		if (composer) footer.push(...composer.rows);
		else {
			footer.push(...this.hintRows(`${this.keyLabel("tui.select.cancel")} back · ${this.navigationKeys()} scroll${this.hintLine(stoppable, steerable)} · ${this.keyLabel("tui.select.pageUp")}/${this.keyLabel("tui.select.pageDown")} page · F9 close`, `${this.keyLabel("tui.select.cancel")} back · ${this.navigationKeys()} scroll · F9 close`, `${this.keyLabel("tui.select.cancel")} back · F9 close`).map((line) => t.fg("dim", line)));
			if (this.notice) footer.push(t.fg("dim", safeInline(this.notice, 240)));
			if (live && !steerable && !isNonAgentNode(node)) footer.push(t.fg("dim", "(steer unavailable: no live handle yet, or this engine/broker does not expose one)"));
		}
		const available = this.contentRows();
		// Compact chrome before sacrificing the report. Even a one-row host keeps
		// the latest output (or active composer) rather than a metadata-only slice.
		if (available < header.length + footer.length + 3) header.splice(available >= 4 ? 1 : 0);
		if (available < header.length + footer.length + 1) footer.splice(this.steering ? 1 : available >= 3 ? 1 : 0);
		if (this.steering && available === 1) header.splice(0);
		const spaced = available >= header.length + footer.length + 5;
		// Whether the composer survived the compaction above with its own titled rule.
		const titled = composer !== undefined && composer.input === 1 && footer.length === composer.rows.length;
		const ruled = spaced && !titled;
		if (spaced) header.push(this.rule());
		if (ruled) footer.unshift(this.rule());
		const raw = node.output?.trim() ? node.output : live ? "(working… the report appears here when the agent writes text — see its current tool above)" : "(no output)";
		const all = this.displayRows(raw, this.inner());
		let capacity = Math.max(this.steering ? 0 : 1, available - header.length - footer.length);
		const showMarkers = all.length > capacity && capacity >= 3;
		if (showMarkers) capacity -= 2;
		this.detailCapacity = Math.max(1, capacity);
		const maxScroll = Math.max(0, all.length - capacity);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const end = all.length - this.detailScroll;
		const start = Math.max(0, end - capacity);
		for (const text of header) this.addLine(text);
		if (showMarkers && start > 0) this.addLine(t.fg("dim", `▲ ${start} earlier`));
		for (const text of all.slice(start, end)) this.addLine(t.fg("toolOutput", text));
		if (showMarkers && this.detailScroll > 0) this.addLine(t.fg("dim", `▼ ${this.detailScroll} newer`));
		this.mouseInputRow = composer ? inspectorFrame.layout(this.lastWidth, this.lastHeight).top + super.render(this.inner()).length + Number(ruled) + (titled ? composer.input : 0) : -1;
		for (const text of footer) this.addLine(text);
	}

	private chatFor(node: AgentNode): WorkerChatView {
		let chat = this.workerChats.get(node.id);
		if (!chat) {
			chat = { node, view: new WorkerChatView(this.theme, this.keybindings) };
			// Only reader-local state is retained, bounded independently from the existing tracker.
			if (this.workerChats.size >= 8) this.workerChats.delete(this.workerChats.keys().next().value!);
			this.workerChats.set(node.id, chat);
		}
		chat.node = node;
		if (node.chat) chat.view.update(node.chat);
		chat.view.focused = this._focused && !this.steering && node.id === this.detailId;
		return chat.view;
	}

	private pruneWorkerChats(): void {
		if (!this.workerChats.size) return;
		const retainedIds = new Set(this.viewNodes().filter((node) => node.chat && !isNonAgentNode(node)).map((node) => node.id));
		for (const id of this.workerChats.keys()) {
			// Keep a pruned chat only while the operator is reading it. Recent/live owners
			// retain their bounded reader state; leaving an orphan releases its payload.
			if (id !== this.detailId && !retainedIds.has(id)) this.workerChats.delete(id);
		}
	}

	private detailChat(): WorkerChatView | undefined {
		if (!this.detailId) return undefined;
		const node = this.viewNodes().find((candidate) => candidate.id === this.detailId);
		return node ? node.chat && !isNonAgentNode(node) ? this.chatFor(node) : undefined : this.workerChats.get(this.detailId)?.view;
	}

	private renderChatDetail(node: AgentNode, nodes: readonly AgentNode[], present: boolean): void {
		const view = this.chatFor(node);
		const t = this.theme;
		const steerable = present && this.canSteerNode(node, nodes);
		const stoppable = present && this.canStopNode(node, nodes);
		if (this.steering && !steerable) { this.steering = false; this.resetSteerInput(); }
		const effort = effortTag(node.thinking, node.thinkingEffective);
		const header = [`${nodeGlyph(node)} ${t.fg("accent", t.bold(safeInline(node.label)))}${effort ? t.fg("muted", effort) : ""} · ${present ? node.status : "retained view · no live controls"}`];
		// Engine-level aborts/timeouts can settle without emitting a chat error event.
		// Preserve their recorded cause without manufacturing conversation content.
		const terminalFailure = node.status === "failed" || node.status === "stopped";
		if (node.detail && (terminalFailure || this.chatInfo)) {
			const detail = safeInline(node.detail, 600);
			for (const row of this.wrapRows(detail, this.inner()).slice(0, 3)) header.push(t.fg(terminalFailure ? "error" : "dim", row));
		}
		if (this.chatInfo) {
			header.push(t.fg("dim", `model: ${safeInline(node.model ?? "pending / unknown", 160)}`));
			const usage = cumulativeUsageLine(node), effort = thinkingDetailLine(node.thinking, node.thinkingEffective);
			if (usage) header.push(t.fg("dim", usage));
			if (effort) header.push(t.fg("dim", effort));
		}
		const available = this.contentRows();
		// Rules separate identity, conversation and keys once the conversation keeps a useful height.
		const roomy = available >= header.length + 10;
		const footer: string[] = [];
		const composer = this.steering ? this.steerRows(safeInline(node.label) || "agent", roomy) : undefined;
		if (composer) footer.push(...composer.rows);
		else {
			const controls = this.hintLine(stoppable, steerable);
			if (roomy) footer.push(this.rule());
			footer.push(...this.hintRows(`esc back · ↑↓/Pg scroll · / search · e expand · i info · m raw/md${controls} · F9 close`, `esc back · ↑↓/Pg scroll · / search${controls} · F9 close`, "esc back · F9 close").map((line) => t.fg("dim", line)));
		}
		if (this.notice) footer.push(t.fg("dim", safeInline(this.notice, 240)));
		if (roomy) header.push(this.rule());
		while (header.length + footer.length + 1 > available && header.length > 0) header.pop();
		while (header.length + footer.length + Number(!this.steering) > available && footer.length > 0) footer.pop();
		for (const line of header) this.addLine(line);
		this.mouseChatStart = inspectorFrame.layout(this.lastWidth, this.lastHeight).top + header.length;
		this.mouseChatRows = Math.max(0, available - header.length - footer.length);
		if (this.mouseChatRows) for (const line of view.render(this.inner(), this.mouseChatRows)) this.addLine(line);
		this.mouseInputRow = composer ? this.mouseChatStart + this.mouseChatRows + (footer.length > composer.input ? composer.input : 0) : -1;
		for (const line of footer) this.addLine(line);
		this.syncFocus();
	}

	private submitSteer(): void {
		const text = sanitizeTerminalText(this.steerInput.getValue()).trim();
		this.steering = false;
		this.resetSteerInput();
		this.syncFocus();
		if (text) {
			const nodes = this.tree.snapshot();
			const node = nodes.find((candidate) => candidate.id === this.detailId);
			if (!node || !this.canSteerNode(node, nodes) || !this.actions.onSteer?.(node.id, text)) this.notice = "steer unavailable for this worker";
		}
		this.refresh();
	}

	handleInput(keyData: string): void {
		// F9 is an unconditional close from every overlay mode; handle it before steering,
		// navigation or stop-all confirmation can interpret the same sequence.
		if (matchesKey(keyData, "f9")) {
			this.close();
			return;
		}
		const hadNotice = this.notice !== undefined;
		this.notice = undefined; // any key clears a previous refusal notice
		const armed = this.stopAllArmed;
		this.stopAllArmed = undefined; // only an immediately repeated X confirms
		const kb = this.keybindings;
		if (this.detailId) {
			// Steer mode: type a message into the running agent. Capture all printable keys
			// (so j/k/x type normally); ⏎ sends, esc cancels.
			if (this.steering) {
				// Input owns paste buffering and submit/cancel interpretation. In particular,
				// an Enter/Escape chunk inside a paste must remain text, not an action.
				const global = getKeybindings();
				try {
					if (global !== kb) setKeybindings(kb);
					this.steerInput.handleInput(keyData);
					const value = this.steerInput.getValue();
					const clean = sanitizeTerminalText(value);
					if (value !== clean) this.steerInput.setValue(clean);
				} finally {
					if (global !== kb) setKeybindings(global);
				}
				this.refresh();
				return;
			}
			const chat = this.detailChat();
			if (chat?.handleInput(keyData)) { this.refresh(); return; }
			if (chat && keyData === "i") { this.chatInfo = !this.chatInfo; this.refresh(); return; }
			const detailNode = this.tree.snapshot().find((node) => node.id === this.detailId);
			const page = this.pageDelta(keyData, this.detailCapacity);
			if (keyData === "s" && detailNode && this.canSteerNode(detailNode, this.tree.snapshot())) {
				this.steering = true;
				this.resetSteerInput();
				this.syncFocus();
				this.refresh();
			} else if (keyData === "x") this.tryStop(this.detailId);
			else if (page !== undefined) {
				this.detailScroll = Math.max(0, this.detailScroll - page);
				this.refresh();
			}
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
		const nodes = this.viewNodes();
		const leaves = this.selectableRows(nodes);
		const page = this.pageDelta(keyData, this.listCapacity);
		if (page !== undefined) {
			this.moveSelection(leaves, page);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(leaves, -1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(leaves, 1);
			this.refresh();
		} else if (keyData === " " || keyData === "\x1b[D" || keyData === "\x1b[C") {
			const leaf = this.selectedLeaf(leaves);
			if (leaf && isFoldableRow(leaf.node, nodes)) {
				const id = leaf.node.id;
				if (keyData === "\x1b[D" || (keyData === " " && !this.collapsedGroups.has(id))) this.collapsedGroups.add(id);
				else this.collapsedGroups.delete(id);
				this.actions.onGroupToggle?.();
				this.refresh();
			}
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
				this.resetSteerInput();
				this.syncFocus();
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

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const chat = this.detailId ? this.workerChats.get(this.detailId)?.view : undefined;
		if (chat && !this.steering && event.y >= this.mouseChatStart && event.y < this.mouseChatStart + this.mouseChatRows) {
			const layout = inspectorFrame.layout(this.lastWidth, this.lastHeight);
			if (chat.handleMouse({ ...event, x: event.x - (layout.framed ? 1 + layout.gutter : 0), y: event.y - this.mouseChatStart, height: this.mouseChatRows, width: layout.contentWidth })) {
				this.refresh();
				return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
			}
		}
		if (this.steering && event.y === this.mouseInputRow) {
			const layout = inspectorFrame.layout(this.lastWidth, this.lastHeight);
			const prefixWidth = visibleWidth(this.steerPrefix());
			const inputX = event.x - (layout.framed ? 1 + layout.gutter : 0) - prefixWidth;
			if (inputX >= 0 && inputX < layout.contentWidth - prefixWidth) {
				const result = this.steerInput.handleMouse({ ...event, x: inputX, y: 0, width: layout.contentWidth - prefixWidth, height: 1 });
				if (result?.handled || result?.focus) {
					this.refresh();
					return { ...result, handled: true, focusTarget: this, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
				}
			}
		}
		if (!this.detailId && !this.groupId && event.type === "click" && event.button === "left") {
			const id = this.mouseListIds[event.y - this.mouseListStart];
			const nodes = this.viewNodes();
			const node = nodes.find((candidate) => candidate.id === id);
			if (id && node && isFoldableRow(node, nodes)) {
				this.selectedId = id;
				if (!this.collapsedGroups.delete(id)) this.collapsedGroups.add(id);
				this.actions.onGroupToggle?.();
				this.refresh();
				return { handled: true, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
			}
		}
		return undefined;
	}

	private handleGroupInput(keyData: string, hadNotice: boolean): void {
		const nodes = this.viewNodes();
		const group = this.groupId ? projectAgentGroup(nodes, this.groupId) : undefined;
		if (!group) {
			// Consume this key in the disappeared view. It cannot fall through to a new tree target.
			this.groupId = undefined;
			this.refresh();
			return;
		}
		const kb = this.keybindings;
		const selected = this.selectedGroupLeg(group.legs);
		const page = this.pageDelta(keyData, this.groupCapacity);
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.groupId = undefined;
			this.refresh();
		} else if (page !== undefined || kb.matches(keyData, "tui.select.up") || keyData === "k" || kb.matches(keyData, "tui.select.down") || keyData === "j") {
			const delta = page ?? (kb.matches(keyData, "tui.select.up") || keyData === "k" ? -1 : 1);
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
				this.resetSteerInput();
				this.syncFocus();
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
		return node.kind !== "activity" && node.kind !== "resource-group" && node.kind !== "peer" && node.status === "running" && (this.actions.canStop?.(node.id) ?? !isAgentGroup(node, nodes));
	}

	/** The agents `X` would stop: every leaf that `x` could stop, wake sources excluded. `X` means
	 *  "stop every agent"; a monitor's job (it may be a two-hour batch) or a timer's alarm is cancelled
	 *  only by an explicit `x` on its own row. One list feeds the hint count, the confirmation prompt
	 *  and the bulk stop, so the three always agree. */
	private stoppableIds(snap: AgentNode[] = this.tree.snapshot()): string[] {
		// Stop-all is a runtime control set, not a projection of visible navigation rows: folding
		// hides descendants from the list but must not remove them from the bulk-stop target set.
		return snap.filter((node) => !isNonAgentNode(node) && this.canStopNode(node, snap)).map((node) => node.id);
	}

	/** The trailing "x stop"/"X stop all"/"s steer" entries of a key legend, in the one " · "
	 *  style every view uses. `stopAll` (list only) is the stoppable count; one agent is what
	 *  plain `x` is for. */
	private hintLine(stoppable: boolean, steerable: boolean, stopAll = 0): string {
		return `${stoppable ? " · x stop" : ""}${stopAll >= 2 ? ` · X stop all (${stopAll})` : ""}${steerable ? " · s steer" : ""}`;
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
		this.unsubscribePeers();
		this.workerChats.clear();
		this.displayCache = undefined;
		this.clear();
	}

	/** Read-only for tests: whether the live-clock tick is still armed. */
	get clockRunning(): boolean {
		return this.clock.running;
	}
}

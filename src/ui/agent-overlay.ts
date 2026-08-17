/**
 * A focusable overlay over the unified agent tree, opened with ctx.ui.custom
 * (overlay: true). ↑↓ navigate the *agents* (leaf rows; a parent like "delegate"
 * is a non-selectable header), ⏎ drills into one — its live output in an
 * auto-scrolling viewport sized to the terminal — `x` stops it, `s` steers it
 * (from the list too), esc backs out / closes. Subscribes to the tree, so it
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
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { type AgentTree, type FlatRow, flattenTree, GLYPH } from "./agent-tree.ts";
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

export class AgentOverlay extends Container {
	private tree: AgentTree;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private onStop: ((nodeId: string) => boolean) | undefined;
	private onSteer: ((nodeId: string, text: string) => boolean) | undefined;
	private canSteer: ((nodeId: string) => boolean) | undefined;
	private unsubscribe: () => void;
	private selectedId: string | undefined; // the selected agent's *id*, never its row index
	private aimLost = false; // the aimed-at agent settled: swallow the next directed keystroke
	private listScroll = 0; // list rows scrolled off the top (keeps the selection visible)
	private detailId: string | undefined;
	private detailScroll = 0; // output lines scrolled up from the bottom (0 = latest)
	private steering = false; // typing a steer message into the drilled-in agent
	private steerBuffer = "";
	private lastWidth = 100;
	private displayCache: { source: string; width: number; rows: string[] } | undefined;

	constructor(
		tree: AgentTree,
		tui: TUI,
		theme: Theme,
		done: () => void,
		onStop?: (nodeId: string) => boolean,
		onSteer?: (nodeId: string, text: string) => boolean,
		canSteer?: (nodeId: string) => boolean,
	) {
		super();
		this.tree = tree;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.onStop = onStop;
		this.onSteer = onSteer;
		this.canSteer = canSteer;
		this.unsubscribe = tree.onChange(() => this.refresh());
		this.rebuild();
	}

	private refresh(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	/** Frame the panel in a box so it stands out from the chat background. */
	override render(width: number): string[] {
		this.lastWidth = width;
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
	private detailViewport(): number {
		return Math.max(8, termRows() - 12);
	}

	/** List rows that fit: terminal height minus the overlay chrome. */
	private listViewport(): number {
		return Math.max(6, termRows() - 10);
	}

	private leafRows(): FlatRow[] {
		const snap = this.tree.snapshot();
		const parents = new Set(snap.map((n) => n.parentId).filter((p): p is string => p !== undefined));
		return flattenTree(snap).filter((r) => !parents.has(r.node.id));
	}

	/**
	 * The selected leaf, re-anchored by id on every use. The list is recomputed from the
	 * live tree, and agents are pruned from it as they settle: an index would slide `x`
	 * (stop) and `s` (steer) onto a *different* agent whenever an earlier sibling went
	 * away. When the aimed-at agent is the one that vanishes, fall back to the head of
	 * the list, where the ▸ marker visibly shows the user their target changed — and
	 * record that the aim was lost, for the directed keys (see `aimedLeaf`).
	 */
	private selectedLeaf(leaves: FlatRow[]): FlatRow | undefined {
		const anchored = this.selectedId !== undefined ? leaves.find((r) => r.node.id === this.selectedId) : undefined;
		const leaf = anchored ?? leaves[0];
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
		else this.renderList();
	}

	private renderList(): void {
		const t = this.theme;
		const rows = flattenTree(this.tree.snapshot());
		const selected = this.selectedLeaf(this.leafRows())?.node;
		this.addChild(new Text(t.fg("accent", t.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));
		if (rows.length === 0) {
			this.addChild(new Text(t.fg("dim", "(no agents running)"), 1, 0));
		} else {
			// Scroll window over the rows (a big fan-out must not overflow the screen);
			// the window follows the selection, ▲/▼ markers show what's off-screen.
			const vp = this.listViewport();
			const selIdx = Math.max(0, rows.findIndex((r) => r.node.id === selected?.id));
			this.listScroll = visibleWindow(selIdx, vp, rows.length, this.listScroll);
			const end = Math.min(rows.length, this.listScroll + vp);
			if (this.listScroll > 0) this.addChild(new Text(t.fg("dim", `▲ ${this.listScroll} above`), 1, 0));
			for (const row of rows.slice(this.listScroll, end)) {
				const indent = "  ".repeat(row.depth);
				const rowBudget = Math.max(24, this.inner() - visibleWidth(indent) - 4);
				const label = `${indent}${GLYPH[row.node.status]} ${safeInline(row.node.label, Math.max(16, Math.floor(rowBudget * 0.62))) || "agent"}`;
				const detail = row.node.detail
					? t.fg("dim", `  ${safeInline(row.node.detail, Math.max(16, Math.floor(rowBudget * 0.38)))}`)
					: "";
				const line = row.node.id === selected?.id ? t.fg("accent", `▸ ${label}`) : `  ${label}`;
				this.addChild(new Text(`${line}${detail}`, 1, 0));
			}
			if (end < rows.length) this.addChild(new Text(t.fg("dim", `▼ ${rows.length - end} below`), 1, 0));
		}
		this.addChild(new Spacer(1));
		const steerHint = selected && selected.status === "running" && (this.canSteer?.(selected.id) ?? false) ? "   s steer" : "";
		this.addChild(new Text(t.fg("dim", `↑↓ navigate   ⏎ open   x stop${steerHint}   esc close`), 1, 0));
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
		const node = this.tree.snapshot().find((n) => n.id === this.detailId);
		if (!node) {
			this.detailId = undefined;
			// The compose belonged to *that* agent — drop it, or the next drill-in would
			// re-open it pre-filled and send it to a different sub-agent. Re-rendering the
			// list also loses the anchor (the selection *is* the drilled-in agent), so an
			// `x` still in flight for it is refused instead of landing on the list beneath.
			this.steering = false;
			this.steerBuffer = "";
			this.renderList();
			return;
		}
		const live = node.status === "running";
		this.addChild(
			new Text(`${GLYPH[node.status]} ${t.fg("accent", t.bold(safeInline(node.label) || "agent"))}${live ? t.fg("success", "  ● live") : ""}`, 1, 0),
		);
		if (node.detail) this.addChild(new Text(t.fg("dim", safeInline(node.detail)), 1, 0));
		this.addChild(new Spacer(1));

		const raw = node.output?.trim()
			? node.output
			: live
				? "(working… the report appears here when the agent writes text — see its current tool above)"
				: "(no output)";
		const w = this.inner() - 1;
		const all = this.displayRows(raw, w);
		const viewport = this.detailViewport();
		const maxScroll = Math.max(0, all.length - viewport);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const end = all.length - this.detailScroll;
		const start = Math.max(0, end - viewport);
		if (start > 0) this.addChild(new Text(t.fg("dim", `▲ ${start} earlier`), 1, 0));
		for (const line of all.slice(start, end)) this.addChild(new Text(t.fg("toolOutput", line), 1, 0));
		if (this.detailScroll > 0) this.addChild(new Text(t.fg("dim", `▼ ${this.detailScroll} newer`), 1, 0));

		const steerable = live && (this.canSteer?.(node.id) ?? false);
		if (this.steering && !steerable) this.steering = false; // agent finished mid-compose
		this.addChild(new Spacer(1));
		if (this.steering) {
			// Wrap the input so a long steer message stays fully visible while typing.
			const composed = `${t.fg("accent", "steer ▸ ")}${this.steerBuffer}${t.fg("dim", "▌")}`;
			for (const line of wrapTextWithAnsi(composed, w)) this.addChild(new Text(line, 1, 0));
			this.addChild(new Text(t.fg("dim", "⏎ send   ·   esc cancel"), 1, 0));
		} else {
			const steerHint = steerable ? "   ·   s steer" : "";
			this.addChild(new Text(t.fg("dim", `esc back   ·   ↑↓ scroll${live ? "   ·   x stop" : ""}${steerHint}`), 1, 0));
			if (live && !steerable) {
				this.addChild(new Text(t.fg("dim", "(steer unavailable: no live handle yet, or this engine/broker does not expose one)"), 1, 0));
			}
		}
	}

	handleInput(keyData: string): void {
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
					if (text) this.onSteer?.(this.detailId, text);
					this.refresh();
				} else if (keyData === "\x7f" || keyData === "\b") {
					this.steerBuffer = this.steerBuffer.slice(0, -1);
					this.refresh();
				} else if (isPrintable(keyData)) {
					this.steerBuffer += keyData;
					this.refresh();
				}
				return;
			}
			if (keyData === "s" && (this.canSteer?.(this.detailId) ?? false)) {
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
			}
			return;
		}
		const leaves = this.leafRows();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(leaves, -1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(leaves, 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const leaf = this.selectedLeaf(leaves);
			if (leaf) {
				this.detailId = leaf.node.id;
				this.detailScroll = 0; // open at the latest output (auto-scroll to bottom)
				this.aimLost = false; // reading a row is harmless, and it re-takes aim on it
				this.refresh();
			}
		} else if (keyData === "s") {
			// Steer straight from the list: drill into the selected agent with the
			// compose line already open (same gate as the detail view's `s`).
			const leaf = this.aimedLeaf(leaves);
			if (leaf && leaf.node.status === "running" && (this.canSteer?.(leaf.node.id) ?? false)) {
				this.detailId = leaf.node.id;
				this.detailScroll = 0;
				this.steering = true;
				this.steerBuffer = "";
				this.refresh();
			}
		} else if (keyData === "x") {
			const leaf = this.aimedLeaf(leaves);
			if (leaf) this.tryStop(leaf.node.id);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
		}
	}

	/** Stop (abort) one agent by id, if it's running and stoppable. */
	private tryStop(nodeId: string): void {
		if (this.onStop?.(nodeId)) this.refresh();
	}

	private close(): void {
		this.unsubscribe();
		this.done();
	}

	dispose(): void {
		this.unsubscribe();
	}
}

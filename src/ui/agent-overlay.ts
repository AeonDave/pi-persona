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
	private selectedLeaf = 0; // index into the leaf rows
	private listScroll = 0; // list rows scrolled off the top (keeps the selection visible)
	private detailId: string | undefined;
	private detailScroll = 0; // output lines scrolled up from the bottom (0 = latest)
	private steering = false; // typing a steer message into the drilled-in agent
	private steerBuffer = "";
	private lastWidth = 100;

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

	private rebuild(): void {
		this.clear();
		if (this.detailId) this.renderDetail();
		else this.renderList();
	}

	private renderList(): void {
		const t = this.theme;
		const rows = flattenTree(this.tree.snapshot());
		const leaves = this.leafRows();
		if (this.selectedLeaf >= leaves.length) this.selectedLeaf = Math.max(0, leaves.length - 1);
		const selected = leaves[this.selectedLeaf]?.node;
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
				const detail = row.node.detail ? t.fg("dim", `  ${row.node.detail}`) : "";
				const label = `${indent}${GLYPH[row.node.status]} ${row.node.label}`;
				const line = row.node.id === selected?.id ? t.fg("accent", `▸ ${label}`) : `  ${label}`;
				this.addChild(new Text(`${line}${detail}`, 1, 0));
			}
			if (end < rows.length) this.addChild(new Text(t.fg("dim", `▼ ${rows.length - end} below`), 1, 0));
		}
		this.addChild(new Spacer(1));
		const steerHint = selected && selected.status === "running" && (this.canSteer?.(selected.id) ?? false) ? "   s steer" : "";
		this.addChild(new Text(t.fg("dim", `↑↓ navigate   ⏎ open   x stop${steerHint}   esc close`), 1, 0));
	}

	private renderDetail(): void {
		const t = this.theme;
		const node = this.tree.snapshot().find((n) => n.id === this.detailId);
		if (!node) {
			this.detailId = undefined;
			this.renderList();
			return;
		}
		const live = node.status === "running";
		this.addChild(
			new Text(`${GLYPH[node.status]} ${t.fg("accent", t.bold(node.label))}${live ? t.fg("success", "  ● live") : ""}`, 1, 0),
		);
		if (node.detail) this.addChild(new Text(t.fg("dim", node.detail), 1, 0));
		this.addChild(new Spacer(1));

		const raw = node.output?.trim()
			? node.output
			: live
				? "(working… the report appears here when the agent writes text — see its current tool above)"
				: "(no output)";
		const w = this.inner() - 1;
		// Wrap long lines instead of truncating — the user must be able to read the full
		// text. The viewport + scroll then operate over the wrapped display lines, so a
		// long message spans several rows rather than being cut off with an ellipsis.
		const all = raw.split("\n").flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, w);
			return wrapped.length > 0 ? wrapped : [""]; // keep blank lines (paragraph spacing)
		});
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
				this.addChild(new Text(t.fg("dim", "(steer unavailable: child-process/worktree run, or not started yet)"), 1, 0));
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
			this.selectedLeaf = Math.max(0, this.selectedLeaf - 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedLeaf = Math.min(Math.max(0, leaves.length - 1), this.selectedLeaf + 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const leaf = leaves[this.selectedLeaf];
			if (leaf) {
				this.detailId = leaf.node.id;
				this.detailScroll = 0; // open at the latest output (auto-scroll to bottom)
				this.refresh();
			}
		} else if (keyData === "s") {
			// Steer straight from the list: drill into the selected agent with the
			// compose line already open (same gate as the detail view's `s`).
			const leaf = leaves[this.selectedLeaf];
			if (leaf && leaf.node.status === "running" && (this.canSteer?.(leaf.node.id) ?? false)) {
				this.detailId = leaf.node.id;
				this.detailScroll = 0;
				this.steering = true;
				this.steerBuffer = "";
				this.refresh();
			}
		} else if (keyData === "x") {
			const leaf = leaves[this.selectedLeaf];
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

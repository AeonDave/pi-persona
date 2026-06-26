/**
 * A focusable overlay over the unified agent tree, opened with ctx.ui.custom
 * (overlay: true). ↑↓ navigate the *agents* (leaf rows; a parent like "delegate"
 * is a non-selectable header), ⏎ drills into one — its live output in a bounded,
 * auto-scrolling viewport — `x` stops it, esc backs out / closes. Subscribes to the
 * tree, so it re-renders live as agents stream.
 *
 * The pure parts (flatten/order, glyphs) live in agent-tree.ts and are unit-tested;
 * this file is the thin pi-tui glue (focus + keyboard + framing).
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
} from "@earendil-works/pi-tui";

import { type AgentTree, type FlatRow, flattenTree, GLYPH } from "./agent-tree.ts";

const VIEWPORT = 14; // detail output rows shown at once (the rest scrolls)

export class AgentOverlay extends Container {
	private tree: AgentTree;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private onStop: ((nodeId: string) => boolean) | undefined;
	private unsubscribe: () => void;
	private selectedLeaf = 0; // index into the leaf rows
	private detailId: string | undefined;
	private detailScroll = 0; // output lines scrolled up from the bottom (0 = latest)
	private lastWidth = 100;

	constructor(tree: AgentTree, tui: TUI, theme: Theme, done: () => void, onStop?: (nodeId: string) => boolean) {
		super();
		this.tree = tree;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.onStop = onStop;
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
		return Math.max(24, Math.min(this.lastWidth - 4, 100));
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
		const selectedId = leaves[this.selectedLeaf]?.node.id;
		this.addChild(new Text(t.fg("accent", t.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));
		if (rows.length === 0) {
			this.addChild(new Text(t.fg("dim", "(no agents running)"), 1, 0));
		} else {
			for (const row of rows) {
				const indent = "  ".repeat(row.depth);
				const detail = row.node.detail ? t.fg("dim", `  ${row.node.detail}`) : "";
				const label = `${indent}${GLYPH[row.node.status]} ${row.node.label}`;
				const line = row.node.id === selectedId ? t.fg("accent", `▸ ${label}`) : `  ${label}`;
				this.addChild(new Text(`${line}${detail}`, 1, 0));
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(t.fg("dim", "↑↓ navigate   ⏎ open   x stop   esc close"), 1, 0));
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

		const raw = node.output?.trim() ? node.output : live ? "(running… waiting for output)" : "(no output)";
		const all = raw.split("\n");
		const maxScroll = Math.max(0, all.length - VIEWPORT);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const end = all.length - this.detailScroll;
		const start = Math.max(0, end - VIEWPORT);
		const w = this.inner() - 1;
		if (start > 0) this.addChild(new Text(t.fg("dim", `▲ ${start} earlier`), 1, 0));
		for (const line of all.slice(start, end)) this.addChild(new Text(t.fg("toolOutput", truncateToWidth(line, w)), 1, 0));
		if (this.detailScroll > 0) this.addChild(new Text(t.fg("dim", `▼ ${this.detailScroll} newer`), 1, 0));

		this.addChild(new Spacer(1));
		this.addChild(new Text(t.fg("dim", `esc back   ·   ↑↓ scroll${live ? "   ·   x stop" : ""}`), 1, 0));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.detailId) {
			if (keyData === "x") this.tryStop(this.detailId);
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

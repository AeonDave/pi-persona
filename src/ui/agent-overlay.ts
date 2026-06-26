/**
 * A focusable overlay over the unified agent tree, opened with ctx.ui.custom
 * (overlay: true). ↑↓ navigate the flattened tree, ⏎ drills into the selected
 * agent (its captured output + usage), esc backs out of detail or closes the
 * overlay. It subscribes to the tree, so it re-renders live as agents progress.
 *
 * The pure parts (flatten/render order, status glyphs) live in agent-tree.ts and
 * are unit-tested; this file is the thin pi-tui glue (focus + keyboard).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";

import { type AgentTree, flattenTree, GLYPH } from "./agent-tree.ts";

export class AgentOverlay extends Container {
	private tree: AgentTree;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;
	private onStop: ((nodeId: string) => boolean) | undefined;
	private unsubscribe: () => void;
	private selectedIndex = 0;
	private detailId: string | undefined;

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
		const inner = Math.max(24, Math.min(width - 4, 100));
		const t = this.theme;
		const b = (s: string): string => t.fg("accent", s);
		const framed = super.render(inner).map((line) => {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			return `${b("│")} ${line}${pad} ${b("│")}`;
		});
		return [b(`┌${"─".repeat(inner + 2)}┐`), ...framed, b(`└${"─".repeat(inner + 2)}┘`)];
	}

	private rebuild(): void {
		this.clear();
		if (this.detailId) this.renderDetail();
		else this.renderList();
	}

	private renderList(): void {
		const t = this.theme;
		const rows = flattenTree(this.tree.snapshot());
		if (this.selectedIndex >= rows.length) this.selectedIndex = Math.max(0, rows.length - 1);
		this.addChild(new Text(t.fg("accent", t.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));
		if (rows.length === 0) {
			this.addChild(new Text(t.fg("dim", "(no agents running)"), 1, 0));
		} else {
			rows.forEach((row, i) => {
				const indent = "  ".repeat(row.depth);
				const detail = row.node.detail ? t.fg("dim", `  ${row.node.detail}`) : "";
				const label = `${indent}${GLYPH[row.node.status]} ${row.node.label}`;
				const line = i === this.selectedIndex ? t.fg("accent", `▸ ${label}`) : `  ${label}`;
				this.addChild(new Text(`${line}${detail}`, 1, 0));
			});
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
		const tail = all.slice(-28); // show the latest output (live tail)
		if (all.length > tail.length) {
			this.addChild(new Text(t.fg("dim", `…(${all.length - tail.length} earlier lines)`), 1, 0));
		}
		for (const line of tail) this.addChild(new Text(t.fg("toolOutput", line), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(t.fg("dim", live ? "esc back   ·   x stop" : "esc back"), 1, 0));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.detailId) {
			if (keyData === "x") this.tryStop(this.detailId);
			else if (kb.matches(keyData, "tui.select.cancel")) {
				this.detailId = undefined;
				this.refresh();
			}
			return;
		}
		const rows = flattenTree(this.tree.snapshot());
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const row = rows[this.selectedIndex];
			if (row) {
				this.detailId = row.node.id;
				this.refresh();
			}
		} else if (keyData === "x") {
			const row = rows[this.selectedIndex];
			if (row) this.tryStop(row.node.id);
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

/**
 * A focusable, searchable model picker opened with ctx.ui.custom (overlay: true).
 * Type to filter, ↑↓ to move, ⏎ to choose, esc to keep the default. Unlike the
 * built-in `ui.select`, the list is filterable (essential when a provider exposes
 * hundreds of models) and the viewport *follows the selection* — the highlighted
 * row is always on screen, so picking never jumps off the top.
 *
 * The pure parts (filter / viewport window / ordering) are exported and unit-tested;
 * this file's component is the thin pi-tui glue (focus + keyboard + framing).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const VIEWPORT = 12; // rows shown at once (the rest scrolls)

/** Case-insensitive substring filter over model refs; order preserved, empty query = all. */
export function filterModels(options: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return options;
	return options.filter((o) => o.toLowerCase().includes(q));
}

/** Scroll offset that keeps `selected` visible in a `size`-row window over `total`
 *  rows, moving as little as possible from `prevScroll`. Clamped to [0, total-size]. */
export function visibleWindow(selected: number, size: number, total: number, prevScroll: number): number {
	if (total <= size) return 0;
	let scroll = prevScroll;
	if (selected < scroll) scroll = selected; // selection above the window → pull up
	else if (selected >= scroll + size) scroll = selected - size + 1; // below → push down
	const maxScroll = Math.max(0, total - size);
	return Math.max(0, Math.min(scroll, maxScroll));
}

/** Order refs with the session provider's models first (then alphabetical). Pure. */
export function orderModelRefs(refs: string[], sessionProvider?: string): string[] {
	const isSession = (r: string): boolean => sessionProvider !== undefined && r.startsWith(`${sessionProvider}/`);
	return [...refs].sort((a, b) => Number(!isSession(a)) - Number(!isSession(b)) || a.localeCompare(b));
}

/** Is this keystroke a single printable character (a filter keystroke)? */
function isPrintable(key: string): boolean {
	if (key.length !== 1) return false;
	const c = key.charCodeAt(0);
	return c >= 0x20 && c !== 0x7f;
}

export class ModelPicker extends Container {
	private theme: Theme;
	private title: string;
	private options: string[];
	private sessionProvider: string | undefined;
	private done: (ref: string | undefined) => void;
	private tui: TUI;
	private query = "";
	private selected = 0;
	private scroll = 0;
	private lastWidth = 100;

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		options: string[],
		sessionProvider: string | undefined,
		done: (ref: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.options = options;
		this.sessionProvider = sessionProvider;
		this.done = done;
		this.rebuild();
	}

	private refresh(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	private filtered(): string[] {
		return filterModels(this.options, this.query);
	}

	override render(width: number): string[] {
		this.lastWidth = width;
		const inner = this.inner();
		const b = (s: string): string => this.theme.fg("accent", s);
		const framed = super.render(inner).map((line) => {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			return `${b("│")} ${line}${pad} ${b("│")}`;
		});
		return [b(`┌${"─".repeat(inner + 2)}┐`), ...framed, b(`└${"─".repeat(inner + 2)}┘`)];
	}

	private inner(): number {
		return Math.max(24, Math.min(this.lastWidth - 4, 100));
	}

	private rebuild(): void {
		this.clear();
		const t = this.theme;
		const list = this.filtered();
		if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
		this.scroll = visibleWindow(this.selected, VIEWPORT, list.length, this.scroll);
		const w = this.inner() - 1;

		this.addChild(new Text(t.fg("accent", t.bold(this.title)), 1, 0));
		const counter = t.fg("dim", `type to filter · ${list.length}/${this.options.length}`);
		const q = this.query ? t.fg("accent", `  «${this.query}»`) : "";
		this.addChild(new Text(`${counter}${q}`, 1, 0));
		this.addChild(new Spacer(1));

		if (list.length === 0) {
			this.addChild(new Text(t.fg("dim", "(no model matches — backspace to widen)"), 1, 0));
		} else {
			const end = Math.min(list.length, this.scroll + VIEWPORT);
			if (this.scroll > 0) this.addChild(new Text(t.fg("dim", `▲ ${this.scroll} above`), 1, 0));
			for (let i = this.scroll; i < end; i++) {
				const opt = list[i] as string;
				const star = this.sessionProvider && opt.startsWith(`${this.sessionProvider}/`) ? "★ " : "  ";
				const text = truncateToWidth(`${star}${opt}`, w);
				const row = i === this.selected ? t.fg("accent", `▸ ${text}`) : `  ${text}`;
				this.addChild(new Text(row, 1, 0));
			}
			if (end < list.length) this.addChild(new Text(t.fg("dim", `▼ ${list.length - end} below`), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(t.fg("dim", "↑↓ move   ·   ⏎ select   ·   esc keep default"), 1, 0));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const list = this.filtered();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.done(list[this.selected]);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
		} else if (keyData === "\x7f" || keyData === "\b") {
			if (this.query) {
				this.query = this.query.slice(0, -1);
				this.selected = 0;
				this.refresh();
			}
		} else if (isPrintable(keyData)) {
			this.query += keyData;
			this.selected = 0;
			this.refresh();
		}
	}
}

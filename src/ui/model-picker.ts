/**
 * A focusable, searchable model picker opened with ctx.ui.custom (overlay: true) in the shared
 * window frame (`window-chrome.ts`): title, titled search field, list, rule and key legend.
 * Type to filter, ↑↓ to move, ⏎ to choose, esc to keep the default. Unlike the
 * built-in `ui.select`, the list is filterable (essential when a provider exposes
 * hundreds of models) and the viewport *follows the selection* — the highlighted
 * row is always on screen, so picking never jumps off the top.
 *
 * Machine-facing filtering/ordering remain separate from human fuzzy search.
 * Only caller-supplied options are eligible; metadata never adds choices.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container, CURSOR_MARKER, type Focusable, fuzzyFilter, getKeybindings, Input,
	renderFakeCursor, setKeybindings, type TUI, type TuiMouseEvent, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";
import { inspectorFrame, type InspectorFrameLayout } from "./inspector-frame.ts";
import { sanitizeTerminalText } from "./presentation.ts";
import { composeWindow, keyLabel, navigationKeys } from "./window-chrome.ts";

/** Structural subset of host snapshots; no registry lookup or availability policy here. */
export interface ModelPickerMetadata {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	reasoning?: boolean;
	input?: readonly string[];
}

export interface ModelPickerConfig {
	currentRef?: string;
	models?: readonly ModelPickerMetadata[];
	keybindings?: KeybindingsManager;
}

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

/** One safe display line; never use this to rewrite a returned model ref. */
function displayText(value: string): string {
	return sanitizeTerminalText(value)
		.replace(/[\n\r\t\u2028\u2029]/g, " ")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function metadataText(model: ModelPickerMetadata | undefined): string {
	if (!model) return "";
	const parts: string[] = [];
	const context = model.contextWindow;
	if (context !== undefined && Number.isSafeInteger(context) && context > 0) {
		const size = context >= 1_000_000 ? `${Math.round(context / 100_000) / 10}m`
			: context >= 1000 ? `${Math.round(context / 100) / 10}k` : String(context);
		parts.push(`${size} ctx`);
	}
	if (model.reasoning === true) parts.push("reasoning");
	if (model.input?.includes("image")) parts.push("vision");
	// Functional metadata gets scarce columns before a potentially long/duplicated display name.
	if (model.name && model.name !== model.id) parts.push(truncateToWidth(displayText(model.name), 32));
	return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export class ModelPicker extends Container implements Focusable {
	private theme: Theme;
	private title: string;
	private options: string[];
	private sessionProvider: string | undefined;
	private currentRef: string | undefined;
	private done: (ref: string | undefined) => void;
	private tui: TUI;
	private input: Input;
	private keybindings: ReturnType<typeof getKeybindings>;
	private models = new Map<string, ModelPickerMetadata>();
	private list: string[];
	private selected = 0;
	private scroll = 0;
	private pastePending = false;
	private pasteTail = "";
	/** Where the last render drew the search row, for pointer mapping. */
	private pointer: { layout: InspectorFrameLayout; inputRow: number; inputColumn: number } | undefined;

	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		options: string[],
		sessionProvider: string | undefined,
		done: (ref: string | undefined) => void,
		config: ModelPickerConfig = {},
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.title = displayText(title);
		this.options = [...options];
		this.list = this.options;
		this.sessionProvider = sessionProvider;
		this.currentRef = config.currentRef;
		this.done = done;
		this.keybindings = config.keybindings ?? getKeybindings();
		for (const model of config.models ?? []) this.models.set(`${model.provider}/${model.id}`, model);
		this.selected = Math.max(0, this.list.indexOf(config.currentRef ?? ""));
		this.input = new Input({
			prompt: "",
			placeholder: "Search name, id or provider",
			placeholderStyle: (text) => this.theme.fg("dim", text),
		});
		this.addChild(this.input);
	}

	private search(): void {
		const previous = this.list[this.selected];
		const query = this.input.getValue().trim();
		this.list = fuzzyFilter(this.options, query, (ref) =>
			displayText(`${ref} ${this.models.get(ref)?.name ?? ""}`));
		// Full qualified refs beat name/token scores, without changing the caller's order at rest.
		if (query) {
			const literal = this.list.indexOf(query);
			const exact = literal >= 0 ? literal : this.list.findIndex((ref) => ref.toLowerCase() === query.toLowerCase());
			if (exact >= 0) {
				if (exact > 0) this.list.unshift(...this.list.splice(exact, 1));
				this.selected = 0; // typing an exact ref must not confirm a surviving fuzzy sibling
				return;
			}
		}
		this.selected = previous === undefined ? 0 : Math.max(0, this.list.indexOf(previous));
	}

	/** Drawn in the shared window frame, sized from the terminal the way every window is. */
	override render(width: number): string[] {
		const columns = Math.max(0, Math.floor(width));
		if (columns === 0) return [];
		const layout = inspectorFrame.layout(columns, inspectorFrame.viewportRows(this.tui.terminal?.rows ?? 24));
		const kb = this.keybindings;
		const cancel = keyLabel(kb, "tui.select.cancel");
		const keys = `${navigationKeys(kb)} move · ${keyLabel(kb, "tui.select.confirm")} select · ${cancel} keep default`;
		const window = composeWindow(this.theme, layout, {
			title: this.title,
			field: { title: `Search · ${this.list.length}/${this.options.length}`, label: "search", render: (columns) => this.searchRow(columns) },
			legend: [`${keys} · ✓ current · ★ session provider`, keys, `${cancel} keep default`],
			minBody: 3,
			body: (rows, columns) => this.listRows(rows, columns),
		});
		this.pointer = { layout, inputRow: window.inputRow, inputColumn: window.inputColumn };
		// Frame lines use the host dialogs' `border` token; the title and selection keep `accent`.
		return inspectorFrame.render(window.lines, layout, (text) => this.theme.fg("border", text));
	}

	private searchRow(columns: number): string {
		const line = this.input.render(columns)[0] ?? "";
		// Native Input can overrun a one-column viewport with a wide cursor grapheme.
		return visibleWidth(line) > columns ? `${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(" ")}` : line;
	}

	private listRows(rows: number, columns: number): string[] {
		const t = this.theme;
		const fit = (line: string): string => truncateToWidth(line, columns, "…");
		if (!this.list.length) return [t.fg("dim", fit("(no model matches — edit search to widen)"))];
		const markers = this.list.length > rows && rows >= 3;
		const capacity = Math.max(1, rows - (markers ? 2 : 0));
		this.scroll = visibleWindow(this.selected, capacity, this.list.length, this.scroll);
		const end = Math.min(this.list.length, this.scroll + capacity);
		const lines: string[] = [];
		if (markers && this.scroll > 0) lines.push(t.fg("dim", fit(`▲ ${this.scroll} above`)));
		for (let i = this.scroll; i < end; i++) {
			const ref = this.list[i]!;
			const current = ref === this.currentRef ? "✓" : " ";
			const star = this.sessionProvider && ref.startsWith(`${this.sessionProvider}/`) ? "★" : " ";
			// Ref comes first; friendly name and bounded, explicit metadata spend only spare columns.
			const row = fit(`${i === this.selected ? "▸" : " "} ${current}${star} ${displayText(ref)}${metadataText(this.models.get(ref))}`);
			lines.push(i === this.selected ? t.fg("accent", row) : row);
		}
		if (markers && end < this.list.length) lines.push(t.fg("dim", fit(`▼ ${this.list.length - end} below`)));
		return lines;
	}

	/** A press on the search row goes to the native Input, offset by the frame and the field prefix. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const pointer = this.pointer;
		if (!pointer || pointer.inputRow < 0 || event.y !== pointer.layout.top + pointer.inputRow) return undefined;
		const width = pointer.layout.contentWidth - pointer.inputColumn;
		const x = event.x - (pointer.layout.framed ? 1 + pointer.layout.gutter : 0) - pointer.inputColumn;
		if (x < 0 || x >= width) return undefined;
		const result = this.input.handleMouse({ ...event, x, y: 0, width, height: 1 });
		if (!result?.handled && !result?.focus) return undefined;
		this.invalidate();
		this.tui.requestRender();
		return { ...result, handled: true, focusTarget: this, target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		// While Input buffers a bracketed paste, even a standalone Enter/Escape
		// chunk is text, not a picker action. Retain only enough tail to detect
		// an end marker split across chunks; Input owns the actual paste buffer.
		const pasteData = this.pasteTail + keyData;
		const editingPaste = this.pastePending || keyData.includes("\x1b[200~");
		this.pastePending = editingPaste && !pasteData.includes("\x1b[201~");
		this.pasteTail = this.pastePending ? pasteData.slice(-5) : "";
		if (!editingPaste && kb.matches(keyData, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (!editingPaste && kb.matches(keyData, "tui.select.down")) {
			this.selected = Math.min(Math.max(0, this.list.length - 1), this.selected + 1);
		} else if (!editingPaste && kb.matches(keyData, "tui.select.confirm")) {
			const ref = this.list[this.selected];
			if (ref !== undefined) this.done(ref);
			return;
		} else if (!editingPaste && kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
			return;
		} else {
			const before = this.input.getValue();
			// Input has no per-instance keybindings API (Pi 1.4). Scope its global
			// lookup to this synchronous call and restore it even if handling throws.
			const global = getKeybindings();
			try {
				if (global !== kb) setKeybindings(kb);
				this.input.handleInput(keyData);
			} finally {
				if (global !== kb) setKeybindings(global);
			}
			const value = this.input.getValue();
			const safe = displayText(value);
			if (safe !== value) this.input.setValue(safe);
			if (before !== safe) this.search();
		}
		this.invalidate();
		this.tui.requestRender();
	}
}

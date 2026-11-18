/**
 * The window conventions every pi-persona window draws inside {@link inspectorFrame}: an
 * accent-bold title, dim rules, titled input fields and a dim key legend wrapped between its
 * entries, with key labels derived from the live keybindings. Pure functions over explicit
 * width, rows, theme and bindings, so the agents panel, the model picker and the settings page
 * cannot drift apart. The frame object itself stays the companion contract; this module is local.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager, type OverlayOptions } from "@earendil-works/pi-tui";

import { inspectorFrame, type InspectorFrameLayout } from "./inspector-frame.ts";
import { compactInlineText } from "./presentation.ts";

type Painter = Pick<Theme, "fg" | "bold">;
type Bindings = Pick<KeybindingsManager, "getKeys">;

/** Actions whose legend label is a single glyph or key list. */
export type LabelledAction = "tui.select.confirm" | "tui.select.cancel" | "tui.input.submit" | "tui.select.pageUp" | "tui.select.pageDown";

/** The share of the host's columns every window takes. */
const WIDTH_PERCENT = 90;

/** The overlay geometry every window opens with: 90% wide, the frame's row allocation, one-cell margin. */
export function windowOverlayOptions(terminalRows: number): OverlayOptions {
	return { width: `${WIDTH_PERCENT}%`, maxHeight: inspectorFrame.viewportRows(terminalRows), margin: 1 };
}

/** Columns of a window drawn in the editor slot: the overlay's width, centred with its margin. */
export function inlineWindowColumns(hostWidth: number): { left: number; width: number } {
	const host = Math.max(1, Math.floor(hostWidth));
	const width = Math.max(1, Math.min(Math.floor((host * WIDTH_PERCENT) / 100), host - 2));
	return { left: Math.floor((host - width) / 2), width };
}

export function keyLabel(keybindings: Bindings, action: LabelledAction): string {
	const keys = keybindings.getKeys(action);
	if (action !== "tui.select.cancel" && keys.includes("enter")) return "⏎";
	if (action === "tui.select.cancel" && keys.includes("escape")) return "esc";
	return keys.map((key) => key.replace(/pageUp/i, "PgUp").replace(/pageDown/i, "PgDn")).join("/") || "unbound";
}

export function navigationKeys(keybindings: Bindings): string {
	const up = keybindings.getKeys("tui.select.up");
	const down = keybindings.getKeys("tui.select.down");
	return up.includes("up") && down.includes("down") ? "↑↓" : `${up.join("/") || "unbound"}/${down.join("/") || "unbound"}`;
}

/** A divider across the content width, optionally carrying a section title. */
export function windowRule(theme: Painter, width: number, title = ""): string {
	const columns = Math.max(0, width);
	const label = title ? truncateToWidth(compactInlineText(title, { maxChars: 96 }), Math.max(0, columns - 6), "…") : "";
	if (!label) return theme.fg("dim", "─".repeat(columns));
	return `${theme.fg("dim", "── ")}${theme.fg("accent", theme.bold(label))} ${theme.fg("dim", "─".repeat(Math.max(0, columns - visibleWidth(label) - 4)))}`;
}

/** Wrap a key legend between its entries, so no row ends mid-entry ("F9" / "close"). */
export function packLegend(text: string, width: number): string[] {
	const separator = text.includes(" · ") ? " · " : "   ";
	const rows: string[] = [];
	let row = "";
	for (const entry of text.split(separator).map((part) => part.trim()).filter(Boolean)) {
		const next = row ? row + separator + entry : entry;
		if (row && visibleWidth(next) > width) { rows.push(row); row = entry; } else row = next;
	}
	if (row) rows.push(row);
	return rows.flatMap((line) => wrapTextWithAnsi(line, width));
}

/** The legend that fits: the full one, else the compact one, else the primary entry alone. */
export function legendRows(width: number, contentRows: number, full: string, compact: string, primary: string): string[] {
	const limit = Math.max(1, Math.min(3, contentRows - 2));
	for (const text of [full, compact]) {
		const rows = packLegend(text, width);
		if (rows.length <= limit) return rows;
	}
	return [primary];
}

/** A field is drawn titled (rule, input row, closing rule) only with this many content columns. */
export const TITLED_FIELD_MIN_WIDTH = 12;

/** An input row's prefix: a bare chevron under its titled rule, a labelled one when compact. */
export function fieldPrefix(width: number, titled: boolean, label: string): string {
	return titled ? "› " : width >= TITLED_FIELD_MIN_WIDTH ? `${label} ▸ ` : width >= 4 ? "› " : "";
}

/** Titled-field rows: the rule naming the field, the input row and the rule that closes it. */
export function titledField(theme: Painter, width: number, title: string, input: string): string[] {
	return [windowRule(theme, width, title), input, windowRule(theme, width)];
}

export interface WindowField {
	/** Carried by the field's top rule, e.g. "Search · 3/12". */
	title: string;
	/** Names the field when it is too short for its rules, e.g. "search ▸ ". */
	label: string;
	/** The editable text after the prefix, at most `width` columns. */
	render(width: number): string;
}

export interface WindowSpec {
	/** Plain text; painted accent and bold. */
	title: string;
	/** Styled rows under the title, given up from the last when rows are short. */
	meta?: readonly string[];
	/** An input field under the header; it brings its own rules. */
	field?: WindowField | undefined;
	/** Full, compact and primary legends, plain text with " · " between entries. */
	legend: readonly [full: string, compact: string, primary: string];
	/** A styled one-row notice under the legend. */
	notice?: string | undefined;
	/** Rows the content should keep before chrome is given up (default 1). */
	minBody?: number;
	/** The content rows, at most `rows`, drawn `width` columns wide. */
	body(rows: number, width: number): string[];
}

export interface WindowRows {
	lines: string[];
	/** Content row of the input field, or -1 when it is not drawn. Add `layout.top` for pointer rows. */
	inputRow: number;
	/** Columns taken by the input row's prefix. */
	inputColumn: number;
}

/**
 * Compose one window's content rows: title, meta, the field (or a rule), the body, a rule, the
 * legend and a notice. When the frame is short, decoration goes before information and the body
 * keeps `minBody` rows: rules first, then meta rows, the field's own rules, the long legend, the
 * notice, the title, the legend and finally the input row itself.
 */
export function composeWindow(theme: Painter, layout: InspectorFrameLayout, spec: WindowSpec): WindowRows {
	const width = layout.contentWidth;
	const available = layout.contentRows;
	const minBody = Math.min(available, Math.max(1, spec.minBody ?? 1));
	const [full, compact, primary] = spec.legend;
	const meta = [...spec.meta ?? []];
	let rules = true;
	let titled = spec.field !== undefined && width >= TITLED_FIELD_MIN_WIDTH;
	let legend = available >= 3 ? legendRows(width, available, full, compact, primary) : [];
	let notice = spec.notice !== undefined;
	let title = true;
	let field = spec.field !== undefined;
	const fieldRows = (): number => field ? titled ? 3 : 1 : rules ? 1 : 0;
	const chrome = (): number => Number(title) + meta.length + fieldRows() + Number(rules) + legend.length + Number(notice);
	// Each step gives up one piece of chrome and reports whether it had anything left to give.
	const steps: Array<() => boolean> = [
		() => { const had = rules; rules = false; return had; },
		() => meta.pop() !== undefined,
		() => { const had = titled; titled = false; return had; },
		() => {
			const short = legendRows(width, 3, full, compact, primary);
			if (legend.length <= short.length) return false;
			legend = short;
			return true;
		},
		() => { const had = notice; notice = false; return had; },
		() => { const had = title; title = false; return had; },
		() => { const had = legend.length > 0; legend = []; return had; },
		() => { const had = field; field = false; return had; },
	];
	for (const step of steps) {
		while (available - chrome() < minBody) if (!step()) break;
	}

	const lines: string[] = [];
	if (title) lines.push(theme.fg("accent", theme.bold(truncateToWidth(compactInlineText(spec.title, { maxChars: 240 }), width, "…"))));
	lines.push(...meta);
	let inputRow = -1;
	let inputColumn = 0;
	if (field && spec.field) {
		const prefix = fieldPrefix(width, titled, spec.field.label);
		inputColumn = visibleWidth(prefix);
		const input = theme.fg("accent", prefix) + spec.field.render(Math.max(1, width - inputColumn));
		inputRow = lines.length + Number(titled);
		lines.push(...(titled ? titledField(theme, width, spec.field.title, input) : [input]));
	} else if (rules) lines.push(windowRule(theme, width));
	const bodyRows = Math.max(0, available - chrome());
	lines.push(...spec.body(bodyRows, width).slice(0, bodyRows));
	if (rules) lines.push(windowRule(theme, width));
	lines.push(...legend.map((row) => theme.fg("dim", row)));
	if (notice && spec.notice !== undefined) lines.push(spec.notice);
	return { lines: lines.slice(0, available), inputRow, inputColumn };
}

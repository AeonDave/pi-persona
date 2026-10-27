import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";
import type { SettingId, SettingKind } from "../core/settings.ts";

export interface SettingsPanelRow {
	id: SettingId;
	group: string;
	label: string;
	description: string;
	kind: SettingKind;
	choices?: readonly string[];
	activeValue: unknown;
	savedValue: unknown;
	hasSavedValue: boolean;
	source: "environment" | "saved" | "default";
	locked: boolean;
	pendingReload?: boolean;
	unavailableReason?: string;
	applyWhen: string;
	min?: number;
	max?: number;
}

export interface SettingsPanelData {
	file: string;
	lastPersona: string | null;
	rows: readonly SettingsPanelRow[];
	notice?: string;
	initialQuery?: string;
	initialSelectedId?: SettingId;
}

export type SettingsPanelAction =
	| { type: "edit"; id: SettingId }
	| { type: "reset"; id: SettingId }
	| { type: "models" }
	| { type: "diagnostics" }
	| { type: "close" };

/** Case-insensitive search across the registry's user-facing metadata; source order is retained. */
export function filterSettingsRows(rows: readonly SettingsPanelRow[], query: string): SettingsPanelRow[] {
	const needle = sanitizeTerminalText(query).trim().toLocaleLowerCase();
	if (!needle) return [...rows];
	return rows.filter((row) => {
		const haystack = [row.id, row.group, row.label, row.description, row.applyWhen]
			.concat(row.choices ?? [])
			.join(" ")
			.toLocaleLowerCase();
		return haystack.includes(needle);
	});
}

/** Scroll offset that keeps the selected setting inside a bounded list viewport. */
export function visibleSettingsWindow(selected: number, size: number, total: number, previous: number): number {
	const count = Math.max(0, Math.floor(total));
	const page = Math.max(1, Math.floor(size));
	if (count <= page) return 0;
	const index = Math.max(0, Math.min(Math.floor(selected), count - 1));
	let scroll = Math.max(0, Math.floor(previous));
	if (index < scroll) scroll = index;
	else if (index >= scroll + page) scroll = index - page + 1;
	return Math.max(0, Math.min(scroll, count - page));
}

/** Human-readable, one-line values for settings rows and details. */
export function formatSettingValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	if (value === null) return "(unset)";
	if (typeof value === "boolean") return value ? "On" : "Off";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "(invalid number)";
	if (Array.isArray(value)) {
		if (value.length === 0) return "(empty list)";
		return value.map((item) => compactInlineText(String(item), { maxChars: 160 })).join(", ");
	}
	if (typeof value === "string") return compactInlineText(value, { maxChars: 160 }) || "(empty)";
	return compactInlineText(String(value), { maxChars: 160 }) || "(empty)";
}

/** One fully composed list entry, clipped by terminal columns rather than JS string length. */
export function composeSettingsRow(row: SettingsPanelRow, selected: boolean, maxColumns: number, theme: Theme): string {
	const width = Math.max(1, Math.floor(maxColumns));
	const marker = selected ? theme.fg("accent", "▸ ") : "  ";
	const group = theme.fg("dim", `[${compactInlineText(row.group, { maxChars: 32 })}] `);
	const label = compactInlineText(row.label, { maxChars: Math.max(16, Math.floor(width * 0.55)) });
	const value = compactInlineText(formatSettingValue(row.activeValue), { maxChars: Math.max(16, Math.floor(width * 0.44)) });
	const source = row.unavailableReason ? theme.fg("warning", "  unavailable") : row.locked ? theme.fg("warning", "  env locked") : row.hasSavedValue ? theme.fg("dim", "  saved") : "";
	const valueText = theme.fg("dim", `  ${value}`);
	return fitLine(`${marker}${group}${label}${valueText}${source}`, width);
}

function fitLine(line: string, width: number): string {
	// Callers sanitize all registry, path, and stored-value text before applying theme roles. Keep
	// those trusted theme escapes intact so the host palette survives truncation and layout.
	// Do not normalize ordinary spaces: columnLines uses them to keep the detail column aligned.
	const safe = line.replace(/[\r\n]+/g, " ");
	if (visibleWidth(safe) <= width) return safe;
	return truncateToWidth(safe, width, "…");
}

function wrappedLines(text: string, width: number): string[] {
	const safe = sanitizeTerminalText(text).replace(/\r\n?/g, "\n");
	const rendered = new Text(safe, 0, 0).render(Math.max(1, width));
	return rendered.map((line) => fitLine(line, Math.max(1, width)));
}

function detailLines(row: SettingsPanelRow, width: number, limit: number, theme: Theme): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [theme.fg("accent", theme.bold(compactInlineText(row.label, { maxChars: 160 })))];
	lines.push(theme.fg("dim", `Group: ${compactInlineText(row.group, { maxChars: 100 })}`));
	if (row.unavailableReason) lines.push(...wrappedLines(row.unavailableReason, safeWidth));
	const fixedLines = row.pendingReload ? 7 : 6;
	const description = wrappedLines(row.description, safeWidth).slice(0, Math.max(1, Math.min(3, limit - fixedLines)));
	lines.push(...description);
	lines.push(`Active now: ${formatSettingValue(row.activeValue)}`);
	lines.push(`Saved override: ${row.hasSavedValue ? formatSettingValue(row.savedValue) : "none"}`);
	lines.push(`Source: ${row.locked ? "environment · locked" : row.source}`);
	if (row.pendingReload) lines.push("Status: saved value is pending /reload");
	lines.push(`Applies: ${compactInlineText(row.applyWhen, { maxChars: 120 })}`);
	if (row.locked && row.choices?.length) lines.push("Environment value must be unset to edit.");
	return lines.slice(0, Math.max(1, limit)).map((line) => fitLine(line, safeWidth));
}

function listLines(
	rows: readonly SettingsPanelRow[],
	selectedIndex: number,
	height: number,
	width: number,
	previousScroll: number,
	theme: Theme,
): { lines: string[]; scroll: number } {
	const limit = Math.max(1, height);
	if (rows.length === 0) return { lines: [theme.fg("dim", "No settings match this filter.")], scroll: 0 };
	const needsMarkers = rows.length > limit;
	const itemCount = Math.max(1, limit - (needsMarkers ? 2 : 0));
	const scroll = visibleSettingsWindow(selectedIndex, itemCount, rows.length, previousScroll);
	const end = Math.min(rows.length, scroll + itemCount);
	const lines: string[] = [];
	if (scroll > 0) lines.push(theme.fg("dim", `↑ ${scroll} settings above`));
	for (let index = scroll; index < end; index++) {
		const row = rows[index];
		if (row) lines.push(composeSettingsRow(row, index === selectedIndex, width, theme));
	}
	if (end < rows.length) lines.push(theme.fg("dim", `↓ ${rows.length - end} settings below`));
	return { lines: lines.slice(0, limit).map((line) => fitLine(line, width)), scroll };
}

function columnLines(left: readonly string[], right: readonly string[], leftWidth: number, rightWidth: number, width: number): string[] {
	const count = Math.max(left.length, right.length);
	const gap = "  ";
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		const leftLine = fitLine(left[index] ?? "", leftWidth);
		const pad = Math.max(0, leftWidth - visibleWidth(leftLine));
		const rightLine = fitLine(right[index] ?? "", rightWidth);
		lines.push(fitLine(`${leftLine}${" ".repeat(pad)}${gap}${rightLine}`, width));
	}
	return lines;
}

function isPrintable(key: string): boolean {
	if (key.length !== 1) return false;
	const code = key.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

/** Full-page settings workbench. Dialogs are returned as actions so command handlers can use Pi's native prompts. */
export class PersonaSettingsPanel implements Component {
	private query: string;
	private searchMode = false;
	private selectedIndex = 0;
	private scroll = 0;
	private lastWidth = 80;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly data: SettingsPanelData;
	private readonly onAction: (action: SettingsPanelAction) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		data: SettingsPanelData,
		onAction: (action: SettingsPanelAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.data = data;
		this.onAction = onAction;
		this.query = data.initialQuery ?? "";
		const initialRows = filterSettingsRows(data.rows, this.query);
		const initialIndex = data.initialSelectedId
			? initialRows.findIndex((row) => row.id === data.initialSelectedId)
			: -1;
		this.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
	}

	get searchQuery(): string {
		return this.query;
	}

	get selectedId(): SettingId | undefined {
		return filterSettingsRows(this.data.rows, this.query)[this.selectedIndex]?.id;
	}

	invalidate(): void {
		// Rendering is derived entirely from the small immutable snapshot passed by the command.
	}

	render(width: number): string[] {
		const pageWidth = Math.max(1, Math.floor(width));
		this.lastWidth = pageWidth;
		const rows = filterSettingsRows(this.data.rows, this.query);
		if (this.selectedIndex >= rows.length) this.selectedIndex = Math.max(0, rows.length - 1);
		const selected = rows[this.selectedIndex];
		const terminalRows = Math.max(8, Math.floor(this.tui.terminal.rows || 24));
		const title = this.theme.fg("accent", this.theme.bold("Persona settings"));
		const file = fitLine(this.theme.fg("dim", `Configuration file: ${compactInlineText(this.data.file, { maxChars: 240 })}`), pageWidth);
		const remembered = fitLine(this.theme.fg("dim", `Remembered persona: ${this.data.lastPersona ? compactInlineText(this.data.lastPersona, { maxChars: 120 }) : "none"}`), pageWidth);
		// Show the configured primary binding; listing every alias would hide close/edit on narrow screens.
		const keys = (action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string =>
			this.keybindings.getKeys(action).slice(0, 1).map((key) => key === "escape" ? "esc" : key).join("/") || "unbound";
		const move = `${keys("tui.select.up")}/${keys("tui.select.down")}`;
		const confirm = keys("tui.select.confirm");
		const cancel = keys("tui.select.cancel");
		const filter = this.searchMode
			? this.theme.fg("accent", `Filter (type, backspace, ${confirm}): ${compactInlineText(this.query, { maxChars: 120 })}▌`)
			: this.query
				? this.theme.fg("dim", `Filter: ${compactInlineText(this.query, { maxChars: 120 })}`)
				: this.theme.fg("dim", "Filter: press / to search");
		const header = [fitLine(title, pageWidth), file, remembered, fitLine(filter, pageWidth), ""];
		const footer = [
			...(this.data.notice ? [fitLine(this.theme.fg("warning", compactInlineText(this.data.notice, { maxChars: 200 })), pageWidth)] : []),
			...(pageWidth < 76
				? [`${move} move  ${confirm} edit  r reset`, `/ filter  m models  d info  ${cancel} close`]
				: [`${move} move  ${confirm} edit  r reset  / filter  m models  d diagnostics  ${cancel} close`])
				.map((hint) => fitLine(this.theme.fg("dim", hint), pageWidth)),
		];
		const bodyHeight = Math.max(1, terminalRows - header.length - footer.length);
		let body: string[];
		if (!selected) {
			body = [this.theme.fg("dim", "No settings match this filter.")];
		} else if (pageWidth >= 80) {
			const leftWidth = Math.max(24, Math.floor((pageWidth - 2) * 0.42));
			const rightWidth = Math.max(1, pageWidth - leftWidth - 2);
			const listing = listLines(rows, this.selectedIndex, bodyHeight, leftWidth, this.scroll, this.theme);
			this.scroll = listing.scroll;
			const details = detailLines(selected, rightWidth, bodyHeight, this.theme);
			body = columnLines(listing.lines, details, leftWidth, rightWidth, pageWidth);
		} else {
			const detailsBudget = Math.min(Math.max(3, Math.floor(bodyHeight * 0.55)), Math.max(1, bodyHeight - 1));
			const listBudget = Math.max(1, bodyHeight - detailsBudget - 1);
			const listing = listLines(rows, this.selectedIndex, listBudget, pageWidth, this.scroll, this.theme);
			this.scroll = listing.scroll;
			const details = detailLines(selected, pageWidth, Math.max(1, bodyHeight - listing.lines.length - 1), this.theme);
			body = [...listing.lines, "", ...details].slice(0, bodyHeight);
		}
		const output = [...header, ...body, ...footer].slice(0, terminalRows);
		return output.map((line) => fitLine(line, pageWidth));
	}

	handleInput(key: string): void {
		const matches = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean =>
			this.keybindings.matches(key, binding);
		const rows = filterSettingsRows(this.data.rows, this.query);
		if (this.searchMode) {
			if (matches("tui.select.cancel")) {
				this.query = "";
				this.searchMode = false;
				this.selectedIndex = 0;
				this.scroll = 0;
			} else if (matches("tui.select.confirm")) {
				this.searchMode = false;
			} else if (key === "\x7f" || key === "\b") {
				this.query = this.query.slice(0, -1);
				this.selectedIndex = 0;
				this.scroll = 0;
			} else if (isPrintable(key) && key !== "/") {
				this.query += key;
				this.selectedIndex = 0;
				this.scroll = 0;
			}
			this.tui.requestRender();
			return;
		}
		if (matches("tui.select.cancel")) {
			if (this.query) {
				this.query = "";
				this.selectedIndex = 0;
				this.scroll = 0;
			} else this.onAction({ type: "close" });
		} else if (key === "/") {
			this.searchMode = true;
		} else if (matches("tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matches("tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
		} else if (matches("tui.select.confirm")) {
			const row = rows[this.selectedIndex];
			if (row) this.onAction({ type: "edit", id: row.id });
		} else if (key.toLocaleLowerCase() === "r") {
			const row = rows[this.selectedIndex];
			if (row) this.onAction({ type: "reset", id: row.id });
		} else if (key.toLocaleLowerCase() === "m") {
			this.onAction({ type: "models" });
		} else if (key.toLocaleLowerCase() === "d") {
			this.onAction({ type: "diagnostics" });
		}
		this.tui.requestRender();
	}

	/** Exposed to command handlers so reopening after a native dialog preserves navigation. */
	get viewState(): { query: string; selectedId: SettingId | undefined } {
		return { query: this.query, selectedId: this.selectedId };
	}

	get pageWidth(): number {
		return this.lastWidth;
	}
}

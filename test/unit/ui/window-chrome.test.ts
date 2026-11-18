import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

import { inspectorFrame } from "../../../src/ui/inspector-frame.ts";
import { composeWindow, fieldPrefix, inlineWindowColumns, keyLabel, legendRows, navigationKeys, packLegend, windowOverlayOptions, windowRule, type WindowSpec } from "../../../src/ui/window-chrome.ts";

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
const tagged = { fg: (role: string, text: string) => `<${role}>${text}</>`, bold: (text: string) => `*${text}*` } as Theme;

test("key labels and navigation keys are derived from the live bindings, with the shared glyphs", () => {
	const defaults = new KeybindingsManager(TUI_KEYBINDINGS);
	assert.equal(keyLabel(defaults, "tui.select.confirm"), "⏎");
	assert.equal(keyLabel(defaults, "tui.select.cancel"), "esc");
	assert.equal(keyLabel(defaults, "tui.select.pageUp"), "PgUp");
	assert.equal(navigationKeys(defaults), "↑↓");
	const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": ["ctrl+p"], "tui.select.down": ["ctrl+n"], "tui.select.confirm": ["ctrl+s"], "tui.select.cancel": ["ctrl+q", "f4"] });
	assert.equal(keyLabel(custom, "tui.select.confirm"), "ctrl+s");
	assert.equal(keyLabel(custom, "tui.select.cancel"), "ctrl+q/f4");
	assert.equal(navigationKeys(custom), "ctrl+p/ctrl+n");
	assert.equal(keyLabel({ getKeys: () => [] }, "tui.select.confirm"), "unbound");
});

test("rules span the content width exactly; a titled rule carries an accent title", () => {
	for (const width of [1, 6, 7, 20, 80]) {
		assert.equal(visibleWidth(windowRule(plain, width)), width);
		assert.ok(visibleWidth(windowRule(plain, width, "Search · 3/12")) <= Math.max(width, 4), `${width}`);
	}
	assert.equal(windowRule(plain, 20, "Search"), "── Search ──────────");
	assert.match(windowRule(tagged, 20, "Search"), /<accent>\*Search\*<\/>/);
});

test("legends wrap between entries and fall back to the compact, then the primary entry", () => {
	assert.deepEqual(packLegend("↑↓ move · ⏎ select · esc close", 16), ["↑↓ move", "⏎ select", "esc close"]);
	assert.deepEqual(packLegend("↑↓ move · ⏎ select · esc close", 80), ["↑↓ move · ⏎ select · esc close"]);
	assert.deepEqual(legendRows(16, 20, "↑↓ move · ⏎ select · esc close", "⏎ select · esc close", "esc close"), ["↑↓ move", "⏎ select", "esc close"]);
	assert.deepEqual(legendRows(16, 4, "↑↓ move · ⏎ select · esc close", "⏎ select · esc close", "esc close"), ["⏎ select", "esc close"], "four content rows allow a two-row legend");
	assert.deepEqual(legendRows(16, 3, "↑↓ move · ⏎ select · esc close", "⏎ select · esc close", "esc close"), ["esc close"]);
	assert.equal(fieldPrefix(40, true, "search"), "› ");
	assert.equal(fieldPrefix(40, false, "search"), "search ▸ ");
	assert.equal(fieldPrefix(8, false, "search"), "› ");
	assert.equal(fieldPrefix(3, false, "search"), "");
});

test("every window opens with the shared overlay geometry, and an editor-slot window copies its columns", () => {
	assert.deepEqual(windowOverlayOptions(40), { width: "90%", maxHeight: inspectorFrame.viewportRows(40), margin: 1 });
	assert.deepEqual(inlineWindowColumns(100), { left: 5, width: 90 });
	assert.deepEqual(inlineWindowColumns(12), { left: 1, width: 10 }, "a narrow host keeps a one-column margin");
	for (let host = 1; host <= 200; host++) {
		const { left, width } = inlineWindowColumns(host);
		assert.ok(width >= 1 && left >= 0 && left + width <= host, `${host}`);
	}
});

function spec(overrides: Partial<WindowSpec> = {}): WindowSpec & { asked: number[] } {
	const asked: number[] = [];
	return {
		title: "Pick a model",
		meta: ["meta one", "meta two"],
		field: { title: "Search · 3/12", label: "search", render: (width) => "q".repeat(Math.min(3, width)) },
		legend: ["↑↓ move · ⏎ select · esc keep default", "⏎ select · esc keep default", "esc keep default"],
		body: (rows) => { asked.push(rows); return Array.from({ length: rows }, (_, i) => `row ${i}`); },
		...overrides,
		asked,
	};
}

test("a roomy window reads title, meta, titled field, body, rule and legend in that order", () => {
	const layout = inspectorFrame.layout(60, 20);
	const window = spec({ notice: "saved" });
	const { lines, inputRow, inputColumn } = composeWindow(plain, layout, window);
	const rule = "─".repeat(layout.contentWidth);
	assert.deepEqual(lines.slice(0, 6), ["Pick a model", "meta one", "meta two", windowRule(plain, layout.contentWidth, "Search · 3/12"), "› qqq", rule]);
	assert.equal(inputRow, 4);
	assert.equal(inputColumn, 2);
	assert.deepEqual(lines.slice(-3), [rule, "↑↓ move · ⏎ select · esc keep default", "saved"]);
	assert.equal(lines.length, layout.contentRows, "the body takes every row the chrome leaves");
	assert.deepEqual(window.asked, [layout.contentRows - 9]);
});

test("without a field a plain rule separates the header; a tight window sheds rules, meta, field title, legend, notice, then title", () => {
	const unfielded = composeWindow(plain, inspectorFrame.layout(60, 20), spec({ field: undefined }));
	assert.equal(unfielded.inputRow, -1);
	assert.equal(unfielded.lines[3], "─".repeat(54));
	const chromeByRows = new Map<number, number>();
	for (let height = 20; height >= 1; height--) {
		const layout = inspectorFrame.layout(30, height);
		const window = spec({ notice: "saved", minBody: 3 });
		const { lines, inputRow } = composeWindow(plain, layout, window);
		assert.ok(lines.length <= layout.contentRows, `${height}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= layout.contentWidth), `${height}`);
		const body = window.asked[0] ?? 0;
		assert.ok(body >= Math.min(3, layout.contentRows), `the body keeps its minimum at ${height}: ${body}`);
		chromeByRows.set(layout.contentRows, lines.length - body);
		if (inputRow >= 0) assert.match(lines[inputRow]!, /qqq$/);
		if (layout.contentRows >= 8) assert.equal(lines[0], "Pick a model", `the title outlives the other chrome at ${height}`);
	}
	const chrome = [...chromeByRows].sort(([a], [b]) => b - a).map(([, rows]) => rows);
	assert.deepEqual(chrome, [...chrome].sort((a, b) => b - a), "chrome only shrinks as the content rows do");
	const tiny = spec({ minBody: 3 });
	const smallest = composeWindow(plain, inspectorFrame.layout(30, 5), tiny);
	assert.deepEqual(smallest.lines, ["row 0", "row 1", "row 2"], "a window with three rows keeps its content");
	assert.equal(smallest.inputRow, -1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { compactVisibleText, sanitizeTerminalText } from "../../../src/ui/presentation.ts";
import { createCardFrame, type CardFrameContext, type CardFramePresentation } from "../../../src/ui/card-frame.ts";

initTheme("dark", false);

function fakeTheme(backgrounds: string[], foregrounds: string[], prefix = ""): Theme {
	return {
		fg: (token: string, text: string) => { foregrounds.push(token); return `${prefix}${text}`; },
		bold: (text: string) => text,
		bg: (token: string, text: string) => { backgrounds.push(token); return text; },
	} as unknown as Theme;
}

function presentation(overrides: Partial<CardFramePresentation> = {}): CardFramePresentation {
	return {
		title: "Update · complete",
		state: "success",
		full: "first line\nsecond line\nTAIL",
		preview: (width) => ({ text: `visible ${"x".repeat(Math.max(0, Math.min(width - 8, 30)))}`, truncated: true }),
		...overrides,
	};
}

function context(overrides: Partial<CardFrameContext> = {}, backgrounds: string[] = [], foregrounds: string[] = []): CardFrameContext {
	return {
		expanded: false,
		theme: fakeTheme(backgrounds, foregrounds),
		outputPad: 0,
		detailHint: () => "to expand",
		...overrides,
	};
}

function visibleRows(component: Component, width: number): string[] {
	return component.render(width).map((line) => line.trimEnd());
}

test("standalone literal frame sanitizes its own preview and chrome, keeps the full card literal, and hints only when truncated", () => {
	const backgrounds: string[] = [];
	const foregrounds: string[] = [];
	const input = presentation({
		title: "Update\u001b[31m · complete",
		metadata: "worker\u001b[2J",
		full: "literal **text**\u001b[2J\nTAIL",
		preview: () => ({ text: "short\u001b[2J", truncated: false }),
	});
	const before = JSON.stringify(input);
	const rows = visibleRows(createCardFrame(input, context({ outputPad: 1, detailHint: () => "expand\u001b[2J" }, backgrounds, foregrounds)), 80);
	assert.equal(rows[0], " Update · complete");
	assert.equal(rows[1], "   worker");
	assert.equal(rows[2], "   short");
	assert.equal(rows.length, 3, "a complete preview has no expand hint");
	const hinted = visibleRows(createCardFrame({ ...input, preview: () => ({ text: "short", truncated: true }) }, context({ detailHint: () => "expand\u001b[2J" })), 80);
	assert.equal(hinted.at(-1), "expand", "the sanitized expand hint appears only for hidden content");
	assert.deepEqual([...new Set(backgrounds)], ["toolSuccessBg"]);
	assert.equal(JSON.stringify(input), before, "presentation model remains untouched");

	const expanded = visibleRows(createCardFrame(input, context({ expanded: true, outputPad: 1 })), 80);
	assert.equal(expanded.slice(2).map((line) => line.slice(1)).join("\n"), sanitizeTerminalText(input.full));
	assert.match(expanded.join("\n"), /\*\*text\*\*/, "literal cards do not interpret Markdown");
});

test("frame uses the active paint theme and current width without caching colored output", () => {
	const backgrounds: string[] = [];
	const foregrounds: string[] = [];
	const activeTheme = fakeTheme(backgrounds, foregrounds, "paint-");
	const frame = createCardFrame(presentation(), context({ theme: activeTheme, detailHint: () => "expand" }, backgrounds, foregrounds));
	const first = frame.render(40).join("\n");
	assert.match(first, /paint-Update · complete/);
	assert.ok(backgrounds.length > 0);
	assert.deepEqual([...new Set(backgrounds)], ["toolSuccessBg"]);

	backgrounds.length = 0;
	foregrounds.length = 0;
	activeTheme.bg = (token: string, text: string) => { backgrounds.push(`new:${token}`); return text; };
	activeTheme.fg = (token: string, text: string) => { foregrounds.push(`new:${token}`); return `new-${text}`; };
	const second = frame.render(40).join("\n");
	assert.match(second, /new-Update · complete/);
	assert.ok(backgrounds.length > 0);
	assert.deepEqual([...new Set(backgrounds)], ["new:toolSuccessBg"]);
	assert.ok(visibleRows(frame, 12).every((line) => visibleWidth(line) <= 12));
});

test("frame preserves native Markdown for expanded reports and clamps padding at narrow widths", () => {
	const report = "### Review\n\n**Verdict:** accept\n\n- evidence\n\nTAIL";
	const input = presentation({ full: report, markdown: true });
	for (const outputPad of [0, 1, 2, 5]) {
		for (const expanded of [false, true]) {
			const component = createCardFrame(input, context({ outputPad, expanded }));
			for (const width of [0, 1, 2, 3, 8, 16, 40, 120]) {
				assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `padding=${outputPad}, expanded=${expanded}, width=${width}`);
			}
		}
	}
	const rendered = visibleRows(createCardFrame(input, context({ expanded: true, outputPad: 1 })), 240).join("\n");
	for (const expected of ["Review", "Verdict: accept", "evidence", "TAIL"]) assert.ok(rendered.includes(expected), expected);
});

test("frame chrome is one sanitized line while expanded literal and Markdown bodies retain their content", () => {
	const chrome = {
		title: " Update\n\n\u001b[31m· complete\u001b[0m",
		metadata: "worker\n\n\u001b[2Jactive",
	};
	const full = "line one\n\nline three\u001b[31m!";
	const literal = presentation({
		...chrome,
		full,
		preview: () => ({ text: "preview body", truncated: true }),
	});
	const collapsedRows = visibleRows(createCardFrame(literal, context({
		detailHint: () => "to expand\n\n\u001b[33mdetails",
	})), 80);
	assert.deepEqual(collapsedRows, ["Update · complete", "  worker active", "  preview body", "to expand details"]);

	const expandedLiteral = visibleRows(createCardFrame(literal, context({ expanded: true })), 80);
	assert.deepEqual(expandedLiteral.slice(2), ["line one", "", "line three!"]);

	const markdown = presentation({
		...chrome,
		full: "### Report\n\n**Body**\n\nTail\u001b[2J",
		markdown: true,
	});
	const markdownRows = visibleRows(createCardFrame(markdown, context({ expanded: true })), 80);
	assert.equal(markdownRows[0], "Update · complete");
	assert.equal(markdownRows[1], "worker active");
	assert.match(markdownRows.join("\n"), /Report/);
	assert.match(markdownRows.join("\n"), /Body/);
	assert.match(markdownRows.join("\n"), /Tail/);
	assert.ok(markdownRows.indexOf("") > markdownRows.findIndex((line) => line.includes("Report")), "Markdown body keeps its paragraph separation");
});

test("frame shows an expand hint when the actual narrow content column clips a preview", () => {
	const narrowPreview = (width: number) => {
		const result = compactVisibleText("😀".repeat(6), { maxLineChars: width });
		return { text: result.text, truncated: result.truncated };
	};
	const clippedRows = visibleRows(createCardFrame(presentation({ preview: narrowPreview }), context()), 12);
	assert.equal(clippedRows.at(-1), "to expand");
	assert.ok(clippedRows.some((line) => line.includes("😀")));

	const shortRows = visibleRows(createCardFrame(presentation({
		preview: (width) => {
			const result = compactVisibleText("short", { maxLineChars: width });
			return { text: result.text, truncated: result.truncated };
		},
	}), context()), 12);
	assert.equal(shortRows.length, 2, "an unclipped short preview does not show an expand hint");
});

test("an explicitly empty collapsed preview hides its body but hints at full detail", () => {
	const input = presentation({ full: "full detail\nTAIL", preview: () => ({ text: "", truncated: false }) });
	for (const outputPad of [0, 1]) {
		const rows = visibleRows(createCardFrame(input, context({ outputPad })), 80);
		assert.equal(rows.length, 2);
		assert.match(rows[1]!, /to expand/);
		assert.doesNotMatch(rows.join("\n"), /no output|full detail/);
		const expanded = visibleRows(createCardFrame(input, context({ outputPad, expanded: true })), 80).join("\n");
		assert.match(expanded, /full detail/);
		assert.match(expanded, /TAIL/);
		for (const width of [1, 2, 3, 8]) assert.ok(createCardFrame(input, context({ outputPad })).render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("optional expansion keys retain local clicks across rebuilds, follow host transitions, and isolate cards", () => {
	const key = {};
	const otherKey = {};
	const input = presentation();
	const make = (expansionKey: object, expanded = false) => createCardFrame(input, context({ expanded, expansionKey }));
	const click = { type: "click" as const, button: "left" as const, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 };
	const first = make(key);
	const independent = make(otherKey);
	first.handleMouse?.(click);
	assert.match(first.render(80).join("\\n"), /TAIL/, "click expands the first envelope");
	assert.doesNotMatch(independent.render(80).join("\\n"), /TAIL/, "another envelope remains collapsed");
	assert.match(make(key).render(80).join("\\n"), /TAIL/, "same host expanded value preserves clicked state on rebuild");
	assert.doesNotMatch(make(key, true).render(80).join("\\n"), /visible/, "a host transition to expanded overrides local state");
	const hostExpanded = make(key, true);
	hostExpanded.handleMouse?.(click);
	assert.match(hostExpanded.render(80).join("\\n"), /visible/, "local collapse works while host expanded stays true");
	assert.match(make(key, true).render(80).join("\\n"), /visible/, "same host state retains local collapse");
	assert.doesNotMatch(make(key, false).render(80).join("\\n"), /TAIL/, "a changed host value overrides local state");
});

test("expansion shell handles only primary clicks when content is hidden and remains opt-in", () => {
	const key = {};
	const click = { type: "click" as const, button: "left" as const, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 };
	const hidden = createCardFrame(presentation(), context({ expansionKey: key }));
	assert.equal(hidden.handleMouse?.({ ...click, button: "right" }), undefined);
	assert.equal(hidden.handleMouse?.({ ...click, type: "wheel", wheelDelta: -1 }), undefined);
	assert.equal(hidden.handleMouse?.({ ...click, type: "drag" }), undefined);
	assert.deepEqual(hidden.handleMouse?.({ ...click, shift: true }), { handled: true }, "native tool click behavior accepts modified primary clicks");
	assert.match(hidden.render(80).join("\\n"), /TAIL/);

	const fullCard = presentation({ full: "complete", preview: () => ({ text: "complete", truncated: false }) });
	const full = createCardFrame(fullCard, context({ expansionKey: {} }));
	assert.equal(full.handleMouse?.(click), undefined, "a card with no hidden content does not consume the click");
	const legacy = createCardFrame(presentation(), context());
	assert.equal(legacy.handleMouse, undefined, "without expansionKey the frame remains presentation-only");
});

test("width-clipped full previews are clickable whenever the frame displays an expansion hint", () => {
	const input = presentation({ full: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", preview: () => ({ text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", truncated: false }) });
	const frame = createCardFrame(input, context({ expansionKey: {} }));
	const collapsed = visibleRows(frame, 12);
	assert.equal(collapsed.at(-1), "to expand");
	const click = { type: "click" as const, button: "left" as const, x: 1, y: 1, screenX: 1, screenY: 1, width: 12, height: collapsed.length, shift: false, alt: false, ctrl: false, clickCount: 1 };
	assert.equal(frame.handleMouse?.(click)?.handled, true, "a visible expand hint must have a working click target");
	assert.deepEqual(visibleRows(frame, 12), visibleRows(createCardFrame(input, context({ expanded: true })), 12));
	assert.equal(frame.handleMouse?.(click)?.handled, true);
	assert.deepEqual(visibleRows(frame, 12), collapsed, "the same click collapses again");
});

test("empty full and preview bodies retain the nonempty literal fallback", () => {
	const input = presentation({ full: "", preview: () => ({ text: "", truncated: false }) });
	assert.match(visibleRows(createCardFrame(input, context()), 80).join("\n"), /\(no output\)/);
	assert.match(visibleRows(createCardFrame(input, context({ expanded: true })), 80).join("\n"), /\(no output\)/);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { boundDisplayRows, compactInlineText, compactVisibleText, sanitizeTerminalText } from "../../../src/ui/presentation.ts";

test("compactVisibleText removes fence boilerplate and bounds lines and width", () => {
	const input = [
		"2 async runs settled — 2 done, 0 failed",
		"",
		"✅ run-1 (orion) done:",
		"Sub-agent output (untrusted data):",
		`> ${"A".repeat(300)}`,
		"> second detail",
		"✅ run-2 (hera) done:",
		"> final detail",
	].join("\n");
	const preview = compactVisibleText(input, { maxLines: 4, maxLineChars: 80 });
	const lines = preview.text.split("\n");
	assert.equal(lines.length, 4);
	assert.ok(lines.every((line) => line.length <= 80));
	assert.doesNotMatch(preview.text, /Sub-agent output \(untrusted data\)/);
	assert.match(preview.text, /async runs settled/);
	assert.equal(preview.truncated, true);
	assert.ok(preview.omittedLines >= 1);
});

test("sanitizeTerminalText strips ANSI and terminal controls while preserving paragraphs", () => {
	const text = sanitizeTerminalText("safe\u001b[2J\u001b[31mred\u001b[0m\u0000\nnext\r\nline");
	assert.equal(text, "safered\nnext\nline");
});

test("sanitizeTerminalText erases an OSC payload without paying for an unterminated one", () => {
	// The payload between `ESC ]` and its terminator has to go too, under either
	// terminator — without the OSC branch this would read `hello0;PWNED-TITLEworld`.
	assert.equal(sanitizeTerminalText("hello\u001b]0;PWNED-TITLE\u0007world"), "helloworld");
	assert.equal(sanitizeTerminalText("hello\u001b]0;PWNED-TITLE\u001b\\world"), "helloworld");
	assert.equal(sanitizeTerminalText("a\u001b]0;multi\nline\u0007b"), "ab");
	// A child that emits `ESC ]` and never terminates it must still cost a single linear
	// pass: this runs synchronously on the render thread for every tick and keystroke.
	const hostile = "\u001b]".repeat(100_000);
	const started = performance.now();
	const stripped = sanitizeTerminalText(hostile);
	const elapsed = performance.now() - started;
	assert.equal(stripped, "");
	assert.ok(elapsed < 2000, `sanitizeTerminalText took ${Math.round(elapsed)}ms on 200KB of unterminated OSC`);
});

test("an over-long OSC payload is shown, not swallowed", () => {
	// The payload erase is what lets `ESC ]0;` hide text, so it has to stop somewhere: an
	// unbounded one lets a child fold its whole report behind one introducer, and leaves
	// the sequence 'still possibly opening' forever, which is what the overlay's row cache
	// keys off. Past the cap the introducer is stripped and the payload stays visible text.
	const payload = "SECRET ".repeat(2_000);
	const hidden = sanitizeTerminalText(`before\u001b]0;${payload}\u0007after`);
	assert.match(hidden, /^before/, "the text before the introducer survives");
	assert.match(hidden, /after$/, "and so does the text after the terminator");
	assert.ok(hidden.includes("SECRET"), "an over-long payload is not silently erased");
	assert.doesNotMatch(hidden, /\u001b|\u0007/, "while the control bytes themselves still go");
	// A normal-length title is still erased whole.
	assert.equal(sanitizeTerminalText("a\u001b]0;short title\u0007b"), "ab");
});

test("compactInlineText sanitizes metadata, folds whitespace, and clamps one-line chrome", () => {
	const text = compactInlineText(` safe\u001b[2J\n${"x".repeat(100)} `, { maxChars: 24 });
	assert.equal(text.length, 24);
	assert.doesNotMatch(text, /\u001b|\n/);
	assert.match(text, /^safe x+…$/);
});

test("compactInlineText bounds chrome in display columns, not only code units", () => {
	const wide = compactInlineText("漢".repeat(200), { maxChars: 96 });
	assert.ok(visibleWidth(wide) <= 96, `chrome occupied ${visibleWidth(wide)} terminal columns`);
	assert.ok(wide.length <= 96, `chrome was ${wide.length} code units`);
	assert.match(wide, /…$/);
});

test("compactVisibleText makes one enormous line safe for a collapsed card", () => {
	const preview = compactVisibleText("x".repeat(100_000), { maxLines: 3, maxLineChars: 120 });
	assert.equal(preview.text.length, 120);
	assert.equal(preview.truncated, true);
	assert.equal(preview.originalChars, 100_000);
});

test("boundDisplayRows keeps a live widget stable while exposing the full-list action", () => {
	const rows = Array.from({ length: 20 }, (_, index) => `peer-${index}`);
	const bounded = boundDisplayRows("local", rows, 7, "exocom_list for the full pool");
	assert.equal(bounded.length, 7);
	assert.equal(bounded[0], "local");
	assert.match(bounded.at(-1) ?? "", /\+15 more/);
	assert.match(bounded.at(-1) ?? "", /exocom_list/);
});


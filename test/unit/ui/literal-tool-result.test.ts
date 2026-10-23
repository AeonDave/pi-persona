import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { renderLiteralToolResult } from "../../../src/ui/literal-tool-result.ts";

initTheme("dark");

function harness() {
	const colors: string[] = [];
	const theme = { fg: (color: string, text: string) => { colors.push(color); return text; }, bold: (text: string) => text } as Theme;
	return { colors, theme };
}
function text(component: ReturnType<typeof renderLiteralToolResult>): string {
	return component.render(120).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

test("literal tool results honor the native context error flag without relying on result.isError", () => {
	const h = harness();
	const result = { content: [{ type: "text", text: "dispatch refused" }], details: {} };
	const rendered = text(renderLiteralToolResult(result, { expanded: false }, h.theme, { isError: true }));
	assert.match(rendered, /^failed\n/);
	assert.ok(h.colors.includes("error"));
	assert.doesNotMatch(rendered, /expand/);
});

test("literal result previews are bounded and expansion preserves all sanitized text and payload", () => {
	const h = harness();
	const source = Array.from({ length: 40 }, (_, i) => `evidence ${i} **literal**`).join("\n") + "\u001b[2J";
	const result = { content: [{ type: "text", text: source }], details: {} };
	const before = JSON.stringify(result);
	const view = renderLiteralToolResult(result, { expanded: false }, h.theme);
	assert.ok(!view.render(120).join("\n").includes("\u001b[2J"), "payload terminal controls are removed before rendering");
	const collapsed = text(view);
	assert.ok(collapsed.split("\n").length <= 5);
	assert.match(collapsed, /expand/);
	assert.doesNotMatch(collapsed, /evidence 39|\u001b/);
	const expanded = text(renderLiteralToolResult(result, { expanded: true }, h.theme));
	assert.match(expanded, /evidence 39 \*\*literal\*\*/);
	assert.doesNotMatch(expanded, /\u001b|expand/);
	assert.equal(JSON.stringify(result), before);
});

test("short receipts have no false expand affordance and retain all text parts", () => {
	const h = harness();
	const result = { content: [{ type: "text", text: "queued" }, { type: "text", text: "id=abc" }] };
	const collapsed = text(renderLiteralToolResult(result, { expanded: false }, h.theme));
	assert.equal(collapsed, "queued\nid=abc");
	assert.equal(text(renderLiteralToolResult(result, { expanded: true }, h.theme)), collapsed);
});

test("native context is authoritative; legacy direct calls can still provide result.isError", () => {
	const h = harness();
	const result = { content: [{ type: "text", text: "diagnostic" }], isError: true };
	assert.match(text(renderLiteralToolResult(result, { expanded: false }, h.theme)), /^failed/);
	assert.doesNotMatch(text(renderLiteralToolResult(result, { expanded: false }, h.theme, { isError: false })), /^failed/);
});

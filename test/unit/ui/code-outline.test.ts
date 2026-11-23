import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { makeCodeOutlineTool } from "../../../src/tools/code-outline.ts";

initTheme("dark", false);
const details = {
	symbols: Array.from({ length: 6 }, (_, i) => ({ name: `符号${i}`, kind: "method", container: "A.B", startLine: i + 1, endLine: i + 2 })),
	totalMatches: 9, returned: 6, hasMore: true, truncated: true, language: "TypeScript", grammar: "typescript", sha256: "a".repeat(64),
};
const content = [{ type: "text" as const, text: "Sub-agent output (untrusted data):\nCANONICAL SHA-256" }];
const plain = (rows: string[]) => stripVTControlCharacters(rows.join("\n"));

test("native outline card shows useful symbols, expands, and preserves canonical content", () => {
	const tool = makeCodeOutlineTool();
	const result = { content, details, isError: false };
	const before = JSON.stringify(result);
	const component = new ToolExecutionComponent("code_outline", "outline", { path: "src/示例.ts", query: "符号" }, { outputPad: 1 }, tool, { requestRender() {} } as unknown as TUI, process.cwd());
	component.updateResult(result);
	const collapsed = component.render(80);
	const text = plain(collapsed);
	assert.match(text, /符号0.*method.*A\.B.*L1-2/);
	assert.match(text, /6.*9/);
	assert.doesNotMatch(text, /CANONICAL|SHA-256|符号5/);
	const y = collapsed.length - 1;
	const click: TuiMouseEvent = { type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 80, height: collapsed.length, shift: false, alt: false, ctrl: false };
	assert.equal(component.handleMouse(click)?.handled, true);
	assert.match(plain(component.render(80)), /符号5/);
	assert.match(plain(component.render(80)), /hasMore=true.*truncated=true/);
	component.setExpanded(false);
	assert.doesNotMatch(plain(component.render(80)), /符号5/);
	component.setExpanded(true);
	assert.match(plain(component.render(80)), /符号5/);
	for (const width of [1, 2, 8, 20]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
	assert.equal(JSON.stringify(result), before);
});

test("malformed history and native errors fall back to literal content", () => {
	const tool = makeCodeOutlineTool();
	const component = new ToolExecutionComponent("code_outline", "saved", { path: "a.ts" }, {}, tool, { requestRender() {} } as unknown as TUI, process.cwd());
	component.updateResult({ content: [{ type: "text", text: "literal fallback" }], details: { ...details, returned: 999 }, isError: false } as never);
	assert.match(plain(component.render(80)), /literal fallback/);
	component.updateResult({ content: [{ type: "text", text: "parser failed" }], details, isError: true });
	assert.match(plain(component.render(80)), /failed[\s\S]*parser failed/);
});

test("a failed outline body honours the output pad like the call row and the success card", () => {
	const tool = makeCodeOutlineTool();
	const component = new ToolExecutionComponent("code_outline", "pad", { path: "a.ts" }, { outputPad: 2 }, tool, { requestRender() {} } as unknown as TUI, process.cwd());
	component.updateResult({ content: [{ type: "text", text: "parser failed" }], details, isError: true });
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		const rows = plain(component.render(80)).split("\n");
		const body = rows.filter((row) => /parser failed|^\s*failed\s*$/.test(row));
		assert.equal(body.length, 2, `heading and body rows (expanded=${expanded})`);
		for (const row of body) assert.match(row, /^ {2}\S/, `padded by outputPad (expanded=${expanded})`);
		for (const width of [1, 2, 5, 20]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	}
});

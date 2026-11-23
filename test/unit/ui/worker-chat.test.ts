import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkerChatSnapshot } from "../../../src/core/worker-chat.ts";
import { ChatViewport } from "../../../src/ui/chat-viewport.ts";
import { WorkerChatView } from "../../../src/ui/worker-chat.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const snapshot = (count: number): WorkerChatSnapshot => ({ truncated: false,
	blocks: Array.from({ length: count }, (_, i) => ({ kind: "assistant", id: `m${i}`, text: `message ${i}` })) });

test("chat viewport anchors the same block while earlier rows grow and new blocks arrive", () => {
	const viewport = new ChatViewport();
	const entries = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, lines: [`message ${i}`] }));
	viewport.setBlocks(entries);
	assert.deepEqual(viewport.render(5).lines, entries.slice(-5).flatMap((entry) => entry.lines));
	viewport.scrollBy(-8);
	const before = viewport.render(5).lines;
	viewport.setBlocks([{ id: "m0", lines: ["message 0", "extra", "extra"] }, ...entries.slice(1), { id: "last", lines: ["latest"] }]);
	assert.deepEqual(viewport.render(5).lines, before);
	assert.equal(viewport.following, false);
	assert.deepEqual(viewport.render(3).lines, before.slice(0, 3), "height-only resize preserves top anchor");
	viewport.end();
	assert.match(viewport.render(3).lines.join("\n"), /latest/);
});

test("worker chat follows live output until scrolling, supports page/home/end and bounded widths", () => {
	const view = new WorkerChatView(theme, keys);
	view.update(snapshot(40));
	assert.match(view.render(60, 12).join("\n"), /message 39/);
	view.handleInput("\x1b[5~");
	const before = view.render(60, 12).slice(0, -1);
	view.update(snapshot(45));
	assert.deepEqual(view.render(60, 12).slice(0, -1), before);
	view.handleInput("\x1b[H");
	assert.match(view.render(60, 12).join("\n"), /message 0\D/);
	view.handleInput("\x1b[F");
	assert.match(view.render(60, 12).join("\n"), /message 44/);
	for (const width of [40, 12, 4, 1]) {
		const rows = view.render(width, 5);
		assert.ok(rows.length <= 5);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
	}
});

test("chat searches collapsed arguments and errors, expands the match, and keeps controls as input", () => {
	const view = new WorkerChatView(theme, keys);
	view.update({ truncated: true, blocks: [
		{ kind: "user", id: "u", text: "review the file" },
		{ kind: "tool", id: "t", name: "external_tool", arguments: '{"path":"needle.ts"}', output: "permission denied\nsecond line\nthird line\nfourth line", status: "failed" },
	] });
	const initial = view.render(80, 15).join("\n");
	assert.match(initial, /external_tool.*failed/);
	assert.match(initial, /earlier|partial|trimmed/);
	view.handleInput("/");
	view.handleInput("needle");
	view.handleInput("\r");
	const found = view.render(80, 15).join("\n");
	assert.match(found, /needle.ts/);
	assert.match(found, /permission denied/);
	assert.match(found, /1\/1/);
	view.handleInput("/");
	assert.equal(view.handleInput("x"), true, "search owns a stop-looking character");
	assert.equal(view.handleInput("\x1b"), true, "first escape closes search, not the chat");
	assert.equal(view.handleInput("\x1b"), false, "second escape belongs to overlay back");
});

test("chat wheel and click use local coordinates; unchanged blocks reuse rendered lines", () => {
	const view = new WorkerChatView(theme, keys);
	const initial = snapshot(20);
	view.update(initial);
	view.render(50, 9);
	const rendered = view.renderedBlockCount;
	view.render(50, 7);
	assert.equal(view.renderedBlockCount, rendered, "height-only resize and idle frames never rewrap blocks");
	view.update({ ...initial, blocks: [...initial.blocks, { kind: "assistant", id: "new", text: "new final" }] });
	view.render(50, 7);
	assert.equal(view.renderedBlockCount, rendered + 1);
	assert.equal(view.handleMouse({ type: "wheel", wheelDelta: -6, y: 2, x: 2 } as TuiMouseEvent), true);
	assert.doesNotMatch(view.render(50, 7).slice(0, -1).join("\n"), /new final/);
});

test("chat never emits worker terminal control sequences or synthesizes a current-file diff", () => {
	const view = new WorkerChatView(theme, keys);
	view.update({ truncated: false, blocks: [
		{ kind: "tool", id: "t", name: "edit\x1b]0;hidden\x07", arguments: '{"path":"missing.ts"}', output: "- recorded old\n+ recorded new\x1b[2J", status: "done" },
	] });
	view.render(80, 12);
	view.toggleExpanded();
	const text = view.render(80, 12).join("\n");
	assert.match(text, /recorded old/);
	assert.match(text, /recorded new/);
	assert.doesNotMatch(text, /\x1b|hidden/);
});

test("search reveals a match deep inside a collapsed tool and refreshes when a block changes in place", () => {
	const view = new WorkerChatView(theme, keys);
	const tool = { kind: "tool" as const, id: "t", name: "read", arguments: "{}", output: `${"ordinary line\n".repeat(300)}deep needle here`, status: "done" as const };
	view.update({ truncated: false, blocks: [tool] });
	view.render(60, 10);
	view.handleInput("/"); view.handleInput("needle"); view.handleInput("\r");
	assert.match(view.render(60, 10).join("\n"), /deep needle here/);
	view.update({ truncated: false, blocks: [{ ...tool, output: "no matching text" }] });
	assert.match(view.render(60, 10).join("\n"), /0\/0/);
});

test("search keeps its native focused input visible even in a one-row chat", () => {
	const view = new WorkerChatView(theme, keys);
	view.focused = true;
	view.update(snapshot(10));
	view.render(30, 8);
	view.handleInput("/"); view.handleInput("search text");
	const text = view.render(20, 1).join("\n");
	assert.match(text, /search text/);
	assert.ok(text.includes(CURSOR_MARKER));
});

test("search jumps to a phrase crossing wrapped rows rather than the beginning of its tool", () => {
	const view = new WorkerChatView(theme, keys);
	view.update({ truncated: false, blocks: [{ kind: "tool", id: "t", name: "read", arguments: "{}",
		output: `${"ordinary\n".repeat(40)}needle phrase appears here`, status: "done" }] });
	view.render(10, 8);
	view.handleInput("/"); view.handleInput("needle phrase"); view.handleInput("\r");
	const text = view.render(10, 8).join("\n");
	assert.match(text, /needle/);
	assert.match(text, /phrase/);
});

test("opening, painting, searching and expanding recorded tool data performs no filesystem I/O", (t) => {
	const calls: string[] = [];
	for (const name of ["readFileSync", "openSync", "statSync", "lstatSync", "readdirSync", "existsSync"] as const) {
		t.mock.method(fs, name, () => { calls.push(name); throw new Error(`unexpected ${name}`); });
	}
	for (const name of ["readFile", "open", "stat", "lstat", "readdir", "access"] as const) {
		t.mock.method(fsPromises, name, async () => { calls.push(name); throw new Error(`unexpected ${name}`); });
	}
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const view = new WorkerChatView(theme, keys);
	view.update({ truncated: false, blocks: [
		{ kind: "tool", id: "edit", name: "edit", arguments: '{"path":"not-on-disk.ts"}', output: "- recorded old\n+ recorded new", status: "done" },
		{ kind: "tool", id: "external", name: "unknown_extension", arguments: "{}", output: "plain external result", status: "failed" },
	] });
	view.render(80, 12); view.toggleExpanded(); view.render(60, 10);
	view.handleInput("/"); view.handleInput("recorded new"); view.handleInput("\r"); view.render(60, 10);
	assert.deepEqual(calls, []);
});

test("collapsed long tool and thinking lines keep their headers visible without wrapping the whole payload", () => {
	for (const kind of ["tool", "thinking"] as const) {
		const view = new WorkerChatView(theme, keys);
		const output = `  recorded ${"界".repeat(8000)}\nTAIL`;
		view.update({ truncated: false, blocks: [kind === "tool"
			? { kind, id: "long", name: "bash", arguments: "{}", output, status: "failed" }
			: { kind, id: "long", text: output }] });
		for (const width of [80, 40, 20, 4, 1]) {
			const rows = view.render(width, 6);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			if (width >= 40) {
				assert.match(rows[0]!, kind === "tool" ? /bash.*failed.*expand/ : /thinking.*expand/);
				assert.match(rows[1]!, /^  recorded/);
				assert.match(rows[2]!, /TAIL/);
			}
		}
		view.toggleExpanded();
		view.handleInput("\x1b[F");
		assert.match(view.render(80, 6).join("\n"), /TAIL/);
	}
});

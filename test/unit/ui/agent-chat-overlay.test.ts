import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, KeybindingsManager, TUI_KEYBINDINGS, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { WorkerChatSnapshot } from "../../../src/core/worker-chat.ts";
import { AgentOverlay } from "../../../src/ui/agent-overlay.ts";
import { AgentTree, progressPatch, type AgentNode } from "../../../src/ui/agent-tree.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 26 }, requestRender() {} } as unknown as TUI;
const chat: WorkerChatSnapshot = { truncated: false, blocks: [
	{ kind: "user", id: "u", text: "original task" },
	{ kind: "tool", id: "t", name: "external", arguments: '{"query":"inspect"}', output: "recorded result", status: "done" },
	{ kind: "assistant", id: "a", text: "final worker message" },
] };

test("F9 renders a worker chat, returns to the same group/list selection and keeps fallback details", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "group", label: "Batch", kind: "delegate" });
	tree.add({ id: "a", label: "Alpha", parentId: "group", kind: "subagent", chat });
	tree.add({ id: "b", label: "Bravo", parentId: "group", kind: "subagent", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	// Selection initially aims a worker; opening it shows chat, not output fallback.
	overlay.render(90);
	overlay.handleInput("\n");
	assert.match(overlay.render(90).join("\n"), /original task/);
	assert.match(overlay.render(90).join("\n"), /external/);
	overlay.handleInput("\x1b");
	assert.match(overlay.render(90).join("\n"), /▸.*Alpha/);
	overlay.handleInput("k");
	overlay.handleInput("\n");
	assert.match(overlay.render(90).join("\n"), /Batch/);
	overlay.handleInput("j");
	overlay.handleInput("\n");
	assert.match(overlay.render(90).join("\n"), /Bravo/);
	overlay.handleInput("\x1b");
	assert.match(overlay.render(90).join("\n"), /▸.*Bravo/);
});

test("an open chat survives pruning without steering another worker; recent chats are read-only", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const sent: string[] = [];
	const recent: AgentNode = { id: "settled", label: "Earlier", status: "done", parentId: undefined, detail: undefined, chat };
	const overlay = new AgentOverlay(tree, tui, theme, () => {}, { recentWorkers: () => [recent],
		canSteer: () => true, onSteer: (id) => { sent.push(id); return true; } });
	t.after(() => overlay.dispose());
	overlay.render(90);
	overlay.handleInput("\n");
	tree.remove("a");
	tree.add({ id: "b", label: "Bravo" });
	assert.match(overlay.render(90).join("\n"), /final worker message/);
	overlay.handleInput("s");
	overlay.handleInput("hello");
	overlay.handleInput("\r");
	assert.deepEqual(sent, []);
	overlay.handleInput("\x1b");
	assert.match(overlay.render(90).join("\n"), /Recent workers/);
	assert.equal(tree.snapshot().some((node) => node.id === "settled"), false);
});

test("search focus swallows stop and steer characters and wheel scrolls the chat only", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat: { truncated: false, blocks:
		Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, kind: "assistant", text: `line ${i}` })) } });
	let stopped = 0;
	const overlay = new AgentOverlay(tree, tui, theme, () => {}, { canStop: () => true, onStop: () => { stopped++; return true; } });
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	overlay.render(90);
	overlay.handleInput("/");
	overlay.handleInput("x");
	assert.equal(stopped, 0);
	overlay.handleInput("\x1b");
	overlay.render(90);
	const result = overlay.handleMouse({ type: "wheel", button: "none", wheelDelta: -20, x: 5, y: 6, screenX: 5, screenY: 6, width: 90, height: 23 } as TuiMouseEvent);
	assert.equal(result?.handled, true);
	assert.doesNotMatch(overlay.render(90).join("\n"), /line 39/);
});

test("progress patch passes the immutable chat reference without putting it in activity text", () => {
	const patch = progressPatch({ chat, tokens: 7 }, 10);
	assert.equal(patch.chat, chat);
	assert.doesNotMatch(patch.detail ?? "", /original task|recorded result/);
});

test("chat keeps the runtime failure cause when no error message was streamed", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "failed", label: "Timed worker", status: "failed", detail: "timed out: raise timeoutMs", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	assert.match(overlay.render(90).join("\n"), /timed out: raise timeoutMs/);
	overlay.handleInput("i");
	assert.match(overlay.render(90).join("\n"), /timed out: raise timeoutMs/);
});

test("a retry that clears chat cannot resurrect the prior attempt after pruning", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	assert.match(overlay.render(90).join("\n"), /original task/);
	tree.add({ id: "a", label: "Alpha retry", chat: undefined, output: "" });
	tree.remove("a");
	assert.doesNotMatch(overlay.render(90).join("\n"), /original task|final worker message/);
});

test("a reused worker row starts a fresh reader after a retry", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	overlay.render(90);
	overlay.handleInput("/");
	overlay.handleInput("old search");
	tree.add({ id: "a", label: "Alpha retry", chat: undefined, output: "" });
	tree.update("a", { chat: { truncated: false, blocks: [
		{ kind: "assistant", id: "a", text: "new attempt output" },
	] } });
	const text = overlay.render(90).join("\n");
	assert.match(text, /new attempt output/);
	assert.doesNotMatch(text, /old search/);
});

test("clearing the tree releases an open chat instead of retaining it across sessions", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	overlay.render(90);
	tree.clear();
	assert.doesNotMatch(overlay.render(90).join("\n"), /original task|final worker message/);
});

test("clearing an already empty tree releases its open pruned chat", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	overlay.render(90);
	tree.remove("a");
	assert.equal(tree.isEmpty(), true);
	assert.match(overlay.render(90).join("\n"), /original task/);
	tree.clear();
	assert.doesNotMatch(overlay.render(90).join("\n"), /original task|final worker message/);
});

test("only an open reader can retain a pruned chat without a runtime owner", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	// Inspect ownership directly: rendering alone cannot prove the old payload was released.
	const readers = (overlay as unknown as { workerChats: Map<string, unknown> }).workerChats;
	overlay.handleInput("\n");
	overlay.render(90);
	tree.remove("a");
	assert.equal(readers.size, 1, "the open reader remains available after pruning");
	overlay.handleInput("\x1b");
	overlay.render(90);
	assert.equal(readers.size, 0, "leaving the pruned reader releases its payload and caches");
});

test("reader caches stay bounded and disposal releases rendered chat content", (t) => {
	const tree = new AgentTree();
	for (let i = 0; i < 12; i++) tree.add({ id: `worker-${i}`, label: `Worker ${i}`, chat });
	const overlay = new AgentOverlay(tree, tui, theme, () => {});
	t.after(() => overlay.dispose());
	const readers = (overlay as unknown as { workerChats: Map<string, unknown> }).workerChats;
	for (let i = 0; i < 12; i++) {
		overlay.handleInput("\n");
		overlay.render(90);
		assert.ok(readers.size <= 8);
		if (i < 11) { overlay.handleInput("\x1b"); overlay.handleInput("j"); }
	}
	assert.equal(readers.size, 8);
	assert.match(Container.prototype.render.call(overlay, 90).join("\n"), /original task/);
	overlay.dispose();
	assert.equal(readers.size, 0);
	assert.deepEqual(Container.prototype.render.call(overlay, 90), [], "the disposed container releases its rendered text too");
});

test("the worker chat legend advertises the live back and scroll bindings", (t) => {
	const tree = new AgentTree();
	tree.add({ id: "a", label: "Alpha", kind: "subagent", chat });
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+q", "tui.select.down": "ctrl+n", "tui.select.pageDown": "ctrl+f", "tui.select.pageUp": "ctrl+b" });
	const overlay = new AgentOverlay(tree, tui, theme, () => {}, { keybindings });
	t.after(() => overlay.dispose());
	overlay.render(120);
	overlay.handleInput("\n");
	const view = overlay.render(120).join("\n");
	assert.match(view, /ctrl\+q back/);
	assert.match(view, /up\/ctrl\+n/);
	assert.match(view, /ctrl\+b\/ctrl\+f/);
	assert.doesNotMatch(view, /esc back|↑↓/);
});

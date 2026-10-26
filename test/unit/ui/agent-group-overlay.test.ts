import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { AgentOverlay, type AgentOverlayActions } from "../../../src/ui/agent-overlay.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

const THEME = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const TUI_STUB = { requestRender: () => {} } as unknown as TUI;

function groupTree(): AgentTree {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "group", label: "Review council", kind: "council" });
	tree.add({ id: "phase", parentId: "group", label: "Review phase", kind: "phase" });
	tree.add({ id: "a", parentId: "phase", label: "Alpha", kind: "subagent", model: "provider/model-a", thinking: "xhigh", detail: "reading sources" });
	tree.add({ id: "b", parentId: "group", label: "Bravo", kind: "subagent", status: "done", output: "Brief result: checks passed", model: "provider/model-b", thinking: "high", thinkingEffective: "medium" });
	tree.add({ id: "c", parentId: "group", label: "Charlie", kind: "subagent", detail: "building" });
	return tree;
}

function openGroup(tree: AgentTree, actions: AgentOverlayActions = {}): AgentOverlay {
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, { now: () => 0, ...actions });
	// Initial aim stays on the worker; both ancestors become inspectable by moving up.
	overlay.handleInput("k");
	overlay.handleInput("k");
	overlay.handleInput("\n");
	return overlay;
}

test("F9 group overview counts legs once and drills into a leg then back to its group", (t) => {
	const overlay = openGroup(groupTree(), { isWaitingForSupervisor: (id) => id === "a" });
	t.after(() => overlay.dispose());
	const view = overlay.render(110).join("\n");
	assert.match(view, /Group overview.*Review council/);
	assert.match(view, /3 legs.*1 waiting.*1 running.*1 done/);
	assert.match(view, /reading sources/);
	assert.match(view, /Brief result: checks passed/);
	assert.match(view, /waiting for supervisor/);
	assert.match(view, /provider\/model-a/);
	assert.match(view, /model-b · h→m/);
	assert.doesNotMatch(view, /4 legs|5 legs/);
	overlay.handleInput("\n");
	assert.doesNotMatch(overlay.render(110).join("\n"), /Group overview/);
	assert.match(overlay.render(110).join("\n"), /model: provider\/model-a/);
	overlay.handleInput("\x1b");
	assert.match(overlay.render(110).join("\n"), /Group overview/);
	assert.match(overlay.render(110).join("\n"), /▸.*Alpha/);
	overlay.handleInput("\x1b");
	assert.match(overlay.render(110).join("\n"), /▸.*Review council/);
});

test("group selection keeps its id when an earlier leg disappears and refuses one directed key after its own removal", (t) => {
	const tree = groupTree();
	tree.update("b", { status: "running" });
	const stopped: string[] = [];
	const overlay = openGroup(tree, { canStop: (id) => id.length === 1, onStop: (id) => { stopped.push(id); return true; } });
	t.after(() => overlay.dispose());
	overlay.handleInput("j");
	tree.remove("a");
	assert.match(overlay.render(100).join("\n"), /▸.*Bravo/);
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["b"]);
	tree.remove("b");
	overlay.render(100);
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["b"], "a disappearing selection never transfers a destructive key");
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["b", "c"]);
});

test("a group disappearing before a key cannot stop an unrelated tree row", (t) => {
	const tree = groupTree();
	const stopped: string[] = [];
	const overlay = openGroup(tree, { onStop: (id) => { stopped.push(id); return true; } });
	t.after(() => overlay.dispose());
	tree.remove("group");
	tree.add({ id: "other", label: "Unrelated" });
	overlay.handleInput("x");
	assert.deepEqual(stopped, []);
	assert.match(overlay.render(80).join("\n"), /Unrelated/);
});

test("inspection alone grants no group controls and adds no containers to stop-all", (t) => {
	const tree = groupTree();
	tree.update("b", { status: "running" });
	const stopped: string[] = [];
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, {
		onStop: (id) => { stopped.push(id); return true; }, canSteer: () => true,
	});
	t.after(() => overlay.dispose());
	overlay.handleInput("k");
	overlay.handleInput("k");
	assert.match(overlay.render(110).join("\n"), /▸.*Review council/);
	overlay.handleInput("s");
	assert.doesNotMatch(overlay.render(110).join("\n"), /steer ▸/);
	overlay.handleInput("x");
	assert.deepEqual(stopped, [], "an inspectable root needs its own explicit stop permission");
	overlay.handleInput("X");
	assert.match(overlay.render(110).join("\n"), /press X again to stop 3 running agents/);
	overlay.handleInput("X");
	assert.deepEqual(stopped, ["a", "b", "c"]);
});

test("large group overview stays bounded and sanitizes hostile metadata in a narrow viewport", (t) => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "group", label: "Fan-out\x1b[2J", kind: "delegate" });
	for (let i = 0; i < 20; i++) tree.add({ id: `leg-${i}`, label: `Worker ${i}\x1b[31m`, parentId: "group", kind: "subagent", model: "provider/model".repeat(8), detail: "tool\x1b[2J " + "界".repeat(200), output: "payload\x1b]0;bad\x07\n".repeat(200) });
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, { now: () => 0 });
	t.after(() => overlay.dispose());
	overlay.handleInput("k");
	overlay.handleInput("\n");
	for (let i = 0; i < 19; i++) overlay.handleInput("j");
	const lines = overlay.render(40);
	assert.match(lines.join("\n"), /Group overview/);
	assert.match(lines.join("\n"), /Worker 19/);
	assert.doesNotMatch(lines.join("\n"), /\x1b|\x07/);
	assert.ok(lines.length <= 24, `bounded height: ${lines.length}`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40), "every framed row fits the host width");
});

test("group selected leg remains the same after a reparent changes traversal order", (t) => {
	const tree = groupTree();
	tree.update("b", { status: "running" });
	const stopped: string[] = [];
	const overlay = openGroup(tree, { onStop: (id) => { stopped.push(id); return true; } });
	t.after(() => overlay.dispose());
	overlay.handleInput("j");
	tree.add({ id: "c", parentId: "phase", label: "Charlie", kind: "subagent" });
	assert.match(overlay.render(100).join("\n"), /▸.*Bravo/);
	overlay.handleInput("x");
	assert.deepEqual(stopped, ["b"]);
});

test("group detail cannot submit stale steering after its worker settles before repaint", (t) => {
	const tree = groupTree();
	const steered: string[] = [];
	const overlay = openGroup(tree, { canSteer: () => true, onSteer: (id) => { steered.push(id); return true; } });
	t.after(() => overlay.dispose());
	overlay.handleInput("s");
	for (const key of "focus") overlay.handleInput(key);
	tree.update("a", { status: "done" });
	overlay.handleInput("\n");
	assert.deepEqual(steered, []);
	assert.doesNotMatch(overlay.render(100).join("\n"), /steer ▸/);
});

test("pending ask remains visible with a long worker alias and in its detail", (t) => {
	const tree = groupTree();
	tree.add({ id: "a", label: "Extremely long " + "worker alias ".repeat(10), parentId: "phase", kind: "subagent" });
	const overlay = openGroup(tree, { isWaitingForSupervisor: (id) => id === "a" });
	t.after(() => overlay.dispose());
	assert.match(overlay.render(40).join("\n"), /waiting for supervisor/);
	overlay.handleInput("\n");
	assert.match(overlay.render(80).join("\n"), /waiting for supervisor/);
});

test("group inspection refusal sanitizes and bounds metadata in its notice", (t) => {
	const tree = groupTree();
	tree.add({ id: "group", label: "Council\x1b[2J" + "x".repeat(300), kind: "council" });
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {});
	t.after(() => overlay.dispose());
	overlay.handleInput("k");
	overlay.handleInput("k");
	overlay.handleInput("x");
	const lines = overlay.render(80);
	assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
	assert.ok(lines.length <= 24);
});

test("worker detail fits a narrow terminal with waiting, model, effort and cumulative usage metadata", (t) => {
	const rowsProperty = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	t.after(() => { if (rowsProperty) Object.defineProperty(process.stdout, "rows", rowsProperty); else Reflect.deleteProperty(process.stdout, "rows"); });
	const tree = new AgentTree(() => 0);
	tree.add({ id: "a", label: "Security reviewer " + "long alias ".repeat(8), model: "provider/" + "long-model-name-".repeat(8), thinking: "xhigh", detail: "read repository ".repeat(8), usage: { ...emptyUsage(), input: 1234, output: 567 }, output: "retained output\n".repeat(60) });
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, { isWaitingForSupervisor: () => true });
	t.after(() => overlay.dispose());
	overlay.handleInput("\n");
	const lines = overlay.render(45);
	assert.match(lines.join("\n"), /waiting for supervisor/);
	assert.match(lines.join("\n"), /cumulative usage/);
	assert.ok(lines.length <= 24, `bounded detail height: ${lines.length}`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 45));
});

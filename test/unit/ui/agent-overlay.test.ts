import { test } from "node:test";
import assert from "node:assert/strict";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { AgentOverlay } from "../../../src/ui/agent-overlay.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";

const THEME = { fg: (_role: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const TUI_STUB = { requestRender: () => {} } as unknown as TUI;

function openOverlay(tree: AgentTree): AgentOverlay {
	return new AgentOverlay(tree, TUI_STUB, THEME, () => {}, undefined, undefined, () => true);
}

function type(overlay: AgentOverlay, text: string): void {
	for (const ch of text) overlay.handleInput(ch);
}

test("a half-typed steer does not follow the user to another agent when the drilled agent vanishes", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:A", label: "A" });
	tree.add({ id: "async:B", label: "B" });
	const overlay = openOverlay(tree);
	overlay.handleInput("\n"); // drill into A
	overlay.handleInput("s");
	type(overlay, "focus on /api");
	tree.remove("async:A"); // the async run completes and its node is removed mid-compose
	overlay.handleInput("\n"); // drill into B from the list
	const text = overlay.render(80).join("\n");
	assert.ok(text.includes("B"), "the overlay shows agent B's detail view");
	assert.ok(!text.includes("steer ▸"), "no compose line re-opens on a different agent");
	overlay.dispose();
});

test("re-opening the steer compose starts from an empty buffer", () => {
	const tree = new AgentTree();
	tree.add({ id: "async:A", label: "A" });
	let steerable = true;
	const overlay = new AgentOverlay(tree, TUI_STUB, THEME, () => {}, undefined, undefined, () => steerable);
	overlay.handleInput("\n");
	overlay.handleInput("s");
	type(overlay, "stale text");
	steerable = false; // the steer handle goes away mid-compose → the compose line closes
	tree.update("async:A", { detail: "thinking" }); // a live refresh re-renders the detail view
	steerable = true;
	overlay.handleInput("s");
	const text = overlay.render(80).join("\n");
	assert.ok(text.includes("steer ▸"), "the compose line re-opens");
	assert.ok(!text.includes("stale text"), "the previous half-typed message is gone");
	overlay.dispose();
});

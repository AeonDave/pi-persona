import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentTree, type AgentNode, flattenTree, renderAgentTree } from "../../../src/ui/agent-tree.ts";

test("renderAgentTree nests children under their parent with status glyphs + detail", () => {
	const nodes: AgentNode[] = [
		{ id: "magi", label: "magi", parentId: undefined, status: "running", detail: undefined },
		{ id: "magi/melchior", label: "Melchior", parentId: "magi", status: "running", detail: undefined },
		{ id: "magi/balthasar", label: "Balthasar", parentId: "magi", status: "done", detail: "↑12k ↓3k" },
		{ id: "magi/casper", label: "Casper", parentId: "magi", status: "failed", detail: undefined },
		{ id: "magi/stopped", label: "Stopped", parentId: "magi", status: "stopped", detail: undefined },
	];
	const text = renderAgentTree(nodes).join("\n");
	assert.match(text, /⏳ magi/);
	assert.match(text, /├─ ⏳ Melchior/);
	assert.match(text, /├─ ✓ Balthasar {2}↑12k ↓3k/);
	assert.match(text, /├─ ✗ Casper/);
	assert.match(text, /└─ ■ Stopped/);
});

test("AgentTree.add is idempotent on id and update mutates status/detail + notifies", () => {
	const tree = new AgentTree();
	let changes = 0;
	tree.onChange(() => changes++);
	tree.add({ id: "a", label: "A" }); // defaults to running
	tree.add({ id: "a", label: "A (relabeled)" }); // same id → upsert, not duplicate
	tree.update("a", { status: "done", detail: "$0.01" });
	const snap = tree.snapshot();
	assert.equal(snap.length, 1);
	assert.equal(snap[0]?.label, "A (relabeled)");
	assert.equal(snap[0]?.status, "done");
	assert.equal(snap[0]?.detail, "$0.01");
	assert.ok(changes >= 3, "every mutation notifies listeners");
});

test("AgentTree.add re-parents an existing node when parentId is provided (upsert moves it)", () => {
	const tree = new AgentTree();
	tree.add({ id: "root-a", label: "A" });
	tree.add({ id: "root-b", label: "B" });
	tree.add({ id: "kid", label: "K", parentId: "root-a" });
	tree.add({ id: "kid", label: "K", parentId: "root-b" }); // upsert with a new parent
	assert.equal(tree.snapshot().find((n) => n.id === "kid")?.parentId, "root-b");
	tree.add({ id: "kid", label: "K2" }); // parentId omitted → keep the current parent
	assert.equal(tree.snapshot().find((n) => n.id === "kid")?.parentId, "root-b");
});

test("flattenTree yields rows in display order with depth; update can set a node's output", () => {
	const tree = new AgentTree();
	tree.add({ id: "magi", label: "magi" });
	tree.add({ id: "magi/m", label: "Melchior", parentId: "magi" });
	tree.add({ id: "magi/b", label: "Balthasar", parentId: "magi", status: "done" });
	const rows = flattenTree(tree.snapshot());
	assert.deepEqual(
		rows.map((r) => `${r.depth}:${r.node.label}`),
		["0:magi", "1:Melchior", "1:Balthasar"],
	);
	tree.update("magi/m", { output: "line1\nline2" });
	assert.equal(tree.snapshot().find((n) => n.id === "magi/m")?.output, "line1\nline2");
});

test("removing a parent removes its descendants; isEmpty + hasRunning reflect state", () => {
	const tree = new AgentTree();
	tree.add({ id: "p", label: "P" });
	tree.add({ id: "p/c1", label: "C1", parentId: "p" });
	tree.add({ id: "p/c2", label: "C2", parentId: "p", status: "done" });
	assert.equal(tree.hasRunning(), true);
	tree.update("p/c1", { status: "done" });
	tree.update("p", { status: "done" }); // the parent stays running until the whole run ends
	assert.equal(tree.hasRunning(), false);
	tree.remove("p");
	assert.equal(tree.isEmpty(), true);
});

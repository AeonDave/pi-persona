import assert from "node:assert/strict";
import { test } from "node:test";
import type { AsyncRun } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { settleAsyncTreeNode } from "../../../src/ui/async-settlement.ts";

function run(overrides: Partial<AsyncRun> = {}): AsyncRun {
	return { id: "run-1", agent: "scout", task: "inspect", status: "done", batch: "batch-1",
		progress: { output: "partial", turns: 1, tokens: 2 },
		result: { agent: "scout", output: "Final evidence", ok: true, usage: { ...emptyUsage(), input: 12, output: 8 } }, ...overrides };
}

test("settled fan-out legs stay inspectable until the batch leaves, without counting as running", () => {
	const tree = new AgentTree();
	tree.add({ id: "delegate:batch-1", label: "group", kind: "delegate" });
	tree.add({ id: "async:run-1", parentId: "delegate:batch-1", label: "Scout", kind: "subagent", detail: "reading" });
	settleAsyncTreeNode(tree, run());
	const node = tree.snapshot().find((item) => item.id === "async:run-1")!;
	assert.equal(node.status, "done");
	assert.equal(node.detail, "↑12 ↓8");
	assert.match(node.output!, /Final evidence/);
	assert.equal(node.usage?.input, 12);
	tree.remove("delegate:batch-1");
	assert.deepEqual(tree.snapshot(), []);
});

test("terminal previews are bounded and point to retained reports without changing the result", () => {
	const tree = new AgentTree();
	tree.add({ id: "delegate:batch-1", label: "group", kind: "delegate" });
	tree.add({ id: "async:run-1", parentId: "delegate:batch-1", label: "Scout", kind: "subagent" });
	const settled = run({ resultReceipt: { ref: "result:abc", storage: "session-entry" } });
	settled.result!.output = "evidence ".repeat(10_000);
	const original = settled.result!.output;
	settleAsyncTreeNode(tree, settled);
	const output = tree.snapshot()[1]!.output!;
	assert.ok(output.length < 5_000);
	assert.match(output, /preview truncated/);
	assert.match(output, /result:abc/);
	assert.equal(settled.result!.output, original);
});

test("settled fan-out receipts identify the observed model, preserving a provider only for the exact requested id", () => {
	for (const [requested, observed, expected] of [["route/requested", "other/observed", "other/observed"], ["route/requested", "requested", "route/requested"]]) {
		const tree = new AgentTree();
		tree.add({ id: "delegate:batch-1", label: "group", kind: "delegate" });
		tree.add({ id: "async:run-1", parentId: "delegate:batch-1", label: "Scout · requested", kind: "subagent", model: requested! });
		const settled = run({ label: "Scout" });
		settled.result!.modelUsed = observed!;
		settleAsyncTreeNode(tree, settled);
		assert.equal(tree.snapshot()[1]!.model, expected);
		assert.equal(tree.snapshot()[1]!.label, `Scout · ${observed!.split("/").at(-1)}`);
	}
});

test("failure diagnostics survive empty output and stale settlements never resurrect rows", () => {
	const tree = new AgentTree();
	tree.add({ id: "delegate:batch-1", label: "group", kind: "delegate" });
	tree.add({ id: "async:run-1", parentId: "delegate:batch-1", label: "Scout", kind: "subagent" });
	const failure = run({ status: "failed", error: "provider refused", result: { agent: "scout", output: "", ok: false, usage: emptyUsage() } });
	settleAsyncTreeNode(tree, failure);
	assert.equal(tree.snapshot()[1]!.detail, "provider refused");
	assert.match(tree.snapshot()[1]!.output!, /provider refused/);
	tree.clear();
	settleAsyncTreeNode(tree, failure);
	assert.deepEqual(tree.snapshot(), []);
});

test("single legs and non-batch roots still leave immediately; running callbacks cannot settle rows", () => {
	for (const kind of ["subagent", "council", "flow"] as const) {
		const tree = new AgentTree();
		tree.add({ id: "async:run-1", label: "one", kind });
		settleAsyncTreeNode(tree, run({ status: "running" }));
		assert.equal(tree.snapshot().length, 1);
		settleAsyncTreeNode(tree, run());
		assert.deepEqual(tree.snapshot(), []);
	}
});

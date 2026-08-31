import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentTree, type AgentTreeChange } from "../../../src/ui/agent-tree.ts";

test("AgentTree emits authoritative add/update/remove changes with metadata", () => {
  const tree = new AgentTree();
  const changes: AgentTreeChange[] = [];
  tree.onChange((change) => changes.push(change));

  tree.add({
    id: "run-1",
    label: "orion-recon",
		kind: "subagent",
		agent: "operator",
		model: "provider/model",
		status: "running",
  });
  tree.update("run-1", { status: "done", detail: "complete" });
  tree.remove("run-1");

	assert.equal(changes[0]?.type, "added");
	if (changes[0]?.type === "added") {
		assert.equal(changes[0].node.model, "provider/model");
	}
  assert.equal(changes[1]?.type, "updated");
  if (changes[1]?.type === "updated") assert.equal(changes[1].node.status, "done");
  assert.equal(changes[2]?.type, "removed");
  if (changes[2]?.type === "removed") assert.equal(changes[2].nodes[0]?.detail, "complete");
});

test("AgentTree suppresses unchanged updates but emits real changes", () => {
  const tree = new AgentTree();
  const changes: AgentTreeChange[] = [];
  tree.onChange((change) => changes.push(change));
  tree.add({ id: "same", label: "agent", status: "running" });
  tree.add({ id: "same", label: "agent", status: "running" });
  tree.update("same", { status: "done" });
  assert.deepEqual(changes.map((change) => change.type), ["added", "updated"]);
});

test("AgentTree remove reports descendants and clear reports the prior snapshot", () => {
  const tree = new AgentTree();
  const changes: AgentTreeChange[] = [];
  tree.onChange((change) => changes.push(change));
  tree.add({ id: "root", label: "flow", kind: "flow" });
  tree.add({ id: "child", label: "phase", kind: "phase", parentId: "root" });
  tree.remove("root");
  const removed = changes.at(-1);
  assert.equal(removed?.type, "removed");
  if (removed?.type === "removed") assert.deepEqual(removed.nodes.map((n) => n.id).sort(), ["child", "root"]);

  tree.add({ id: "x", label: "delegate", kind: "delegate" });
  tree.clear();
  const cleared = changes.at(-1);
  assert.equal(cleared?.type, "cleared");
  if (cleared?.type === "cleared") assert.deepEqual(cleared.nodes.map((n) => n.id), ["x"]);
});

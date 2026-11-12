import test from "node:test";
import assert from "node:assert/strict";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { projectPeers, projectResourceGroups, resourceSummary, RESOURCE_GROUP_IDS } from "../../../src/ui/resource-groups.ts";
import { compactWidget } from "../../../src/ui/compact-widget.ts";

test("resource categories group only matching roots without changing the source tree", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "worker", label: "worker", kind: "subagent" });
	tree.add({ id: "timer:1", label: "alarm", kind: "timer" });
	tree.add({ id: "monitor:1", label: "watch", kind: "monitor" });
	tree.add({ id: "script:1", label: "build", kind: "script" });
	const source = tree.snapshot();
	const projected = projectResourceGroups(source);
	for (const kind of ["timer", "monitor", "script"] as const) {
		assert.ok(projected.some((n) => n.id === RESOURCE_GROUP_IDS[kind]));
		assert.equal(projected.find((n) => n.id === `${kind}:1`)?.parentId, RESOURCE_GROUP_IDS[kind]);
	}
	assert.equal(source.find((n) => n.id === "timer:1")?.parentId, undefined);
	assert.equal(projected.find((n) => n.id === "worker")?.parentId, undefined);
});

test("peer projection is inspectable read-only metadata", () => {
	const peers = projectPeers([{ key: "1", name: "Ada", status: "idle", persona: "reviewer" }]);
	assert.equal(peers[0]?.label, "Exocom peers");
	assert.equal(peers[1]?.kind, "peer");
	assert.match(peers[1]?.output ?? "", /reviewer/);
});

test("summary collapse and mouse clicks target the category, never a child", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "timer:1", label: "alarm", kind: "timer" });
	const open = resourceSummary(tree.snapshot(), new Set(), 8);
	assert.equal(open.targets[0], RESOURCE_GROUP_IDS.timer);
	assert.equal(open.lines.length, 2);
	const closed = resourceSummary(tree.snapshot(), new Set([RESOURCE_GROUP_IDS.timer]), 8);
	assert.equal(closed.lines.length, 1);
	let target = "";
	const component = compactWidget(open.lines, open.targets, (id) => { target = id; })();
	component.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 2, shift: false, alt: false, ctrl: false });
	assert.equal(target, RESOURCE_GROUP_IDS.timer);
});

test("a wide worker fanout cannot hide the resource category controls", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `worker ${i}` });
	for (const kind of ["timer", "monitor", "script"] as const) tree.add({ id: `${kind}:1`, label: kind, kind });
	const summary = resourceSummary(tree.snapshot(), new Set(), 8);
	assert.ok(summary.lines.length <= 8);
	for (const id of Object.values(RESOURCE_GROUP_IDS)) assert.ok(summary.targets.includes(id), id);
	assert.match(summary.lines.join("\n"), /F9/);
});

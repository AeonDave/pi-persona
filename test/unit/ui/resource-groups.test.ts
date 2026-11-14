import test from "node:test";
import assert from "node:assert/strict";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { projectPeers, projectResourceGroups, pruneFoldState, resourceSummary, RESOURCE_GROUP_IDS } from "../../../src/ui/resource-groups.ts";
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

test("fold state discards removed batches and preserves resource preferences and live batches", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "live", label: "delegate", kind: "delegate" });
	const collapsed = new Set(["live", "removed", RESOURCE_GROUP_IDS.timer]);
	pruneFoldState(collapsed, tree.snapshot());
	assert.deepEqual([...collapsed].sort(), ["live", RESOURCE_GROUP_IDS.timer].sort());
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

test("delegate header click folds all descendants and retains waiting and failure signals", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "batch", label: "delegate · 2 legs", kind: "delegate" });
	tree.add({ id: "phase", label: "phase", kind: "phase", parentId: "batch" });
	tree.add({ id: "waiter", label: "waiting worker", kind: "subagent", parentId: "phase" });
	tree.add({ id: "failed", label: "failed worker", kind: "subagent", parentId: "batch", status: "failed" });
	tree.add({ id: "stalled", label: "stalled worker", kind: "subagent", parentId: "batch", startedAt: 1, lastAdvanceAt: 1 });
	const collapsed = new Set<string>();
	const waitingForSupervisor = new Set(["waiter"]);
	const open = resourceSummary(tree.snapshot(), collapsed, 8, { waitingForSupervisor, now: 5_000, stallMs: 1_000 });
	assert.equal(open.targets[0], "batch");
	const component = compactWidget(open.lines, open.targets, (id) => { collapsed.add(id); })();
	component.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 4, shift: false, alt: false, ctrl: false });
	const closed = resourceSummary(tree.snapshot(), collapsed, 8, { waitingForSupervisor, now: 5_000, stallMs: 1_000 });
	assert.equal(closed.targets[0], "batch");
	assert.equal(closed.lines.length, 1);
	assert.match(closed.lines[0]!, /1 waiting/);
	assert.match(closed.lines[0]!, /1 failed/);
	assert.match(closed.lines[0]!, /1 stalled/);
	assert.doesNotMatch(closed.lines.join("\n"), /waiting worker|failed worker|phase/);
	assert.equal(tree.snapshot().length, 5, "folding never changes the runtime tree");
});

test("a folded delegate below a wide fanout retains its alerts and control", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `worker ${i}`, kind: "subagent" });
	tree.add({ id: "batch", label: "delegate · 2 legs", kind: "delegate" });
	tree.add({ id: "waiter", label: "waiter", kind: "subagent", parentId: "batch" });
	tree.add({ id: "failed", label: "failed", kind: "subagent", parentId: "batch", status: "failed" });
	const summary = resourceSummary(tree.snapshot(), new Set(["batch"]), 8, { waitingForSupervisor: new Set(["waiter"]) });
	const index = summary.targets.indexOf("batch");
	assert.ok(index >= 0, "folded header remains reachable");
	assert.match(summary.lines[index]!, /1 failed/);
	assert.match(summary.lines[index]!, /1 waiting/);
	assert.match(summary.lines.join("\n"), /active workers/);
});

test("reserving a folded header includes the displaced worker in the canonical active digest", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `worker ${i}`, kind: "subagent" });
	tree.add({ id: "batch", label: "delegate", kind: "delegate" });
	tree.add({ id: "leg", label: "leg", kind: "subagent", parentId: "batch" });
	const summary = resourceSummary(tree.snapshot(), new Set(["batch"]), 8);
	assert.ok(summary.targets.includes("batch"));
	assert.match(summary.lines.join("\n"), /15 active workers/);
});

test("reservation creates a newly needed active digest when it hides the only worker", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "worker", label: "ONLY-ACTIVE-WORKER", kind: "subagent" });
	for (const kind of ["timer", "monitor", "script"] as const) {
		for (let i = 0; i < 3; i++) tree.add({ id: `${kind}:${i}`, label: `${kind} ${i}`, kind });
	}
	for (const limit of [3, 4, 5]) {
		const summary = resourceSummary(tree.snapshot(), new Set(), limit);
		assert.ok(summary.lines.length <= limit);
		assert.match(summary.lines.join("\n"), /ONLY-ACTIVE-WORKER/, `worker remains represented with ${limit} rows`);
	}
});

test("saturated folded batches retain alerts from omitted groups", () => {
	const tree = new AgentTree(() => 0);
	const collapsed = new Set<string>();
	for (let i = 0; i < 12; i++) {
		const id = `batch:${i}`; collapsed.add(id);
		tree.add({ id, label: `delegate ${i}`, kind: "delegate" });
		tree.add({ id: `leg:${i}`, label: `leg ${i}`, parentId: id, kind: "subagent", ...(i === 11 ? { status: "failed" as const } : {}) });
	}
	tree.add({ id: "waiter", label: "waiting", parentId: "batch:11", kind: "subagent" });
	const summary = resourceSummary(tree.snapshot(), collapsed, 8, { waitingForSupervisor: new Set(["waiter"]) });
	assert.match(summary.lines.join("\n"), /1 failed/);
	assert.match(summary.lines.join("\n"), /1 waiting/);
});

test("folded alerts survive even when failure, active and navigation rows fill the summary", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 5; i++) tree.add({ id: `failed:${i}`, label: `failure ${i}`, kind: "subagent", status: "failed" });
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `worker ${i}`, kind: "subagent" });
	tree.add({ id: "batch", label: "delegate", kind: "delegate" });
	tree.add({ id: "bad", label: "bad", parentId: "batch", kind: "subagent", status: "failed" });
	tree.add({ id: "waiting", label: "waiting", parentId: "batch", kind: "subagent" });
	const opts = { waitingForSupervisor: new Set(["waiting"]) };
	for (const limit of [8, 1]) {
		const summary = resourceSummary(tree.snapshot(), new Set(["batch"]), limit, opts);
		const text = summary.lines.join("\n");
		assert.match(text, /1 waiting/);
		assert.match(text, /1 failed/);
		if (limit === 8) { assert.match(text, /5 failed/); assert.match(text, /active workers/); assert.match(text, /F9/); }
		else assert.match(text, /5 failed/);
		const painted = compactWidget(summary.lines, summary.targets)().render(80).join("\n");
		assert.match(painted, /1 waiting/, "critical alert survives actual widget clipping");
		assert.match(painted, /1 failed/);
		if (limit === 8) assert.match(painted, /F9/);
	}
});

test("worker labels containing digest wording do not block folded controls", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `active worker F9 or /agents ${i}`, kind: "subagent" });
	tree.add({ id: "batch", label: "delegate", kind: "delegate" });
	tree.add({ id: "bad", label: "bad", parentId: "batch", kind: "subagent", status: "failed" });
	const summary = resourceSummary(tree.snapshot(), new Set(["batch"]), 8);
	assert.ok(summary.targets.includes("batch"), "ordinary user-authored labels never masquerade as digest rows");
});

test("reserving a folded header never hides a visible supervisor request", () => {
	const tree = new AgentTree(() => 0);
	for (let i = 0; i < 20; i++) tree.add({ id: `worker:${i}`, label: `worker ${i}`, kind: "subagent", startedAt: 1 });
	tree.add({ id: "batch", label: "delegate", kind: "delegate" });
	tree.add({ id: "leg", label: "leg", parentId: "batch", kind: "subagent" });
	const summary = resourceSummary(tree.snapshot(), new Set(["batch"]), 8, { now: 2, waitingForSupervisor: new Set(["worker:5"]) });
	assert.match(summary.lines.join("\n"), /worker 5.*waiting for supervisor/);
	assert.ok(summary.targets.includes("batch"));
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

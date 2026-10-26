import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { emptyUsage } from "../../../src/engine/stream.ts";
import { formatUsage } from "../../../src/ui/usage.ts";

import { AgentTree, type AgentNode, type AgentNodeStatus, deriveWaitingNodeIds, effortTag, flattenTree, isQueuedMarker, isWakeSource, nodeGlyph, progressPatch, renderAgentTree, renderAgentTreeSummary, runningAnnotation, thinkingDetailLine } from "../../../src/ui/agent-tree.ts";

test("overflow worker counts exclude delegate and structural containers and separate waiting workers", () => {
	const tree = new AgentTree();
	tree.add({ id: "batch", label: "Batch", kind: "delegate" });
	tree.add({ id: "nested", label: "Nested", parentId: "batch" });
	tree.add({ id: "ask", label: "Waiting", parentId: "nested", kind: "subagent" });
	tree.add({ id: "work", label: "Building", parentId: "batch", kind: "subagent", detail: "npm test" });
	tree.add({ id: "queued", label: "Queued", parentId: "batch", kind: "subagent", detail: "queued" });
	const rows = renderAgentTreeSummary(tree.snapshot(), 3, { waitingForSupervisor: new Set(["batch", "nested", "ask"]) });
	assert.equal(rows[0], "? 1 waiting for supervisor: Waiting");
	assert.equal(rows[1], "⏳ 1 active worker: Building · npm test");
});

test("tree upserts preserve omitted metadata and clear explicitly reset attempt fields", () => {
	const tree = new AgentTree();
	tree.add({ id: "leg", label: "leg", model: "first/model", thinking: "xhigh", thinkingEffective: "high" });
	tree.add({ id: "leg", label: "same leg" });
	assert.equal(tree.snapshot()[0]!.model, "first/model");
	assert.equal(tree.snapshot()[0]!.thinkingEffective, "high");
	tree.add({ id: "leg", label: "retry", model: "retry/model", thinking: undefined, thinkingEffective: undefined });
	assert.equal(tree.snapshot()[0]!.model, "retry/model");
	assert.equal(tree.snapshot()[0]!.thinking, undefined);
	assert.equal(tree.snapshot()[0]!.thinkingEffective, undefined);
	tree.update("leg", { model: undefined });
	assert.equal(Object.hasOwn(tree.snapshot()[0]!, "model"), false);
});

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

test("renderAgentTree indexes a fan-out instead of rescanning the source for every parent", () => {
	const nodes: AgentNode[] = [
		{ id: "root", label: "root", parentId: undefined, status: "running", detail: undefined },
		...Array.from({ length: 64 }, (_, i): AgentNode => ({
			id: `root/${i}`,
			label: `worker-${i}`,
			parentId: "root",
			status: "running",
			detail: undefined,
		})),
	];
	let sourceScans = 0;
	const observed = new Proxy(nodes, {
		get(target, property, receiver) {
			if (property !== "filter") return Reflect.get(target, property, receiver);
			return (predicate: (node: AgentNode, index: number, array: AgentNode[]) => unknown): AgentNode[] => {
				sourceScans++;
				return target.filter(predicate);
			};
		},
	});

	assert.equal(renderAgentTree(observed).length, nodes.length);
	assert.equal(sourceScans, 0, "tree rendering should build one adjacency index, not filter the full array per node");
});

test("renderAgentTreeSummary bounds a wide fan-out and points to the full overlay", () => {
	const nodes: AgentNode[] = [
		{ id: "fanout", label: "fanout", parentId: undefined, status: "running", detail: undefined },
		...Array.from({ length: 20 }, (_, i): AgentNode => ({
			id: `fanout/${i}`,
			label: `worker-${i + 1}`,
			parentId: "fanout",
			status: "running",
			detail: "queued",
		})),
	];
	const lines = renderAgentTreeSummary(nodes, 8);
	assert.equal(lines.length, 8);
	assert.match(lines.at(-1) ?? "", /\+14 more.*F9.*\/agents/);
	assert.doesNotMatch(lines.join("\n"), /worker-20/);
});

test("renderAgentTreeSummary surfaces failures even when their rows fall below the fold", () => {
	const nodes: AgentNode[] = [
		{ id: "fanout", label: "fanout", parentId: undefined, status: "running", detail: undefined },
		...Array.from({ length: 20 }, (_, i): AgentNode => ({
			id: `fanout/${i}`,
			label: `worker-${i + 1}`,
			parentId: "fanout",
			status: i === 19 ? "failed" : "running",
			detail: i === 19 ? "provider" : "queued",
		})),
	];
	const lines = renderAgentTreeSummary(nodes, 8);
	assert.equal(lines.length, 8);
	assert.match(lines.join("\n"), /✗ 1 failed.*worker-20.*provider/);
	assert.match(lines.at(-1) ?? "", /F9.*\/agents/);
});

test("renderAgentTree strips terminal controls from user-defined labels and details", () => {
	const lines = renderAgentTree([
		{ id: "unsafe", label: "safe\u001b[2J\nspoof", parentId: undefined, status: "running", detail: "ok\u0000\r\nnext" },
	]);
	assert.equal(lines.length, 1);
	assert.doesNotMatch(lines[0] ?? "", /\u001b|\u0000|\r|\n/);
	assert.match(lines[0] ?? "", /safe spoof.*ok next/);
});

test("renderAgentTree clamps hostile label and detail metadata", () => {
	const line = renderAgentTree([
		{ id: "huge", label: "L".repeat(500), parentId: undefined, status: "failed", detail: "D".repeat(500) },
	])[0] ?? "";
	assert.ok(line.length <= 210, `tree row was not bounded: ${line.length}`);
	assert.match(line, /…/);
});

test("renderAgentTree bounds a wide-glyph row in terminal columns", () => {
	const line = renderAgentTree([
		{ id: "cjk", label: "漢".repeat(300), parentId: undefined, status: "running", detail: "字".repeat(300) },
	])[0] ?? "";
	assert.ok(visibleWidth(line) <= 210, `tree row occupied ${visibleWidth(line)} terminal columns`);
	assert.match(line, /…/);
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

test("AgentTree stamps startedAt/lastAdvanceAt from its clock and lets a patch advance the clock", () => {
	const tree = new AgentTree(() => 1_000);
	tree.add({ id: "a", label: "A" });
	assert.equal(tree.snapshot()[0]?.startedAt, 1_000);
	assert.equal(tree.snapshot()[0]?.lastAdvanceAt, 1_000);
	let changes = 0;
	tree.onChange(() => changes++);
	tree.update("a", { lastAdvanceAt: 5_000 });
	assert.equal(tree.snapshot()[0]?.lastAdvanceAt, 5_000);
	assert.equal(changes, 0, "a clock-only patch is not a tree change (the ticker paints it)");
	tree.update("a", { lastAdvanceAt: 6_000, detail: "3k tok" });
	assert.equal(changes, 1, "a patch that also changes visible state still notifies");
});

test("AgentTree.add upsert with startedAt/lastAdvanceAt overwrites the clock stamps and, alone, emits no change", () => {
	const tree = new AgentTree(() => 1_000);
	tree.add({ id: "a", label: "A" });
	assert.equal(tree.snapshot()[0]?.startedAt, 1_000);
	assert.equal(tree.snapshot()[0]?.lastAdvanceAt, 1_000);
	let changes = 0;
	tree.onChange(() => changes++);
	// The real-start transition (extension.ts / delegate-tool.ts) re-adds the same id with fresh
	// stamps once the leg actually goes live, rather than the clock's seed time.
	tree.add({ id: "a", label: "A", startedAt: 9_000, lastAdvanceAt: 9_000 });
	assert.equal(tree.snapshot()[0]?.startedAt, 9_000, "the upsert overwrites startedAt");
	assert.equal(tree.snapshot()[0]?.lastAdvanceAt, 9_000, "the upsert overwrites lastAdvanceAt");
	assert.equal(changes, 0, "a clock-only upsert is not a tree change (the ticker paints it)");
});

test("runningAnnotation shows elapsed time while advancing and a stall badge once quiet for stallMs", () => {
	const node = { status: "running" as const, startedAt: 0, lastAdvanceAt: 60_000, detail: undefined };
	assert.equal(runningAnnotation(node, 75_000, 90_000), "1m 15s");
	assert.equal(runningAnnotation(node, 150_000, 90_000), "⚠ stalled 1m 30s");
	assert.equal(runningAnnotation(node, 150_000, 0), "2m 30s", "stallMs 0 disables the badge");
	assert.equal(runningAnnotation({ status: "done" as const, startedAt: 0, detail: undefined }, 5_000, 90_000), undefined);
	assert.equal(runningAnnotation({ status: "running" as const, detail: undefined }, 5_000, 90_000), undefined, "no clock data → no annotation");
});

test("runningAnnotation is suppressed while a node still carries the queued marker, even with old timestamps", () => {
	const queued = { status: "running" as const, startedAt: 0, lastAdvanceAt: 0, detail: "queued" };
	assert.equal(runningAnnotation(queued, 200_000, 90_000), undefined, "no elapsed reading and no false stall badge while queued");
	assert.equal(runningAnnotation({ ...queued, detail: "Queued" }, 200_000, 90_000), undefined, "the marker match is case-insensitive, like telemetryStatus");
	assert.equal(runningAnnotation({ ...queued, detail: "  queued  " }, 200_000, 90_000), undefined, "the marker match trims whitespace, like telemetryStatus");
	assert.equal(runningAnnotation({ ...queued, detail: "queued for review", lastAdvanceAt: 200_000 }, 200_000, 90_000), "3m 20s", "only the exact literal marker suppresses, not any string containing it");
});

test("isQueuedMarker matches the literal marker only, trimmed and case-insensitively", () => {
	assert.equal(isQueuedMarker("queued"), true);
	assert.equal(isQueuedMarker("Queued"), true);
	assert.equal(isQueuedMarker("  queued  "), true);
	assert.equal(isQueuedMarker("queued for review"), false);
	assert.equal(isQueuedMarker(undefined), false);
	assert.equal(isQueuedMarker(""), false);
});

test("renderAgentTree appends the running annotation after the detail, only when a clock is given", () => {
	const nodes: AgentNode[] = [
		{ id: "a", label: "alpha", parentId: undefined, status: "running", detail: "12k tok", startedAt: 0, lastAdvanceAt: 0 },
		{ id: "b", label: "bravo", parentId: undefined, status: "done", detail: "$0.01", startedAt: 0 },
	];
	assert.deepEqual(renderAgentTree(nodes), ["⏳ alpha  12k tok", "✓ bravo  $0.01"]);
	assert.deepEqual(renderAgentTree(nodes, { now: 30_000, stallMs: 90_000 }), ["⏳ alpha  12k tok · 30s", "✓ bravo  $0.01"]);
	assert.deepEqual(renderAgentTree([{ ...nodes[0]!, detail: undefined }], { now: 120_000, stallMs: 90_000 }), ["⏳ alpha  ⚠ stalled 2m"]);
});

test("renderAgentTreeSummary passes the clock through", () => {
	const nodes: AgentNode[] = [{ id: "a", label: "alpha", parentId: undefined, status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 }];
	assert.deepEqual(renderAgentTreeSummary(nodes, 8, { now: 5_000, stallMs: 90_000 }), ["⏳ alpha  5s"]);
});

test("waiting-for-supervisor rows are not falsely stalled; parents wait only when every live child does", () => {
	const nodes: AgentNode[] = [
		{ id: "root", label: "root", parentId: undefined, status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "a", label: "a", parentId: "root", status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "b", label: "b", parentId: "root", status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
	];
	const waiting = deriveWaitingNodeIds(nodes, (id) => id === "a");
	assert.equal(runningAnnotation(nodes[1]!, 100_000, 90_000, waiting.has("a")), "waiting for supervisor");
	assert.equal(waiting.has("root"), false, "one non-waiting child keeps the parent active/possibly stalled");
	const allWaiting = deriveWaitingNodeIds(nodes, (id) => id === "a" || id === "b");
	assert.equal(allWaiting.has("root"), true);
	assert.equal(runningAnnotation(nodes[0]!, 100_000, 90_000, allWaiting.has("root")), "waiting for supervisor");
	assert.match(runningAnnotation(nodes[1]!, 100_000, 90_000) ?? "", /stalled/);
});

test("queued descendants do not keep a waiting parent active", () => {
	const nodes: AgentNode[] = [
		{ id: "root", label: "root", parentId: undefined, status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "parent", label: "parent", parentId: "root", status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "waiting", label: "waiting", parentId: "parent", status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "queued", label: "queued", parentId: "parent", status: "running", detail: "queued", startedAt: 0, lastAdvanceAt: 0 },
		{ id: "queued-child", label: "queued child", parentId: "queued", status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
	];
	const waiting = deriveWaitingNodeIds(nodes, (id) => id === "waiting" || id === "queued-child");
	assert.equal(waiting.has("root"), true, "queued subtrees are neutral while every live descendant waits");
	assert.equal(waiting.has("parent"), true, "nested parents aggregate live descendants through queued subtrees");
	assert.equal(waiting.has("queued"), false, "queued nodes have no live waiting handle");

	const allQueued: AgentNode[] = [
		{ id: "all-queued-parent", label: "parent", parentId: undefined, status: "running", detail: undefined, startedAt: 0, lastAdvanceAt: 0 },
		{ id: "only-queued", label: "queued", parentId: "all-queued-parent", status: "running", detail: "queued", startedAt: 0, lastAdvanceAt: 0 },
	];
	assert.equal(deriveWaitingNodeIds(allQueued, () => false).has("all-queued-parent"), false, "all-queued descendants do not imply a waiting parent");
});

test("progressPatch bumps lastAdvanceAt and prefers activity over usage", () => {
	const usage = { ...emptyUsage(), input: 1000, output: 500 };
	assert.deepEqual(progressPatch({ output: "o", activity: "⚙ bash ls", tokens: 1500, usage }, 42), { lastAdvanceAt: 42, output: "o", detail: "⚙ bash ls", usage });
	assert.deepEqual(progressPatch({ tokens: 164_005 }, 42), { lastAdvanceAt: 42, detail: "164k" }, "legacy aggregates stay neutral, not directional");
	assert.deepEqual(progressPatch({}, 42), { lastAdvanceAt: 42 });
	assert.deepEqual(progressPatch({ tokens: 0 }, 42), { lastAdvanceAt: 42 });
});

test("progressPatch keeps cumulative usage separate from the compact detail and copies it", () => {
	const usage = { ...emptyUsage(), input: 1_000, output: 500 };
	const patch = progressPatch({ activity: "⚙ bash ls", usage }, 42);
	assert.equal(patch.detail, "⚙ bash ls", "activity keeps its existing row preference");
	assert.deepEqual(patch.usage, usage, "the full cumulative usage remains available separately");
	usage.input = 9_000;
	assert.equal(patch.usage?.input, 1_000, "a later stream mutation cannot rewrite the tree patch");
});

test("AgentTree copies usage at every boundary and notifies only when its values change", () => {
	const inputUsage = { ...emptyUsage(), input: 10, output: 2 };
	const tree = new AgentTree();
	tree.add({ id: "worker", label: "worker", usage: inputUsage });
	inputUsage.input = 99;
	assert.equal(tree.snapshot()[0]?.usage?.input, 10, "ingestion owns its usage copy");

	const first = tree.snapshot();
	first[0]!.usage!.input = 88;
	assert.equal(tree.snapshot()[0]?.usage?.input, 10, "snapshots do not share mutable usage");

	const updates: AgentNode[] = [];
	tree.onChange((change) => { if (change.type === "updated") updates.push(change.node); });
	const nextUsage = { ...emptyUsage(), input: 20, output: 2 };
	tree.update("worker", { usage: nextUsage });
	assert.equal(updates.length, 1, "a usage change emits an update");
	nextUsage.input = 30;
	assert.equal(updates[0]?.usage?.input, 20, "change notifications own a copy too");
	updates[0]!.usage!.input = 40;
	assert.equal(tree.snapshot()[0]?.usage?.input, 20, "notification payloads cannot mutate the live tree");

	tree.update("worker", { usage: { ...nextUsage, input: 20 } });
	assert.equal(updates.length, 1, "equal usage values are not a semantic update");
	tree.add({ id: "worker", label: "worker", usage: undefined });
	assert.equal(Object.hasOwn(tree.snapshot()[0]!, "usage"), false, "explicit undefined clears usage for a retry");
});

test("running and completed rows use identical directional usage formatting", () => {
	const usage = { ...emptyUsage(), input: 123_000, output: 6_200, cacheRead: 2_400_000, cacheWrite: 500, cost: 0.42 };
	const tree = new AgentTree(() => 0);
	tree.add({ id: "a", label: "alpha" });
	tree.update("a", progressPatch({ tokens: usage.input + usage.output, usage }, 42));
	const active = renderAgentTree(tree.snapshot())[0];
	assert.equal(active, "⏳ alpha  ↑123k ↓6.2k R2.4M W500 $0.4200");
	tree.update("a", { status: "done", detail: formatUsage(usage) });
	assert.equal(renderAgentTree(tree.snapshot())[0], active?.replace("⏳", "✓"));
	assert.equal(progressPatch({ usage: { ...emptyUsage(), cacheRead: 2_400_000 } }, 43).detail, "R2.4M", "cache-only usage is not hidden by zero input/output");
	assert.equal(progressPatch({ usage: emptyUsage(), tokens: 0 }, 44).detail, "", "a zeroed snapshot has no invented counters");
});

test("nodeGlyph gives a running wake source its own glyph and falls back to the status glyph otherwise", () => {
	assert.equal(nodeGlyph({ status: "running", kind: "timer" }), "⏰");
	assert.equal(nodeGlyph({ status: "running", kind: "monitor" }), "◉");
	assert.equal(nodeGlyph({ status: "running", kind: "subagent" }), "⏳");
	assert.equal(nodeGlyph({ status: "running" }), "⏳", "a legacy node without a kind keeps the status glyph");
	for (const kind of ["timer", "monitor"] as const) {
		assert.equal(nodeGlyph({ status: "done", kind }), "✓");
		assert.equal(nodeGlyph({ status: "failed", kind }), "✗");
		assert.equal(nodeGlyph({ status: "stopped", kind }), "■");
	}
});

test("isWakeSource is true for monitor and timer rows only", () => {
	assert.equal(isWakeSource({ kind: "monitor" }), true);
	assert.equal(isWakeSource({ kind: "timer" }), true);
	for (const kind of ["subagent", "delegate", "council", "flow", "phase"] as const) assert.equal(isWakeSource({ kind }), false, kind);
	assert.equal(isWakeSource({}), false, "an undefined kind is an agent row");
});

test("runningAnnotation counts a timer down to its fire time and never shows a stall badge", () => {
	const timer = { status: "running" as const, kind: "timer" as const, startedAt: 0, dueAt: 2_952_000, detail: undefined };
	assert.equal(runningAnnotation(timer, 0, 90_000), "fires in 49m 12s");
	assert.equal(runningAnnotation(timer, 3_000_000, 90_000), "firing…");
	assert.equal(runningAnnotation(timer, 2_952_000, 90_000), "firing…", "due exactly now is firing, not a zero countdown");
	assert.doesNotMatch(runningAnnotation(timer, 200_000, 90_000) ?? "", /stalled/, "a timer waiting for its time is not stalled");
	assert.equal(runningAnnotation(timer, 200_000, 90_000), "fires in 45m 52s");
});

test("runningAnnotation shows a monitor's elapsed time and deadline countdown, never a stall badge", () => {
	const monitor = { status: "running" as const, kind: "monitor" as const, startedAt: 0, dueAt: 7_200_000, detail: undefined };
	assert.equal(runningAnnotation(monitor, 723_000, 90_000), "12m 3s · deadline in 1h 47m");
	assert.match(runningAnnotation(monitor, 7_300_000, 90_000) ?? "", /deadline reached$/);
	assert.equal(runningAnnotation(monitor, 7_300_000, 90_000), "2h 1m · deadline reached");
	assert.doesNotMatch(runningAnnotation(monitor, 723_000, 90_000) ?? "", /stalled/, "a quiet monitor is waiting for its event, not stalled");
	assert.doesNotMatch(runningAnnotation(monitor, 7_300_000, 90_000) ?? "", /stalled/);
});

test("runningAnnotation leaves settled wake rows bare and keeps the ordinary precedence for agent rows", () => {
	assert.equal(runningAnnotation({ status: "done", kind: "timer", startedAt: 0, dueAt: 1_000, detail: undefined }, 5_000, 90_000), undefined);
	assert.equal(runningAnnotation({ status: "stopped", kind: "monitor", startedAt: 0, dueAt: 1_000, detail: undefined }, 5_000, 90_000), undefined);
	assert.equal(runningAnnotation({ status: "running", kind: "timer", dueAt: 1_000, detail: undefined }, 500, 90_000), undefined, "no clock data → no annotation, wake source or not");
	const agent = { status: "running" as const, kind: "subagent" as const, startedAt: 0, lastAdvanceAt: 0, detail: undefined };
	assert.equal(runningAnnotation(agent, 100_000, 90_000, true), "waiting for supervisor");
	assert.match(runningAnnotation(agent, 100_000, 90_000) ?? "", /stalled/, "an agent row without dueAt still stalls");
	assert.equal(runningAnnotation({ ...agent, kind: "timer", dueAt: 200_000 }, 100_000, 90_000, true), "waiting for supervisor", "waiting-for-supervisor still outranks the wake branch");
});

test("renderAgentTree shows timer and monitor rows with their kind-aware glyph and countdown", () => {
	const nodes: AgentNode[] = [
		{ id: "timer-1", label: "status review", parentId: undefined, status: "running", kind: "timer", detail: "timer-1", startedAt: 0, lastAdvanceAt: 0, dueAt: 2_952_000 },
		{ id: "monitor-2", label: "qualify batch1", parentId: undefined, status: "running", kind: "monitor", detail: "monitor-2 · exit", startedAt: 0, lastAdvanceAt: 0, dueAt: 7_200_000 },
	];
	assert.deepEqual(renderAgentTree(nodes, { now: 0, stallMs: 90_000 }), ["⏰ status review  timer-1 · fires in 49m 12s", "◉ qualify batch1  monitor-2 · exit · <1s · deadline in 2h"]);
	assert.deepEqual(renderAgentTree(nodes.slice(1), { now: 723_000, stallMs: 90_000 }), ["◉ qualify batch1  monitor-2 · exit · 12m 3s · deadline in 1h 47m"]);
	assert.deepEqual(renderAgentTree(nodes), ["⏰ status review  timer-1", "◉ qualify batch1  monitor-2 · exit"], "without a clock the rows stay byte-identical");
	assert.deepEqual(renderAgentTree([{ ...nodes[0]!, status: "done" }], { now: 3_000_000 }), ["✓ status review  timer-1"], "a settled timer falls back to the ordinary glyph with no clock");
});

test("AgentTree carries dueAt, and a changed dueAt notifies while an identical one does not", () => {
	const tree = new AgentTree(() => 1_000);
	tree.add({ id: "timer-1", label: "status review", kind: "timer", dueAt: 60_000 });
	assert.equal(tree.snapshot()[0]?.dueAt, 60_000);
	assert.equal(tree.snapshot()[0]?.kind, "timer");
	const plain = new AgentTree();
	plain.add({ id: "a", label: "A" });
	assert.equal("dueAt" in (plain.snapshot()[0] ?? {}), false, "an agent row carries no dueAt key");
	const changes: string[] = [];
	tree.onChange((change) => changes.push(change.type));
	tree.update("timer-1", { dueAt: 60_000 });
	assert.deepEqual(changes, [], "the same dueAt is not a change");
	tree.update("timer-1", { dueAt: 90_000 });
	assert.deepEqual(changes, ["updated"], "a different dueAt notifies — it is not a clock key");
	assert.equal(tree.snapshot()[0]?.dueAt, 90_000);
	tree.add({ id: "timer-1", label: "status review", dueAt: 120_000 });
	assert.deepEqual(changes, ["updated", "updated"], "the upsert branch applies dueAt too");
	assert.equal(tree.snapshot()[0]?.dueAt, 120_000);
});

// --- Wake-source digest: a monitor/timer below the fold must stay visible ------------------------

const WAKE_FOLD_LEG_COUNT = 7;

/** A council root with seven running legs under it (8 rows: exactly the default summary budget). */
function councilFanout(failedIndex?: number): AgentNode[] {
	return [
		{ id: "council#1", label: "council", parentId: undefined, status: "running", kind: "council", detail: undefined },
		...Array.from({ length: WAKE_FOLD_LEG_COUNT }, (_, i): AgentNode => ({
			id: `council#1/${i}`,
			label: `leg-${i + 1}`,
			parentId: "council#1",
			status: i === failedIndex ? "failed" : "running",
			kind: "subagent",
			detail: i === failedIndex ? "provider" : undefined,
		})),
	];
}

const WAKE_MONITOR: AgentNode = {
	id: "monitor:monitor-1",
	kind: "monitor",
	label: "qualify batch1",
	parentId: undefined,
	status: "running",
	detail: "monitor-1 · exit",
	startedAt: 0,
	dueAt: 7_200_000,
};
const WAKE_TIMER: AgentNode = {
	id: "timer:timer-1",
	kind: "timer",
	label: "status review",
	parentId: undefined,
	status: "running",
	detail: "timer-1",
	startedAt: 0,
	dueAt: 253_000,
};
const OVERFLOW = /^… \+\d+ more · F9 or \/agents for the full live tree$/;

test("a monitor armed after a full fan-out is surfaced as a digest line instead of vanishing behind the overflow", () => {
	const lines = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR], 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.deepEqual(lines.slice(5), [
		"◉ 1 monitor · next due in 1h 59m",
		"⏳ 3 active workers: leg-5",
		"… +4 more · F9 or /agents for the full live tree",
	]);
	assert.equal(lines.filter((line) => /^◉ 1 monitor · next due in /.test(line)).length, 1);
	assert.match(lines.at(-1) ?? "", OVERFLOW, "hidden wake rows still count as more");
	assert.doesNotMatch(lines.slice(0, 5).join("\n"), /◉|qualify batch1/, "the monitor's own row stays below the fold; only the digest shows it");
	assert.match(lines[0] ?? "", /council/, "the fan-out keeps the rows the digest did not need");
});

test("the hidden worker digest names a stable representative and uses its supplied activity, not its model", () => {
	const nodes = councilFanout().map((node) => node.id === "council#1/4"
		? { ...node, detail: "⚙ rg src/ui", model: "vendor/private-model", startedAt: 10, lastAdvanceAt: 10 }
		: node);
	nodes.push(WAKE_MONITOR);
	const first = renderAgentTreeSummary(nodes, 8, { now: 1_000 });
	assert.equal(first[6], "⏳ 3 active workers: leg-5 · ⚙ rg src/ui");
	assert.ok(visibleWidth(first[6] ?? "") <= 210, "the digest representative stays within the existing summary row width bound");

	const laterProgress = nodes.map((node) => ({ ...node, startedAt: 20_000, lastAdvanceAt: 20_000 }));
	assert.equal(renderAgentTreeSummary(laterProgress, 8, { now: 21_000 })[6], first[6], "progress clocks do not reorder the representative");
	assert.doesNotMatch(first.join("\n"), /vendor\/private-model/, "identity comes from the tree row, not a model inference");
});

test("the hidden worker digest excludes settled, queued, container, timer, monitor, and activity rows", () => {
	const nodes: AgentNode[] = [
		{ id: "council", label: "council", parentId: undefined, status: "running", kind: "council", detail: undefined },
		...Array.from({ length: 6 }, (_, index): AgentNode => ({
			id: `settled-${index}`, label: `settled-${index}`, parentId: "council", status: "done", kind: "subagent", detail: undefined,
		})),
		{ id: "queued", label: "queued", parentId: "council", status: "running", kind: "subagent", detail: "queued" },
		{ id: "live", label: "live worker", parentId: "council", status: "running", kind: "subagent", detail: "⚙ compiling" },
		{ ...WAKE_MONITOR, parentId: "council" },
		{ ...WAKE_TIMER, parentId: "council" },
		{ id: "activity", label: "Mind", parentId: "council", status: "running", kind: "activity", detail: "inspecting" },
		{ id: "phase", label: "phase", parentId: "council", status: "running", kind: "phase", detail: undefined },
	];
	const lines = renderAgentTreeSummary(nodes, 6, { now: 1_000 });
	assert.equal(lines.length, 6);
	assert.match(lines.join("\n"), /⏳ 1 active worker: live worker · ⚙ compiling/);
	assert.doesNotMatch(lines[4] ?? "", /queued|settled-[0-5]|phase/);
});

test("waiting-for-supervisor rows get a truthful digest before wake and active digests", () => {
	const nodes = [...councilFanout(2), WAKE_MONITOR];
	const lines = renderAgentTreeSummary(nodes, 8, {
		now: 1_000,
		waitingForSupervisor: new Set(["council#1", "council#1/4"]),
	});
	assert.equal(lines.length, 8);
	assert.equal(lines[4], "? 1 waiting for supervisor: leg-5", "container waiting state is not counted as a second worker ask");
	assert.match(lines[5] ?? "", /^◉ 1 monitor/);
	assert.match(lines[6] ?? "", /^⏳ \d+ active workers:/);
});

test("tiny summary budgets use failure, ask, wake, active, then overflow priority", () => {
	const nodes = [...councilFanout(2), WAKE_MONITOR];
	const opts = { now: 1_000, waitingForSupervisor: new Set(["council#1/4"]) };
	assert.deepEqual(renderAgentTreeSummary(nodes, 1, opts), ["✗ 1 failed: leg-3 (provider)"]);
	assert.deepEqual(renderAgentTreeSummary(nodes, 2, opts), ["✗ 1 failed: leg-3 (provider)", "? 1 waiting for supervisor: leg-5"]);
	assert.equal(renderAgentTreeSummary(nodes, 3, opts)[2], "◉ 1 monitor · next due in 1h 59m");
	assert.match(renderAgentTreeSummary(nodes, 4, opts)[3] ?? "", /^⏳ \d+ active workers:/);
	assert.equal(renderAgentTreeSummary(nodes, 5, opts).length, 5, "overflow uses the last slot after every higher-priority digest");
});

test("settled siblings do not hide the one remaining live worker in the active digest", () => {
	const nodes: AgentNode[] = [
		{ id: "batch", label: "batch", parentId: undefined, status: "running", kind: "council", detail: undefined },
		...Array.from({ length: 7 }, (_, index): AgentNode => ({
			id: `batch/${index}`, label: `worker-${index + 1}`, parentId: "batch",
			status: index === 6 ? "running" : "done", kind: "subagent", detail: index === 6 ? "⚙ finishing" : undefined,
		})),
	];
	const lines = renderAgentTreeSummary(nodes, 5);
	assert.equal(lines.length, 5);
	assert.equal(lines[3], "⏳ 1 active worker: worker-7 · ⚙ finishing");
	assert.match(lines[4] ?? "", /^… \+5 more/);
});

test("the digest counts monitors then timers and counts down to the nearest hidden due time", () => {
	const lines = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR, WAKE_TIMER], 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.equal(lines[5], "◉ 1 monitor · ⏰ 1 timer · next due in 4m 12s", "the timer fires first, so it sets the countdown");
	assert.match(lines[6] ?? "", /^⏳ 3 active workers:/);
	assert.match(lines.at(-1) ?? "", /^… \+5 more · F9/);
});

test("the digest pluralises each kind and omits a kind that has no hidden row", () => {
	const timers: AgentNode[] = [WAKE_TIMER, { ...WAKE_TIMER, id: "timer:timer-2", label: "second review", dueAt: 600_000 }];
	const onlyTimers = renderAgentTreeSummary([...councilFanout(), ...timers], 8, { now: 1_000 });
	assert.equal(onlyTimers[5], "⏰ 2 timers · next due in 4m 12s");
	assert.match(onlyTimers[6] ?? "", /^⏳ 3 active workers:/);

	const monitors: AgentNode[] = [WAKE_MONITOR, { ...WAKE_MONITOR, id: "monitor:monitor-2", label: "second watch", dueAt: 9_000_000 }];
	const onlyMonitors = renderAgentTreeSummary([...councilFanout(), ...monitors], 8, { now: 1_000 });
	assert.equal(onlyMonitors[5], "◉ 2 monitors · next due in 1h 59m");
	assert.match(onlyMonitors[6] ?? "", /^⏳ 3 active workers:/);

	const mixed = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR, ...timers], 8, { now: 1_000 });
	assert.equal(mixed[5], "◉ 1 monitor · ⏰ 2 timers · next due in 4m 12s");
	assert.match(mixed[6] ?? "", /^⏳ 3 active workers:/);
});

test("the digest says 'next due now' once the nearest hidden wake row is overdue", () => {
	const lines = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR], 8, { now: 7_200_000 });
	assert.equal(lines[5], "◉ 1 monitor · next due now");
	const later = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR], 8, { now: 8_000_000 });
	assert.equal(later[5], "◉ 1 monitor · next due now", "past the deadline reads the same");
});

test("without a clock the digest carries no 'next due' clause, and neither does a hidden row with no dueAt", () => {
	const noClock = renderAgentTreeSummary([...councilFanout(), WAKE_MONITOR], 8);
	assert.equal(noClock.length, 8);
	assert.equal(noClock[5], "◉ 1 monitor");
	const { dueAt: _dueAt, ...undated } = WAKE_MONITOR;
	const noDue = renderAgentTreeSummary([...councilFanout(), undated], 8, { now: 1_000 });
	assert.equal(noDue[5], "◉ 1 monitor", "nothing finite to count down to");
	const mixedDue = renderAgentTreeSummary([...councilFanout(), undated, { ...WAKE_TIMER, dueAt: Number.NaN }], 8, { now: 1_000 });
	assert.equal(mixedDue[5], "◉ 1 monitor · ⏰ 1 timer", "a NaN dueAt is not finite either");
});

test("a failed leg and a hidden wake row each get their own line, and the summary stays inside its budget", () => {
	const lines = renderAgentTreeSummary([...councilFanout(3), WAKE_MONITOR], 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.match(lines[4] ?? "", /^✗ 1 failed: leg-4 \(provider\)$/);
	assert.equal(lines[5], "◉ 1 monitor · next due in 1h 59m");
	assert.match(lines[6] ?? "", /^⏳ 3 active workers:/);
	assert.match(lines[7] ?? "", /^… \+5 more · F9/);
	assert.match(lines[0] ?? "", /council/);
	assert.equal(lines.slice(0, 4).length, 4, "failure, wake, and active digests each take a slot");
});

test("a wake row inside the fold gets no digest line", () => {
	const lines = renderAgentTreeSummary([WAKE_MONITOR, ...councilFanout()], 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.match(lines[0] ?? "", /^◉ qualify batch1/, "the row is shown as itself");
	assert.doesNotMatch(lines.join("\n"), /\d+ monitors?\b/, "so there is no digest to repeat it");
	assert.match(lines.at(-1) ?? "", /^… \+3 more/);
	assert.match(lines[6] ?? "", /^⏳ 3 active workers:/);
	assert.equal(lines.filter((line) => OVERFLOW.test(line)).length, 1);
});

test("the digest slot can pull a wake row that was just inside the fold below it", () => {
	const filler = (i: number): AgentNode => ({ id: `a${i}`, label: `agent-${i}`, parentId: undefined, status: "running", detail: undefined });
	// Rows: 6 agents, the monitor (index 6, the last visible slot at limit 8), one more agent, then the timer (index 8).
	const nodes: AgentNode[] = [0, 1, 2, 3, 4, 5].map(filler);
	nodes.push(WAKE_MONITOR, filler(6), WAKE_TIMER);
	const lines = renderAgentTreeSummary(nodes, 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.equal(lines[5], "◉ 1 monitor · ⏰ 1 timer · next due in 4m 12s", "the digest slot demoted the monitor too, so it is counted");
	assert.equal(lines[6], "⏳ 2 active workers: agent-5");
	assert.doesNotMatch(lines.slice(0, 5).join("\n"), /qualify batch1/);
	assert.equal(lines[7], "… +4 more · F9 or /agents for the full live tree");
});

test("settled wake rows below the fold are not part of the digest", () => {
	const settled: AgentNode[] = [
		{ ...WAKE_MONITOR, status: "done" },
		{ ...WAKE_TIMER, status: "stopped" },
	];
	const lines = renderAgentTreeSummary([...councilFanout(), ...settled], 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.doesNotMatch(lines.join("\n"), /\bmonitors?\b|\btimers?\b|next due/);
	assert.equal(lines.at(-1), "… +4 more · F9 or /agents for the full live tree", "settled wake rows are omitted while the hidden running workers get their digest");
	assert.equal(lines[6], "⏳ 2 active workers: leg-6");
	assert.equal(lines.filter((line) => /^[✓■] /.test(line)).length, 0, "and the settled rows themselves are below the fold");
});

test("a tight budget keeps the digest ahead of the overflow line", () => {
	const nodes = [...councilFanout(), WAKE_MONITOR];
	// limit 2: wake and active digests outrank overflow; no tree rows remain.
	assert.deepEqual(renderAgentTreeSummary(nodes, 2, { now: 1_000 }), ["◉ 1 monitor · next due in 1h 59m", "⏳ 7 active workers: leg-1"]);
	// limit 1: one line only, and the wake digest outranks the overflow.
	assert.deepEqual(renderAgentTreeSummary(nodes, 1, { now: 1_000 }), ["◉ 1 monitor · next due in 1h 59m"]);
	// limit 3: both digests and overflow consume the budget.
	const three = renderAgentTreeSummary(nodes, 3, { now: 1_000 });
	assert.equal(three.length, 3);
	assert.equal(three[0], "◉ 1 monitor · next due in 1h 59m");
	assert.equal(three[1], "⏳ 7 active workers: leg-1", "representative names the first hidden worker in stable display order");
	assert.equal(three[2], "… +9 more · F9 or /agents for the full live tree");
});

test("a failure outranks the wake digest, and neither exceeds a one- or two-line budget", () => {
	const nodes = [...councilFanout(3), WAKE_MONITOR];
	assert.deepEqual(renderAgentTreeSummary(nodes, 1, { now: 1_000 }), ["✗ 1 failed: leg-4 (provider)"], "failure > digest > overflow at one line");
	assert.deepEqual(renderAgentTreeSummary(nodes, 2, { now: 1_000 }), ["✗ 1 failed: leg-4 (provider)", "◉ 1 monitor · next due in 1h 59m"], "the overflow line is the first to go");
});

test("without hidden wake rows, active workers still stay represented", () => {
	const nodes: AgentNode[] = [...councilFanout(), { id: "council#1/extra", label: "leg-8", parentId: "council#1", status: "running", kind: "subagent", detail: undefined }];
	const lines = renderAgentTreeSummary(nodes, 8, { now: 1_000 });
	assert.equal(lines.length, 8);
	assert.equal(lines[6], "⏳ 3 active workers: leg-6");
	assert.equal(lines.at(-1), "… +3 more · F9 or /agents for the full live tree");
	assert.doesNotMatch(lines.join("\n"), /monitor|timer/);
	assert.deepEqual(renderAgentTreeSummary(nodes, 8), [...renderAgentTree(nodes).slice(0, 6), "⏳ 3 active workers: leg-6", "… +3 more · F9 or /agents for the full live tree"]);
});

test("the no-overflow path returns every row untouched, wake rows included", () => {
	const nodes = [...councilFanout().slice(0, 4), WAKE_MONITOR, WAKE_TIMER];
	assert.deepEqual(renderAgentTreeSummary(nodes, 8, { now: 1_000 }), renderAgentTree(nodes, { now: 1_000 }));
	assert.equal(renderAgentTreeSummary(nodes, 6, { now: 1_000 }).length, 6, "exactly at the limit is not an overflow");
	assert.doesNotMatch(renderAgentTreeSummary(nodes, 6, { now: 1_000 }).join("\n"), /\d+ monitors?\b|next due/);
});

test("renderAgentTree appends the compact effort sigla after the label; off/absent render nothing", () => {
	const lines = renderAgentTree([
		{ id: "a", label: "IronVale-flow-reference · glm-5.3", parentId: undefined, status: "running", detail: "↑217k ↓75k", thinking: "xhigh" },
		{ id: "b", label: "no-effort", parentId: undefined, status: "running", detail: undefined },
		{ id: "c", label: "off-leg", parentId: undefined, status: "running", detail: undefined, thinking: "off" },
		{ id: "d", label: "mx-leg", parentId: undefined, status: "done", detail: undefined, thinking: "max" },
	]);
	assert.match(lines[0] ?? "", /⏳ IronVale-flow-reference · glm-5\.3 · xh {2}↑217k ↓75k$/, "the sigla lands right after the model, before the usage detail");
	assert.equal(lines[1], "⏳ no-effort", "unknown requested effort renders nothing");
	assert.equal(lines[2], "⏳ off-leg", "off renders nothing — absence means off");
	assert.equal(lines[3], "✓ mx-leg · mx");
});

test("a settled row renders requested→observed divergence honestly — never fabricated", () => {
	const row = (thinking?: AgentNode["thinking"], thinkingEffective?: AgentNode["thinkingEffective"]): string =>
		renderAgentTree([{ id: "x", label: "leg", parentId: undefined, status: "done" as AgentNodeStatus, detail: undefined, ...(thinking !== undefined ? { thinking } : {}), ...(thinkingEffective !== undefined ? { thinkingEffective } : {}) }]).join("\n");
	assert.match(row("xhigh", "high"), /✓ leg · xh→h$/, "a genuinely different observed level renders the divergence");
	assert.doesNotMatch(row("xhigh"), /→/, "no observed value reported ⇒ requested only, no invented arrow");
	assert.equal(row("high", "high"), "✓ leg · h", "an observed level equal to requested is not a divergence");
	assert.doesNotMatch(row("xhigh", "off"), /→/, "an observed off renders nothing — no dangling arrow");
	assert.doesNotMatch(row(undefined, "high"), /·/, "no requested level ⇒ nothing, even with an observed one");
});

test("effortTag/thinkingDetailLine: the pure helpers behind the tree row and the drill-in", () => {
	assert.equal(effortTag(undefined), "");
	assert.equal(effortTag("off"), "");
	assert.equal(effortTag("minimal"), " · mn");
	assert.equal(effortTag("xhigh"), " · xh");
	assert.equal(effortTag("xhigh", "high"), " · xh→h");
	assert.equal(effortTag("high", "high"), " · h");
	assert.equal(effortTag("xhigh", "off"), " · xh", "observed off renders nothing, never a dangling arrow");
	assert.equal(effortTag(undefined, "high"), "");
	assert.equal(thinkingDetailLine(undefined), "");
	assert.equal(thinkingDetailLine("off"), "");
	assert.equal(thinkingDetailLine("medium"), "thinking: requested medium");
	assert.equal(thinkingDetailLine("xhigh", "high"), "thinking: requested xhigh → observed high");
	assert.equal(thinkingDetailLine("high", "high"), "thinking: requested high", "equal observation is not a divergence");
	assert.equal(thinkingDetailLine("xhigh", "off"), "thinking: requested xhigh");
});

test("width clipping still holds with the appended effort field (tree rows)", () => {
	const line = renderAgentTree([
		{ id: "a", label: "L".repeat(120), parentId: undefined, status: "running", detail: "D".repeat(120), thinking: "xhigh" },
	]).join("\n");
	assert.ok(visibleWidth(line) <= 210, `tree row with effort occupied ${visibleWidth(line)} columns`);
	assert.match(line, / · xh /, "the sigla is present, not clipped away by the label clamp");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { AgentTree, type AgentNode, flattenTree, isQueuedMarker, progressPatch, renderAgentTree, renderAgentTreeSummary, runningAnnotation } from "../../../src/ui/agent-tree.ts";

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

test("progressPatch bumps lastAdvanceAt and prefers activity over a token count", () => {
	assert.deepEqual(progressPatch({ output: "o", activity: "⚙ bash ls", tokens: 1500 }, 42), { lastAdvanceAt: 42, output: "o", detail: "⚙ bash ls" });
	assert.deepEqual(progressPatch({ tokens: 164_005 }, 42), { lastAdvanceAt: 42, detail: "164k tok" });
	assert.deepEqual(progressPatch({}, 42), { lastAdvanceAt: 42 });
});

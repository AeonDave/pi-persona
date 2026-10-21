import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inFlightAgentCount } from "../../../src/extension.ts";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { createBackgroundRuns } from "../../../src/tools/background-run.ts";
import { registerDelegateTool } from "../../../src/tools/delegate-tool.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";

/** The tree and tracker are real. The extension's own settle handler (the leg's node leaves the tree)
 *  is registered first, exactly as in production, so the order in which listeners fire is the real one. */
function harness() {
	let tool: any;
	const tree = new AgentTree(() => 1_000);
	const tracker = new AsyncRunTracker();
	tracker.onComplete((run) => {
		tree.update(`async:${run.id}`, { status: run.status });
		tree.remove(`async:${run.id}`);
	});
	const gates = new Map<string, { resolve(): void; progress(): void }>();
	const deps: any = {
		lastCtx: undefined,
		controller: { activePersona: undefined },
		agents: [{ name: "scout" }],
		contractNames: () => [],
		buildEngine: (_signal: unknown, onProgress: (snap: unknown) => void) => ({
			run: (spec: any) => new Promise((resolve) => {
				gates.set(spec.task, {
					resolve: () => resolve({ agent: spec.agent, output: "ok", usage: emptyUsage(), ok: true }),
					progress: () => onProgress({ output: "x", turns: 1, tokens: 5 }),
				});
			}),
		}),
		agentTree: tree,
		tracker,
		completionNotifier: { discard: () => {} },
		config: { ledgerV2: false },
		RUN_LIMITS: { maxConcurrency: 8, maxChildren: 8, timeoutMs: 1000 },
		publishAgentTool: () => {},
		stopRegistry: new Map(),
		steerRegistry: new Map(),
		drainBusBlock: () => "",
		startPeek: () => {},
		childUsage: { account: () => {}, accountMany: () => emptyUsage() },
		publishPersonaCost: () => {},
	};
	// A headless call joins its runs through the shared launcher, wired exactly as the extension wires it.
	deps.runs = createBackgroundRuns({ tracker, agentTree: tree, stopRegistry: deps.stopRegistry, slots: new Semaphore(8), completionNotifier: deps.completionNotifier, startPeek: deps.startPeek, childUsage: deps.childUsage, publishPersonaCost: deps.publishPersonaCost });
	registerDelegateTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, deps);
	const launch = (tasks: number, hasUI = true) =>
		tool.execute("batch", { tasks: Array.from({ length: tasks }, (_, i) => ({ agent: "scout", task: `leg-${i}` })) }, undefined, undefined, { hasUI, modelRegistry: { getAll: () => [], getAvailable: () => [] } });
	const settle = async (task: string) => {
		gates.get(task)!.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	return { tree, launch, settle, gates };
}

const header = (tree: AgentTree) => tree.snapshot().find((node) => node.id.startsWith("delegate:"));

test("an async fan-out gets ONE header row that counts settled legs and leaves with the last of them", async () => {
	const h = harness();
	await h.launch(3);
	const emissions: number[] = [inFlightAgentCount(h.tree.snapshot())];
	h.tree.onChange(() => emissions.push(inFlightAgentCount(h.tree.snapshot())));

	const group = header(h.tree)!;
	assert.equal(group.label, "delegate · 3 legs");
	assert.equal(group.kind, "delegate");
	assert.equal(group.status, "running");
	assert.equal(group.detail, "0/3 settled");
	assert.equal(group.parentId, undefined, "the header is a root row");
	const legs = h.tree.snapshot().filter((node) => node.id.startsWith("async:"));
	assert.equal(legs.length, 3);
	assert.ok(legs.every((leg) => leg.parentId === group.id), "every leg hangs under the header");

	await h.settle("leg-0");
	assert.equal(header(h.tree)?.detail, "1/3 settled");
	await h.settle("leg-1");
	assert.equal(header(h.tree)?.detail, "2/3 settled");
	assert.equal(h.tree.snapshot().filter((node) => node.id.startsWith("async:")).length, 1);
	await h.settle("leg-2");
	assert.deepEqual(h.tree.snapshot(), [], "the header leaves with the last leg");

	for (let i = 1; i < emissions.length; i++) {
		assert.ok(emissions[i]! <= emissions[i - 1]!, `the in-flight count never rises while a batch drains: ${emissions.join(",")}`);
	}
	assert.equal(emissions[0], 3, "the header is a container, never an extra agent");
});

test("the header settles as done before it leaves, so telemetry never reports a finished batch as stopped", async () => {
	const h = harness();
	await h.launch(2);
	const removed: string[] = [];
	h.tree.onChange((change) => {
		if (change.type === "removed") for (const node of change.nodes) if (node.id.startsWith("delegate:")) removed.push(node.status);
	});
	for (const task of ["leg-0", "leg-1"]) await h.settle(task);
	assert.deepEqual(removed, ["done"]);
});

test("leg progress keeps the header's clock moving, so a busy batch never shows a false stall", async () => {
	const h = harness();
	await h.launch(2);
	const before = header(h.tree)!.lastAdvanceAt!;
	h.gates.get("leg-1")!.progress();
	assert.ok(header(h.tree)!.lastAdvanceAt! > before, "the header advances with its legs");
});

test("a settlement that arrives after the tree was cleared cannot resurrect the header", async () => {
	const h = harness();
	await h.launch(3);
	h.tree.clear();
	for (const task of ["leg-0", "leg-1", "leg-2"]) await h.settle(task);
	assert.deepEqual(h.tree.snapshot(), []);
});

test("single legs, one-task batches and headless fan-outs stay ungrouped", async () => {
	const single = harness();
	await single.launch(1);
	assert.equal(header(single.tree), undefined, "a one-task call is a single leg");
	assert.equal(single.tree.snapshot().find((node) => node.id.startsWith("async:"))?.parentId, undefined);

	const headless = harness();
	const pending = headless.launch(2, false);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(header(headless.tree), undefined, "nothing renders a headless tree");
	for (const task of ["leg-0", "leg-1"]) await headless.settle(task);
	await pending;
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { createBackgroundRuns } from "../../../src/tools/background-run.ts";
import { registerDelegateTool } from "../../../src/tools/delegate-tool.ts";

// Interactive delegate always runs in the background, so a second call is a CONCURRENT call while the
// first writer is still running: `requireDisjointWrites` must hold across calls, not only in one batch.

function harness(delegation: Record<string, unknown> | null = { requireDisjointWrites: true }) {
	let tool: any;
	const releases: Array<() => void> = [];
	const tracker = new AsyncRunTracker();
	const deps: any = {
		lastCtx: undefined,
		controller: { activePersona: delegation ? { delegation } : undefined, gate: () => undefined },
		agents: [{ name: "operator" }, { name: "reader", tools: ["read"] }],
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin", path: "builtin" } }],
		contractNames: () => ["default"],
		buildEngine: () => ({
			run: async (spec: any) => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return { agent: spec.agent, output: "done", usage: emptyUsage(), ok: true };
			},
		}),
		agentTree: { add: () => {}, update: () => {}, remove: () => {} },
		tracker,
		completionNotifier: { discard: () => {} },
		config: { ledgerV2: false },
		launchThinking: (spec: any) => spec.thinking,
		RUN_LIMITS: { maxConcurrency: 4, maxChildren: 4, timeoutMs: 1000 },
		publishAgentTool: () => {},
		stopRegistry: new Map(),
		steerRegistry: new Map(),
		drainBusBlock: () => "",
		startPeek: () => {},
		childUsage: { account: () => {} },
		publishPersonaCost: () => {},
	};
	deps.runs = createBackgroundRuns({ tracker, agentTree: deps.agentTree, stopRegistry: deps.stopRegistry, slots: new Semaphore(4), completionNotifier: deps.completionNotifier, startPeek: deps.startPeek, childUsage: { account: () => {}, accountMany: () => emptyUsage() } as any, publishPersonaCost: deps.publishPersonaCost });
	registerDelegateTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, deps);
	const settle = async (): Promise<void> => {
		for (let round = 0; round < 50; round++) {
			releases.shift()?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	return { tool, tracker, settle, agents: deps.agents as Array<Record<string, unknown>> };
}

function ctx(hasUI = true) {
	const sessionManager = SessionManager.inMemory(process.cwd());
	sessionManager.newSession({ id: "delegate-live-writes" });
	return {
		hasUI,
		modelRegistry: { getAll: () => [], getAvailable: () => [], getRegisteredProviderIds: () => [], getProvider: () => undefined, getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined },
		sessionManager,
		isIdle: () => true,
		getContextUsage: () => undefined,
	};
}

const text = (result: any): string => String(result.content?.[0]?.text ?? "");

test("a writer cannot start beside a live writer that declared no writeSet; readers still can", async () => {
	const h = harness();
	const c = ctx();
	assert.equal((await h.tool.execute("w1", { agent: "operator", task: "edit A" }, undefined, undefined, c)).isError, false, "a lone writer needs no ownership");

	const blocked = await h.tool.execute("w2", { agent: "operator", task: "edit B", writeSet: ["docs"] }, undefined, undefined, c);
	assert.equal(blocked.isError, true);
	assert.match(text(blocked), /disjoint ownership/);
	assert.match(text(blocked), /run-1 \(operator\)/, "the rejection names the run to wait for");
	assert.match(text(blocked), /no declared writeSet, so no other writer can run beside it until it settles/);
	assert.match(text(blocked), /end your turn/i, "interactive: its completion follow-up is the wake");
	assert.equal(h.tracker.running().length, 1, "nothing was launched by the rejected call");

	const reader = await h.tool.execute("r1", { agent: "reader", task: "look" }, undefined, undefined, c);
	assert.equal(reader.isError, false, "a read-only leg is not a writer and is never gated");

	await h.settle();
	assert.equal((await h.tool.execute("w3", { agent: "operator", task: "edit B" }, undefined, undefined, c)).isError, false, "once the writer settled the next one starts");
	await h.settle();
});

test("owned writers across calls: disjoint paths run side by side, overlaps and unowned legs are refused", async () => {
	const h = harness();
	const c = ctx();
	assert.equal((await h.tool.execute("a", { agent: "operator", task: "edit A", writeSet: ["src/a"] }, undefined, undefined, c)).isError, false);

	const overlap = await h.tool.execute("b", { agent: "operator", task: "edit deep", writeSet: ["src/a/deep.ts"] }, undefined, undefined, c);
	assert.equal(overlap.isError, true);
	assert.match(text(overlap), /"src\/a\/deep\.ts"/);
	assert.match(text(overlap), /run-1 \(operator\) path "src\/a"/);

	const unowned = await h.tool.execute("c", { agent: "operator", task: "edit anything" }, undefined, undefined, c);
	assert.equal(unowned.isError, true);
	assert.match(text(unowned), /add writeSet/, "the remedy names the parameter");

	const batch = await h.tool.execute("d", {
		tasks: [
			{ agent: "operator", task: "edit lib", writeSet: ["lib"] },
			{ agent: "operator", task: "edit tests", writeSet: ["test"] },
		],
		concurrency: 2,
	}, undefined, undefined, c);
	assert.equal(batch.isError, false, "a batch is checked once against the runs live before it, never against its own legs");
	assert.equal(h.tracker.writers().length, 3);

	const disjoint = await h.tool.execute("e", { agent: "operator", task: "edit docs", writeSet: ["docs"] }, undefined, undefined, c);
	assert.equal(disjoint.isError, false);
	await h.settle();
});

test("an invalid writeSet path cannot pose as disjoint ownership, alone or beside a live writer", async () => {
	const h = harness();
	const c = ctx();
	const outside = await h.tool.execute("abs", { agent: "operator", task: "edit", writeSet: ["/repo/src"] }, undefined, undefined, c);
	assert.equal(outside.isError, true, "an absolute path names no repository-relative ownership");
	assert.match(text(outside), /"operator" writeSet path "\/repo\/src" is outside/);
	assert.equal(h.tracker.writers().length, 0, "nothing was launched, so no invalid set is ever stored on a run");

	assert.equal((await h.tool.execute("a", { agent: "operator", task: "edit A", writeSet: ["src"] }, undefined, undefined, c)).isError, false);
	const escaping = await h.tool.execute("b", { tasks: [{ agent: "operator", task: "edit", writeSet: ["../pi-persona/src"] }], concurrency: 1 }, undefined, undefined, c);
	assert.equal(escaping.isError, true, "an escaping path would otherwise look disjoint from every relative one");
	assert.match(text(escaping), /tasks\[0\] \("operator"\) writeSet path "\.\.\/pi-persona\/src" is outside/);
	await h.settle();
});

test("an agent-declared writeSet inherited by a leg is what the live run is checked with", async () => {
	const h = harness();
	const c = ctx();
	h.agents.push({ name: "research", writeSet: [".research/"] });
	assert.equal((await h.tool.execute("r", { agent: "research", task: "collect notes" }, undefined, undefined, c)).isError, false);
	const clash = await h.tool.execute("w", { agent: "operator", task: "tidy notes", writeSet: [".research/notes"] }, undefined, undefined, c);
	assert.equal(clash.isError, true);
	assert.match(text(clash), /run-1 \(research\) path "\.research\/"/);
	assert.doesNotMatch(text(clash), /no declared writeSet/, "the inherited set was stored on the run");
	await h.settle();
});

test("the rejection names only the running writers it conflicts with", async () => {
	const h = harness();
	const c = ctx();
	assert.equal((await h.tool.execute("a", { agent: "operator", task: "edit A", writeSet: ["src"] }, undefined, undefined, c)).isError, false);
	assert.equal((await h.tool.execute("b", { agent: "operator", task: "edit B", writeSet: ["docs"] }, undefined, undefined, c)).isError, false);
	const clash = await h.tool.execute("c", { agent: "operator", task: "edit C", writeSet: ["docs/guide.md"] }, undefined, undefined, c);
	assert.equal(clash.isError, true);
	assert.match(text(clash), /run-2 \(operator\) is still running/);
	assert.doesNotMatch(text(clash), /run-1/, "the unrelated writer is not something to wait for");
	await h.settle();
});

test("without the persona policy background writers are not gated across calls", async () => {
	const h = harness(null);
	const c = ctx();
	assert.equal((await h.tool.execute("w1", { agent: "operator", task: "edit A" }, undefined, undefined, c)).isError, false);
	const second = await h.tool.execute("w2", { agent: "operator", task: "edit B" }, undefined, undefined, c);
	assert.equal(second.isError, false, text(second));
	await h.settle();
});

test("headless: a writer requested while another call's writer still runs gets the inline remedy", async () => {
	const h = harness();
	const c = ctx(false);
	const first = h.tool.execute("w1", { agent: "operator", task: "edit A" }, undefined, undefined, c);
	for (let i = 0; i < 20 && h.tracker.writers().length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	const blocked = await h.tool.execute("w2", { agent: "operator", task: "edit B", writeSet: ["docs"] }, undefined, undefined, c);
	assert.equal(blocked.isError, true);
	assert.match(text(blocked), /later call/);
	assert.doesNotMatch(text(blocked), /end your turn/i, "headless has no follow-up to wake it");
	await h.settle();
	assert.equal((await first).isError, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installMindWorker, MIND_WORKER_EVENT, type MindWorkerResponse } from "../../../src/extension/mind-worker.ts";
import { installMemoryOwner } from "../../../src/extension/memory-owner.ts";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { AgentTree, renderAgentTree } from "../../../src/ui/agent-tree.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import type { AgentRunSpec } from "../../../src/orchestration/sdk.ts";

function harness() {
	const events = createEventBus();
	const tracker = new AsyncRunTracker();
	const tree = new AgentTree();
	const stops = new Map<string, () => void>();
	let persona: string | null = "researcher";
	let allowed = true;
	let idle = true;
	let failWorker = false;
	const manager = { getSessionId: () => "s1", getSessionFile: () => undefined };
	const ctx = { sessionManager: manager, model: { provider: "native", id: "model" }, thinkingLevel: "max", isIdle: () => idle, hasPendingMessages: () => false } as unknown as ExtensionContext;
	const owner = installMemoryOwner({ events }, () => persona);
	owner.start(ctx.sessionManager)();
	const seen: AgentRunSpec[] = [];
	let settle!: () => void;
	let signal: AbortSignal | undefined;
	const gate = new Promise<void>((resolve) => { settle = resolve; });
	installMindWorker({ events }, {
		context: () => ctx, canLaunch: () => allowed, tracker, tree, slots: new Semaphore(1), stopRegistry: stops,
		steerRegistry: new Map(), startPeek() {},
		buildEngine: (_signal, _progress, options) => {
			assert.equal(options?.providerFallback, false);
			assert.equal(options?.canUseBus, false);
			assert.deepEqual(options?.agentOverride?.excludeTools, ["*"]);
			assert.deepEqual(options?.agentOverride?.tools, []);
			assert.equal(options?.agentOverride?.spine, false);
			return { run: async (spec, _progress, abort) => {
				seen.push(spec); signal = abort;
				await Promise.race([gate, new Promise<void>((resolve) => abort?.addEventListener("abort", () => resolve(), { once: true }))]);
				return { agent: spec.agent, output: '{"operations":[]}', ok: !abort?.aborted && !failWorker, ...((abort?.aborted || failWorker) ? { failureKind: abort?.aborted ? "abort" as const : "agent" as const, error: abort?.aborted ? "Mind worker cancelled" : "Mind worker failed" } : {}), modelUsed: spec.model!, thinkingEffective: "max", usage: emptyUsage() };
			} };
		},
	});
	const request = (extra: Record<string, unknown> = {}): MindWorkerResponse | undefined => {
		let response: MindWorkerResponse | undefined;
		events.emit(MIND_WORKER_EVENT, { version: 1, sessionId: "s1", persona, task: "Consolidate supplied facts", ...extra, respond: (value: MindWorkerResponse) => { response = value; } });
		return response;
	};
	return { request, tracker, tree, stops, seen, settle, owner, signal: () => signal, fail: () => { failWorker = true; }, setPersona: (value: string | null) => { persona = value; owner.changed(); }, deny: () => { allowed = false; }, busy: () => { idle = false; } };
}

test("Mind launches a real tracked tool-less worker with the current model and thinking, without installed agents", async () => {
	const h = harness();
	const response = h.request();
	assert.equal(response?.ok, true);
	if (!response?.ok) return;
	assert.equal(response.model, "native/model");
	assert.equal(response.thinking, "max");
	assert.equal(h.request()?.ok, false, "only one Mind job may be queued or running");
	assert.equal(h.tracker.peek(response.runId)?.delivery, "companion");
	assert.equal(h.tree.snapshot()[0]?.kind, "subagent");
	assert.match(renderAgentTree(h.tree.snapshot()).join("\n"), /Mind · model · mx/, "the live row shows both the actual selected model and effort");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(h.seen[0]?.tools, []);
	assert.equal(h.seen[0]?.model, "native/model");
	assert.equal(h.seen[0]?.thinking, "max");
	h.settle();
	const result = await response.completion;
	assert.equal(result.status, "done");
	assert.equal(result.ok, true);
	assert.equal(result.output, '{"operations":[]}');
});

test("Mind refuses stale scope, arbitrary request fields, busy sessions and denied delegation", () => {
	for (const extra of [{ persona: "other" }, { sessionId: "stale" }, { model: "foreign/model" }, { task: "x".repeat(48_001) }]) assert.equal(harness().request(extra)?.ok, false);
	const busy = harness(); busy.busy(); assert.equal(busy.request()?.ok, false);
	const denied = harness(); denied.deny(); assert.equal(denied.request()?.ok, false);
	const stopped = harness(); stopped.owner.stop(); assert.equal(stopped.request()?.ok, false);
});

test("Mind's cancellation handle and owner revocation reach the real worker abort signal", async () => {
	for (const action of ["cancel", "stop", "scope"] as const) {
		const h = harness(); const response = h.request(); assert.equal(response?.ok, true);
		if (!response?.ok) continue;
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (action === "cancel") response.cancel(); else if (action === "stop") h.stops.get(`async:${response.runId}`)?.(); else h.setPersona("other");
		assert.equal(h.signal()?.aborted, true);
		const result = await response.completion;
		assert.equal(result.ok, false);
		assert.equal(result.status, "stopped");
	}
});

test("Mind distinguishes worker failure from a stopped worker", async () => {
	const h = harness();
	h.fail();
	const response = h.request();
	assert.equal(response?.ok, true);
	if (!response?.ok) return;
	await new Promise<void>((resolve) => setImmediate(resolve));
	h.settle();
	const result = await response.completion;
	assert.equal(result.ok, false);
	assert.equal(result.status, "failed");
	assert.equal(result.error, "Mind worker failed");
});

test("cancelling a Mind receipt before admission spends no model call", async () => {
	const h = harness(); const response = h.request(); assert.equal(response?.ok, true);
	if (!response?.ok) return;
	response.cancel();
	const result = await response.completion;
	assert.equal(result.ok, false);
	assert.equal(result.status, "stopped");
	assert.deepEqual(h.seen, []);
});

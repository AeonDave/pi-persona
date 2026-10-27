import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installMindWorker, MIND_WORKER_EVENT, type MindWorkerResponse } from "../../../src/extension/mind-worker.ts";
import { installMemoryOwner } from "../../../src/extension/memory-owner.ts";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { AgentTree, renderAgentTree } from "../../../src/ui/agent-tree.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import type { AgentRunSpec, SteerFn } from "../../../src/orchestration/sdk.ts";

function harness() {
	const events = createEventBus();
	const tracker = new AsyncRunTracker();
	const tree = new AgentTree();
	const stops = new Map<string, () => void>();
	let persona: string | null = "researcher";
	let allowed = true;
	let idle = true;
	let failWorker = false;
	let outputs = ['{"operations":[]}'];
	const steer = new Map<string, SteerFn>();
	const steerCalls: SteerFn[] = [];
	const startedAtByAttempt: number[] = [];
	const observedDetails: string[] = [];
	let throwOnAttempt = 0;
	let buildThrowOnAttempt = 0;
	let afterAttempt: ((attempt: number, response: () => MindWorkerResponse | undefined, result: { ok: boolean; output: string }) => void) | undefined;
	const gates: Array<() => void> = [];
	const attemptWaiters: Array<{ count: number; resolve: () => void }> = [];
	const manager = { getSessionId: () => "s1", getSessionFile: () => undefined };
	const ctx = { sessionManager: manager, model: { provider: "native", id: "model" }, thinkingLevel: "max", isIdle: () => idle, hasPendingMessages: () => false } as unknown as ExtensionContext;
	tree.onChange((change) => { if (change.type === "updated") observedDetails.push(change.node.detail ?? ""); });
	const owner = installMemoryOwner({ events }, () => persona);
	owner.start(ctx.sessionManager)();
	const seen: AgentRunSpec[] = [];
	let response: MindWorkerResponse | undefined;
	let signal: AbortSignal | undefined;
	const waitAttempt = (count: number): Promise<void> => seen.length >= count ? Promise.resolve() : new Promise((resolve) => attemptWaiters.push({ count, resolve }));
	const release = (attempt: number): void => gates[attempt - 1]?.();
	installMindWorker({ events }, {
		context: () => ctx, canLaunch: () => allowed, tracker, tree, slots: new Semaphore(1), stopRegistry: stops,
		steerRegistry: steer, startPeek() {},
		buildEngine: (_signal, progress, options) => {
			if (seen.length === 1) assert.equal(steer.has(tree.snapshot()[0]?.id ?? ""), false, "first steer handle is cleared before corrective engine construction");
			assert.equal(options?.providerFallback, false);
			assert.equal(options?.canUseBus, false);
			assert.deepEqual(options?.agentOverride?.excludeTools, ["*"]);
			assert.deepEqual(options?.agentOverride?.tools, []);
			assert.equal(options?.agentOverride?.spine, false);
			const number = seen.length + 1;
			if (buildThrowOnAttempt === number) throw new Error("build exploded");
			return { run: async (spec, _progress, abort, onSteer) => {
				signal = abort;
				seen.push(spec);
				for (const waiter of attemptWaiters.splice(0)) if (seen.length >= waiter.count) waiter.resolve(); else attemptWaiters.push(waiter);
				if (onSteer) {
					const handle: SteerFn = (message) => { void message; };
					steerCalls.push(handle);
					onSteer(handle);
				}
				startedAtByAttempt.push(tree.snapshot()[0]?.startedAt ?? 0);
				progress?.({ usage: { ...emptyUsage(), input: seen.length * 10, output: seen.length, cost: seen.length / 10 }, output: `progress-${seen.length}`, tokens: seen.length * 11, turns: seen.length });
				if (throwOnAttempt === seen.length) throw new Error("engine exploded");
				await new Promise<void>((resolve) => {
					gates[seen.length - 1] = resolve;
					if (abort?.aborted) resolve();
					else abort?.addEventListener("abort", () => resolve(), { once: true });
				});
				const attempt = seen.length;
				const output = outputs.shift() ?? '{"operations":[]}';
				const result = { agent: spec.agent, output, ok: !abort?.aborted && !failWorker, ...((abort?.aborted || failWorker) ? { failureKind: abort?.aborted ? "abort" as const : "agent" as const, error: abort?.aborted ? "Mind worker cancelled" : "Mind worker failed" } : {}), modelUsed: spec.model!, thinkingEffective: "max" as const, usage: { ...emptyUsage(), input: attempt, output: attempt * 2, cacheRead: attempt * 3, cacheWrite: attempt * 4, cost: attempt * 0.25, turns: attempt } };
				afterAttempt?.(attempt, () => response, result);
				return result;
			} };
		},
	});
	const request = (extra: Record<string, unknown> = {}): MindWorkerResponse | undefined => {
		let answer: MindWorkerResponse | undefined;
		events.emit(MIND_WORKER_EVENT, { version: 1, sessionId: "s1", persona, task: "Consolidate supplied facts", ...extra, respond: (value: MindWorkerResponse) => { answer = value; response = value; } });
		return answer;
	};
	return { request, tracker, tree, stops, seen, waitAttempt, release, owner, observedDetails, signal: () => signal, fail: () => { failWorker = true; }, outputs: (values: string[]) => { outputs = [...values]; }, steer, steerCalls, startedAtByAttempt, setAfterAttempt: (fn: typeof afterAttempt) => { afterAttempt = fn; }, setAllowed: (value: boolean) => { allowed = value; }, setPersona: (value: string | null) => { persona = value; owner.changed(); }, deny: () => { allowed = false; }, busy: () => { idle = false; }, throwOn: (n: number) => { throwOnAttempt = n; }, buildThrowOn: (n: number) => { buildThrowOnAttempt = n; } };
}

async function releaseAttempt(h: ReturnType<typeof harness>, n: number): Promise<void> { await h.waitAttempt(n); h.release(n); }

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
	assert.match(renderAgentTree(h.tree.snapshot()).join("\n"), /Mind · model · mx/);
	await h.waitAttempt(1);
	assert.deepEqual(h.seen[0]?.tools, []);
	assert.equal(h.seen[0]?.model, "native/model");
	assert.equal(h.seen[0]?.thinking, "max");
	h.release(1);
	const result = await response.completion;
	assert.equal(result.status, "done"); assert.equal(result.ok, true); assert.equal(result.output, '{"operations":[]}');
	assert.deepEqual(h.tracker.peek(response.runId)?.result?.usage, { ...emptyUsage(), input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25, turns: 1 }, "completed usage is authoritative even when earlier progress differs");
});

test("Mind first-attempt engine throw retains known progress usage", async () => {
	const h = harness(); h.throwOn(1);
	const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	const result = await response.completion;
	assert.equal(result.ok, false); assert.equal(result.status, "failed");
	assert.equal(result.error, "engine exploded");
	assert.deepEqual(h.tracker.peek(response.runId)?.result?.usage, { ...emptyUsage(), input: 10, output: 1, cost: 0.1 });
	assert.equal(h.seen.length, 1, "an engine failure never starts a format correction");
});

test("Mind correction replaces the steer callback and preserves the original start time and stop handle", async () => {
	const h = harness(); h.outputs(["{broken", '{"operations":[]}']);
	const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	await h.waitAttempt(1);
	const originalStopHandle = h.stops.get(`async:${response.runId}`);
	assert.equal(typeof originalStopHandle, "function");
	h.release(1); await h.waitAttempt(2);
	assert.equal(h.stops.get(`async:${response.runId}`), originalStopHandle, "correction keeps the original stop handle");
	assert.equal(h.seen.length, 2);
	assert.equal(h.seen[0]?.task, "Consolidate supplied facts");
	assert.ok(h.seen[1]?.task.startsWith("FORMAT CORRECTION:"));
	assert.ok(h.seen[1]?.task.endsWith("Consolidate supplied facts"));
	assert.ok(!h.seen[1]?.task.includes("{broken"));
	assert.equal(h.seen[1]?.model, "native/model"); assert.equal(h.seen[1]?.thinking, "max"); assert.deepEqual(h.seen[1]?.tools, []);
	assert.equal(h.tracker.list().length, 1); assert.equal(h.stops.size, 1);
	assert.equal(h.steer.get(`async:${response.runId}`), h.steerCalls[1], "registry points at attempt two");
	assert.notEqual(h.steer.get(`async:${response.runId}`), h.steerCalls[0], "attempt one callback was replaced");
	assert.equal(h.tree.snapshot()[0]?.startedAt, h.startedAtByAttempt[0], "correction preserves original start time");
	assert.ok(h.observedDetails.includes("format correction 1/1"), "correction detail was published before progress replaced the row detail");
	h.release(2);
	const result = await response.completion;
	assert.equal(result.ok, true); assert.equal(result.output, '{"operations":[]}');
	assert.equal(h.tracker.peek(response.runId)?.result?.usage.input, 3, "final usage sums both attempts");
});

test("Mind cumulative progress and tree usage use the first completed attempt plus second progress", async () => {
	const h = harness(); h.outputs(["bad", '{"ok":true}']); const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	await releaseAttempt(h, 1); await h.waitAttempt(2);
	const progress = h.tracker.peek(response.runId)?.progress;
	assert.equal(progress?.usage?.input, 21, "first final usage (1) plus second progress usage (20)"); assert.equal(progress?.usage?.output, 4); assert.equal(progress?.usage?.cost, 0.45);
	assert.equal(h.tree.snapshot()[0]?.usage?.input, progress?.usage?.input, "tree uses the same cumulative usage snapshot");
	assert.equal(h.tree.snapshot()[0]?.usage?.output, progress?.usage?.output);
	h.release(2); const result = await response.completion;
	assert.equal(result.ok, true);
	assert.deepEqual(h.tracker.peek(response.runId)?.result?.usage, { ...emptyUsage(), input: 3, output: 6, cacheRead: 9, cacheWrite: 12, cost: 0.75, turns: 3 });
});

test("Mind correction engine and engine-build failures retain first-attempt usage", async () => {
	for (const buildFailure of [false, true]) {
		const h = harness(); h.outputs(["bad"]); if (buildFailure) h.buildThrowOn(2); else h.throwOn(2);
		const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) continue;
		await releaseAttempt(h, 1); const result = await response.completion;
		assert.equal(result.ok, false); assert.equal(result.status, "failed");
		const usage = h.tracker.peek(response.runId)?.result?.usage;
		assert.equal(usage?.input, buildFailure ? 1 : 21, "retain first final usage and any honest second-attempt progress");
		assert.equal(usage?.output, buildFailure ? 2 : 4);
	}
});

test("receipt cancellation after first malformed success prevents correction and retains first usage", async () => {
	const h = harness(); h.outputs(["bad"]);
	h.setAfterAttempt((attempt, getResponse, result) => { if (attempt === 1) { assert.equal(result.ok, true, "fixture has completed the first successful attempt"); assert.equal(result.output, "bad"); const current = getResponse(); if (current?.ok) current.cancel(); } });
	const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	await releaseAttempt(h, 1); const result = await response.completion;
	assert.equal(h.seen.length, 1, "cancellation prevents second attempt"); assert.equal(result.status, "stopped"); assert.equal(result.ok, false);
	assert.deepEqual(h.tracker.peek(response.runId)?.result?.usage, { ...emptyUsage(), input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25, turns: 1 });
});

test("Mind does not correct parseable, empty, oversized, failed, or overlong requests", async () => {
	for (const [output, task] of [["{}", "Consolidate supplied facts"], ["", "Consolidate supplied facts"], ["x".repeat(48_001), "Consolidate supplied facts"], ["bad", "x".repeat(47_900)]] as const) {
		const h = harness(); h.outputs([output]); const response = h.request({ task }); assert.equal(response?.ok, true); if (!response?.ok) continue;
		await releaseAttempt(h, 1); await response.completion; assert.equal(h.seen.length, 1);
	}
	const failed = harness(); failed.outputs(["bad"]); failed.fail(); const response = failed.request(); assert.equal(response?.ok, true);
	if (response?.ok) { await releaseAttempt(failed, 1); await response.completion; }
	assert.equal(failed.seen.length, 1, "failed first attempt is terminal");
	const invalid = harness(); invalid.outputs(["{bad", "still bad"]); const retry = invalid.request(); assert.equal(retry?.ok, true);
	if (retry?.ok) { await releaseAttempt(invalid, 1); await releaseAttempt(invalid, 2); const result = await retry.completion; assert.equal(result.ok, false); assert.equal(result.output, "still bad"); }
	assert.equal(invalid.seen.length, 2, "invalid correction is terminal; no third attempt");
});

test("canLaunch false before correction suppresses dispatch", async () => {
	const h = harness(); h.outputs(["bad"]); const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	h.setAfterAttempt((attempt) => { if (attempt === 1) h.setAllowed(false); });
	await releaseAttempt(h, 1); const result = await response.completion;
	assert.equal(h.seen.length, 1); assert.equal(result.ok, false); assert.equal(result.status, "stopped");
	assert.equal(h.tracker.peek(response.runId)?.result?.usage.input, 1);
});

test("Mind refuses stale scope, arbitrary request fields, busy sessions and denied delegation", () => {
	for (const extra of [{ persona: "other" }, { sessionId: "stale" }, { model: "foreign/model" }, { task: "x".repeat(48_001) }]) assert.equal(harness().request(extra)?.ok, false);
	const busy = harness(); busy.busy(); assert.equal(busy.request()?.ok, false);
	const denied = harness(); denied.deny(); assert.equal(denied.request()?.ok, false);
	const stopped = harness(); stopped.owner.stop(); assert.equal(stopped.request()?.ok, false);
});

test("Mind cancellation handle, stop registry and owner revocation abort the actual worker", async () => {
	for (const action of ["cancel", "stop", "scope"] as const) {
		const h = harness(); const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) continue;
		await h.waitAttempt(1);
		if (action === "cancel") response.cancel(); else if (action === "stop") h.stops.get(`async:${response.runId}`)?.(); else h.setPersona("other");
		assert.equal(h.signal()?.aborted, true);
		const result = await response.completion;
		assert.equal(result.ok, false); assert.equal(result.status, "stopped");
	}
});

test("cancelling a Mind receipt before admission spends no model call", async () => {
	const h = harness(); const response = h.request(); assert.equal(response?.ok, true); if (!response?.ok) return;
	response.cancel(); const result = await response.completion;
	assert.equal(result.ok, false); assert.equal(result.status, "stopped"); assert.deepEqual(h.seen, []);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AsyncRunTracker, buildCompletionReport, buildPeekDigest, renderCompletion } from "../../../src/engine/async.ts";
import { piPersonaToolErrorPatch } from "../../../src/extension/shared.ts";
import type { FlowOutcome } from "../../../src/orchestration/flow-run.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { createBackgroundRuns, type TrackedRun } from "../../../src/tools/background-run.ts";
import { registerFlowTool, type FlowToolDeps } from "../../../src/tools/flow.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { ChildUsageLedger } from "../../../src/ui/usage.ts";

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const FLOW = { name: "gated-build", phases: [{ id: "plan", strategy: "magi", gate: true }, { id: "build", strategy: "fanout", needs: ["plan"] }] };

function register(
	outcome: FlowOutcome | ((run?: TrackedRun) => Promise<FlowOutcome>),
	options: { launchSnapshot?: (ctx: unknown, spec: unknown) => unknown } = {},
) {
	let tool: any;
	const tracker = new AsyncRunTracker();
	const stopRegistry = new Map<string, () => void>();
	const discarded: string[] = [];
	const tracked: TrackedRun[] = [];
	const runs = createBackgroundRuns({
		tracker,
		agentTree: new AgentTree(),
		stopRegistry,
		slots: new Semaphore(4),
		completionNotifier: { discard: (pred) => { for (const r of tracker.list()) if (pred(r)) discarded.push(r.id); } },
		startPeek: () => {},
		childUsage: new ChildUsageLedger(),
		publishPersonaCost: () => {},
	});
	const deps = {
		lastCtx: undefined,
		loadFlow: () => ({ ok: true, flow: FLOW }),
		listFlows: () => ["gated-build"],
		launchSnapshot: options.launchSnapshot ?? (() => ({ participants: [] })),
		runFlowVisible: async (_ctx: unknown, _spec: unknown, _task: string, run?: TrackedRun) => {
			if (run) tracked.push(run);
			return typeof outcome === "function" ? outcome(run) : outcome;
		},
		runs,
	} as unknown as FlowToolDeps;
	registerFlowTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, deps);
	return { tool, tracker, stopRegistry, discarded, tracked };
}

const run = (tool: any, signal?: AbortSignal) => tool.execute("call", { name: "gated-build", task: "ship it" }, signal, undefined, { cwd: "/repo" });
const runInteractive = (tool: any) => tool.execute("call", { name: "gated-build", task: "ship it" }, undefined, undefined, { cwd: "/repo", hasUI: true });
const render = (tool: any, result: any): string => tool.renderResult(result, { expanded: false }, plainTheme).render(200).join("\n");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const STOPPED: FlowOutcome = {
	ok: false,
	results: {},
	output: "the plan\n\n- flow stopped at checkpoint \"plan\": not approved (declined, dismissed, or no interactive session). Later phases did not run.",
	failedPhase: "build",
	error: "blocked: a checkpoint gate was not approved",
	stoppedAtGate: "plan",
};

test("flow receipts persist an immutable phase-scoped launch snapshot and render it without rereading", async () => {
	const participant = {
		key: "plan:reviewer · SECURITY", label: "reviewer · SECURITY", agent: "reviewer",
		model: "openai/original", modelSource: "inline", thinkingRequested: "high", setupPending: false, phase: "plan",
	};
	const snapshot = { participants: [participant] };
	let reads = 0;
	let trackerRef: AsyncRunTracker | undefined;
	const harness = register({ ok: true, results: {}, output: "finished" }, {
		launchSnapshot: (_ctx, spec) => {
			reads++;
			assert.deepEqual(spec, FLOW);
			assert.equal(trackerRef?.list().length, 0, "snapshot is captured before the tracked run launches");
			return snapshot;
		},
	});
	trackerRef = harness.tracker;
	const receipt = await runInteractive(harness.tool);
	assert.equal(reads, 1);
	assert.deepEqual(receipt.details.launch.participants, [{ ...participant }]);

	participant.model = "changed/later";
	const expanded = harness.tool.renderResult(receipt, { expanded: true }, plainTheme).render(240).join("\n");
	assert.match(expanded, /plan \/ reviewer · SECURITY/);
	assert.match(expanded, /openai\/original/);
	assert.match(expanded, /requested effort high/);
	assert.doesNotMatch(expanded, /changed\/later/);
	assert.equal(reads, 1, "history rendering only uses the persisted launch snapshot");
});

test("headless and pending flow launches retain their request-time metadata", async () => {
	const snapshot = { participants: [{
		key: "build:operator", label: "operator", agent: "operator", model: "openai/default",
		modelSource: "session", thinkingRequested: "xhigh", setupPending: true, phase: "build",
	}] };
	const harness = register({ ok: true, results: {}, output: "inline answer" }, { launchSnapshot: () => snapshot });
	const result = await run(harness.tool);
	assert.deepEqual(result.details.launch.participants, snapshot.participants);
	const card = harness.tool.renderResult(result, { expanded: false }, plainTheme).render(240).join("\n");
	assert.match(card, /build \/ operator/);
	assert.match(card, /model pending/);
	assert.match(card, /openai\/default/);
	assert.match(card, /requested effort xhigh/);
});

test("missing flow launch metadata is explicit and never blocks the run", async () => {
	const harness = register({ ok: true, results: {}, output: "finished" }, {
		launchSnapshot: () => { throw new Error("model lookup failed"); },
	});
	const receipt = await runInteractive(harness.tool);
	assert.equal(receipt.isError, false);
	assert.deepEqual(receipt.details.launch, { participants: [], unavailable: true });
	assert.match(render(harness.tool, receipt), /Launch metadata unavailable/);
});

test("a flow stopped at a checkpoint is a result, not a tool error: the plan is delivered and the card says 'stopped'", async () => {
	const { tool } = register(STOPPED);
	const result = await run(tool);
	assert.equal(result.isError, false, "the operator's 'no' is not a tool failure");
	assert.equal(piPersonaToolErrorPatch(result.details), undefined, "no failure patch may flip it back to an error");
	assert.equal(result.details.stoppedAtGate, "plan");
	assert.match(result.content[0].text, /the plan/);
	assert.match(result.content[0].text, /flow stopped at checkpoint "plan"/);
	const card = render(tool, result);
	assert.match(card, /flow stopped · checkpoint plan/);
	assert.doesNotMatch(card, /flow failed/);
});

test("an ordinary flow failure is still a tool error with the 'failed' card", async () => {
	const { tool } = register({ ok: false, results: {}, output: "Flow failed at phase \"plan\": boom", failedPhase: "plan", error: "boom" });
	const result = await run(tool);
	assert.equal(result.isError, true);
	assert.ok(piPersonaToolErrorPatch(result.details), "the failure marker stays on ordinary failures");
	assert.match(render(tool, result), /flow failed · phase plan · boom/);
});

test("a completed flow is neither stopped nor failed", async () => {
	const { tool } = register({ ok: true, results: {}, output: "all done" });
	const result = await run(tool);
	assert.equal(result.isError, false);
	assert.match(render(tool, result), /flow complete/);
});

// ── interactive: ONE tracked background run, one wake ───────────────────────────────────────

test("an interactive flow returns a receipt at once and settles as ONE tracked run the operator can stop", async () => {
	let release!: (outcome: FlowOutcome) => void;
	const { tool, tracker, stopRegistry, tracked } = register(() => new Promise<FlowOutcome>((resolve) => { release = resolve; }));
	const result = await runInteractive(tool);

	assert.equal(result.isError, false);
	const id = result.details.runId as string;
	assert.match(id, /^run-/);
	assert.equal(result.content[0].text.startsWith(`Launched flow ${id} (gated-build) in the background`), true);
	assert.match(result.content[0].text, /woken ONCE/);
	assert.match(result.content[0].text, /checkpoint waits for the operator, not for you/);
	assert.match(result.content[0].text, /never sleep, poll, peek/);
	assert.match(render(tool, result), /flow launched run-\S+ · gated-build/);
	assert.equal(stopRegistry.has(`async:${id}`), true, "the run is reachable through intercom stop / the overlay key");

	await tick();
	assert.equal(tracked[0]?.rootId, `async:${id}`, "the flow's tree hangs under the run's own root");
	assert.equal(tracker.peek(id)?.status, "running", "the receipt does not wait for the flow");

	release({ ok: true, results: {}, output: "the finished flow answer" });
	await tick();
	const settled = tracker.peek(id)!;
	assert.equal(settled.status, "done");
	const wake = renderCompletion([settled], (text) => text, () => undefined);
	assert.match(wake, /✅ run-\S+ \(flow-gated-build\) done/);
	assert.match(wake, /the finished flow answer/);
});

test("an interactive flow rejected at a checkpoint settles STOPPED (not failed) and the wake carries the plan", async () => {
	const { tool, tracker } = register(STOPPED);
	const result = await runInteractive(tool);
	await tick();

	const settled = tracker.peek(result.details.runId as string)!;
	assert.equal(settled.status, "stopped", "a human decision is not a failure");
	assert.match(settled.error ?? "", /stopped at checkpoint "plan"/);
	const report = buildCompletionReport([settled], (text) => text);
	assert.doesNotMatch(report, /❌|Handle each failure/, "no retry guidance for an operator's no");
	assert.match(report, /1 stopped/);
	assert.match(report, /the plan\n/, "the gated plan the user paid for reaches the model");
	assert.match(report, /flow stopped at checkpoint "plan"/);
});

test("an interactive flow that fails settles failed with its cause and its partial output", async () => {
	const { tool, tracker } = register({ ok: false, results: {}, output: 'Flow failed at phase "plan": boom', failedPhase: "plan", error: "boom", failureKind: "agent" });
	const result = await runInteractive(tool);
	await tick();

	const settled = tracker.peek(result.details.runId as string)!;
	assert.equal(settled.status, "failed");
	assert.equal(settled.error, "boom");
	assert.match(buildCompletionReport([settled], (text) => text), /Flow failed at phase "plan": boom/);
});

test("a flow awaiting its checkpoint reads as waiting for the operator in peek, never as stalled", async () => {
	let release!: (outcome: FlowOutcome) => void;
	const { tool, tracker, tracked } = register(() => new Promise<FlowOutcome>((resolve) => { release = resolve; }));
	const result = await runInteractive(tool);
	await tick();
	const id = result.details.runId as string;

	tracked[0]!.onAwaiting("waiting for operator at checkpoint plan");
	const digest = buildPeekDigest([tracker.peek(id)!], { now: Date.now() + 10 * 60_000, stallMs: 90_000 });
	assert.match(digest, /waiting for operator at checkpoint plan/);
	assert.doesNotMatch(digest, /possibly stuck/);
	release({ ok: true, results: {}, output: "x" });
	await tick();
});

test("a headless flow is the SAME run joined in the call: one inline result, no follow-up", async () => {
	const { tool, tracker, discarded } = register({ ok: true, results: {}, output: "inline answer" });
	const result = await run(tool);

	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /inline answer/);
	assert.equal(result.details.runId, undefined, "no receipt: the single turn carries the result");
	assert.equal(tracker.list().length, 1, "it was a tracked run all along");
	assert.deepEqual(discarded, [tracker.list()[0]!.id], "the inline return replaces the completion follow-up");
});

test("a flow whose runner throws reports 'flow failed: <cause>' headless and settles failed interactive", async () => {
	const boom = () => Promise.reject(new Error("verifyFlowRefs exploded"));
	const headless = register(boom);
	const inline = await run(headless.tool);
	assert.equal(inline.isError, true);
	assert.match(inline.content[0].text, /^flow failed: verifyFlowRefs exploded/);

	const interactive = register(boom);
	const receipt = await runInteractive(interactive.tool);
	await tick();
	assert.equal(interactive.tracker.peek(receipt.details.runId as string)?.status, "failed");
});

test("aborting a headless flow call stops the run it joined and returns once the run has settled", async () => {
	const { tool } = register((run) => new Promise<FlowOutcome>((resolve) => {
		run!.signal.addEventListener("abort", () => resolve({ ok: false, results: {}, output: "partial", error: "cancelled: the flow run was aborted", failureKind: "abort", cancelled: true }), { once: true });
	}));
	const ac = new AbortController();
	const pending = run(tool, ac.signal) as Promise<{ isError: boolean; content: Array<{ text: string }> }>;
	await tick();
	ac.abort();
	const result = await pending;
	assert.equal(result.isError, true, "a cancelled flow is a failed tool call, exactly as before");
	assert.match(result.content[0]!.text, /partial/);
});

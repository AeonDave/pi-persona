import assert from "node:assert/strict";
import { test } from "node:test";

import { AsyncRunTracker, buildCompletionReport, buildPeekDigest, isAsyncRunStalled, STALL_FLAG_MS, type AsyncRun } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { ChildUsageLedger } from "../../../src/ui/usage.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { createBackgroundRuns, type TrackedRun } from "../../../src/tools/background-run.ts";

const ok = (output: string, over: Partial<AgentResult> = {}): AgentResult => ({ agent: "council", output, usage: { ...emptyUsage(), input: 7, output: 3, turns: 1 }, ok: true, ...over });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(slots = 4) {
	let clock = 1_000;
	const tracker = new AsyncRunTracker({ now: () => clock });
	const tree = new AgentTree(() => clock);
	const stopRegistry = new Map<string, () => void>();
	const childUsage = new ChildUsageLedger();
	const discarded: string[] = [];
	const starts: number[] = [];
	tracker.onComplete((run) => {
		tree.update(`async:${run.id}`, { status: run.status });
		tree.remove(`async:${run.id}`);
		stopRegistry.delete(`async:${run.id}`);
	});
	const runs = createBackgroundRuns({
		tracker,
		agentTree: tree,
		stopRegistry,
		slots: new Semaphore(slots),
		completionNotifier: { discard: (pred) => { for (const run of tracker.list()) if (pred(run)) discarded.push(run.id); } },
		startPeek: () => { starts.push(clock); },
		childUsage,
		publishPersonaCost: () => {},
	});
	return { tracker, tree, stopRegistry, runs, childUsage, discarded, starts, advance: (ms: number) => { clock += ms; } };
}

/** A unit of work that parks until released, and reports the handle it was given. */
function parked() {
	let release!: (result: AgentResult) => void;
	let handle: TrackedRun | undefined;
	const work = (run: TrackedRun): Promise<AgentResult> => {
		handle = run;
		return new Promise<AgentResult>((resolve) => { release = resolve; });
	};
	return { work, release: (result: AgentResult) => release(result), handle: () => handle };
}

test("a launched council is ONE tracked run: rooted at async:<id>, stoppable by that key, queued until admitted", async () => {
	const h = harness();
	const p = parked();
	const id = h.runs.launch({ kind: "council", label: "council magi", task: "ship it?", inline: false }, p.work);

	assert.match(id, /^run-/);
	const row = h.tree.snapshot().find((node) => node.id === `async:${id}`);
	assert.equal(row?.kind, "council", "the run is a root row of its own kind");
	assert.equal(h.stopRegistry.has(`async:${id}`), true, "the key intercom stop and the overlay already speak");
	assert.equal(h.starts.length, 1, "interactive: the status monitor is armed");
	assert.equal(h.tracker.peek(id)?.mutates, true, "a strategy's legs may write: the run is a potential writer");

	await tick();
	assert.equal(p.handle()?.rootId, `async:${id}`, "the work hangs its nodes under the run's own root");
	assert.equal(h.tracker.peek(id)?.queued, undefined, "admitted: the queue marker is gone");

	p.release(ok("RULING"));
	await tick();
	assert.equal(h.tracker.peek(id)?.status, "done");
	assert.equal(h.tracker.peek(id)?.result?.output, "RULING");
});

test("the run takes ONE launch-pool slot and waits visibly behind a full pool; stopping it while queued never runs the work", async () => {
	const h = harness(1);
	const first = parked();
	const second = parked();
	const a = h.runs.launch({ kind: "council", label: "council a", task: "a", inline: false }, first.work);
	const b = h.runs.launch({ kind: "flow", label: "flow b", task: "b", inline: false }, second.work);
	await tick();

	assert.equal(h.tracker.peek(a)?.queued, undefined);
	assert.equal(h.tracker.peek(b)?.queued, true, "behind the single slot");
	assert.equal(h.tree.snapshot().find((node) => node.id === `async:${b}`)?.detail, "queued");
	assert.equal(second.handle(), undefined, "the second run's work has not started");
	assert.match(buildPeekDigest(h.tracker.list(), { now: 5_000, stallMs: 90_000 }), /queued \(waiting for concurrency slot\)/);

	h.stopRegistry.get(`async:${b}`)?.();
	await tick();
	assert.equal(h.tracker.peek(b)?.status, "stopped", "a queued run stops as a stop, not a failure");
	assert.equal(second.handle(), undefined, "…and its work never started");

	first.release(ok("a"));
	await tick();
});

test("stopping a running run aborts the signal its work was handed and settles it stopped", async () => {
	const h = harness();
	let seen: AbortSignal | undefined;
	const id = h.runs.launch({ kind: "flow", label: "flow gated", task: "t", inline: false }, (run) => new Promise<AgentResult>((resolve) => {
		seen = run.signal;
		run.signal.addEventListener("abort", () => resolve({ agent: "flow", output: "partial plan", usage: emptyUsage(), ok: false, error: "cancelled", failureKind: "abort" }), { once: true });
	}));
	await tick();
	assert.equal(seen?.aborted, false);

	h.stopRegistry.get(`async:${id}`)?.();
	await tick();

	assert.equal(seen?.aborted, true);
	const run = h.tracker.peek(id)!;
	assert.equal(run.status, "stopped");
	assert.match(buildCompletionReport([run], (t) => t), /partial output before it was stopped:\npartial plan/, "the work done so far reaches the follow-up");
});

test("leg progress feeds cumulative tokens; only a leg's real headway refreshes the run's stall clock", async () => {
	const h = harness();
	const p = parked();
	const id = h.runs.launch({ kind: "council", label: "council magi", task: "t", inline: false }, p.work);
	await tick();
	const run = h.tracker.peek(id)!;
	const admittedAt = run.lastAdvanceAt!;

	h.advance(60_000);
	p.handle()!.onProgress("melchior", { tokens: 100 });
	p.handle()!.onProgress("balthasar", { tokens: 50 });
	p.handle()!.onProgress("melchior", { tokens: 120 });
	assert.equal(h.tracker.peek(id)?.progress.tokens, 170, "tokens are summed across legs, each at its latest reading");
	assert.equal(h.tracker.peek(id)!.lastAdvanceAt, admittedAt + 60_000, "a leg that produced more is headway, on the tracker clock");
	h.advance(10);
	p.handle()!.onProgress("casper", {});
	assert.equal(h.tracker.peek(id)?.progress.tokens, 170, "a reading without tokens keeps the leg's last figure");
	assert.equal(h.tracker.peek(id)!.lastAdvanceAt, admittedAt + 60_000, "a bare event is not headway");
});

test("a chatty leg earns no credit; a completed tool call or a longer answer does, judged per leg", async () => {
	const h = harness();
	const p = parked();
	const id = h.runs.launch({ kind: "council", label: "council magi", task: "t", inline: false }, p.work);
	await tick();
	const admittedAt = h.tracker.peek(id)!.lastAdvanceAt!;
	const leg = p.handle()!;

	leg.onProgress("melchior", { output: "thinking", tokens: 10 }); // headway: the baseline reading
	const base = h.tracker.peek(id)!.lastAdvanceAt!;
	assert.equal(base, admittedAt, "the baseline reading lands at the admission instant");
	h.advance(100_000);
	// `npm run dev` in one leg: the same reading again and again, the tool's output never counted.
	for (let i = 0; i < 5; i++) leg.onProgress("melchior", { output: "thinking", tokens: 10 });
	assert.equal(h.tracker.peek(id)!.lastAdvanceAt, base, "re-emitted readings are not headway");
	assert.equal(isAsyncRunStalled(h.tracker.peek(id)!, admittedAt + 100_000, STALL_FLAG_MS), true, "so the run reads as stalled");

	leg.onProgress("melchior", { output: "thinking", tokens: 10, toolEvent: { phase: "end", callId: "c1", name: "bash" } });
	assert.equal(h.tracker.peek(id)!.lastAdvanceAt, base + 100_000, "a completed tool call is headway");
	h.advance(5_000);
	leg.onProgress("balthasar", { output: "a fresh leg starts from nothing", tokens: 3 });
	assert.equal(h.tracker.peek(id)!.lastAdvanceAt, base + 105_000, "another leg's output is its own headway");
});

test("a failed run hands its output to the report's partial-output salvage; a thrown error settles it failed with the message", async () => {
	const h = harness();
	const failed = h.runs.launch({ kind: "council", label: "council critic-loop", task: "t", inline: false }, async () => ok("last draft\n\nUNRESOLVED CRITIQUE", { ok: false, error: "critic-loop exhausted" }));
	const thrown = h.runs.launch({ kind: "council", label: "council magi", task: "t", inline: false }, async () => { throw new Error('unknown roster "nope" (available teams: magi)'); });
	await tick();

	const failedRun = h.tracker.peek(failed)!;
	assert.equal(failedRun.status, "failed");
	assert.match(buildCompletionReport([failedRun], (t) => t), /partial output before it failed:\nlast draft\n\nUNRESOLVED CRITIQUE/);
	const thrownRun = h.tracker.peek(thrown)!;
	assert.equal(thrownRun.status, "failed");
	assert.equal(thrownRun.error, 'unknown roster "nope" (available teams: magi)');
});

test("an operator wait is recorded on the run and clears when released", async () => {
	const h = harness();
	const p = parked();
	const id = h.runs.launch({ kind: "flow", label: "flow gated", task: "t", inline: false }, p.work);
	await tick();
	p.handle()!.onAwaiting("waiting for operator at checkpoint plan");
	assert.equal(h.tracker.peek(id)?.awaiting, "waiting for operator at checkpoint plan");
	p.handle()!.onAwaiting(undefined);
	assert.equal(h.tracker.peek(id)?.awaiting, undefined);
	p.release(ok("done"));
	await tick();
});

test("settle() joins a headless run: drops the follow-up it replaces, bills the usage once, and returns the settled run", async () => {
	const h = harness();
	const p = parked();
	const id = h.runs.launch({ kind: "council", label: "council magi", task: "t", inline: true }, p.work);
	assert.equal(h.starts.length, 0, "headless: nobody reads a status card");

	const joined = h.runs.settle([id], undefined);
	await tick();
	p.release(ok("THE RULING"));
	const { runs: [run], usage } = await joined;
	assert.ok(run);

	assert.equal(run.status, "done");
	assert.equal(run.result?.output, "THE RULING");
	assert.equal(usage.input, 7);
	assert.deepEqual(h.discarded, [id], "the inline return is the delivery: no wake follows");
	assert.equal((await h.runs.settle([id], undefined)).usage.input, 0, "billed once per run id");
});

test("aborting the headless call stops the run it joined and returns once it has settled", async () => {
	const h = harness();
	const id = h.runs.launch({ kind: "flow", label: "flow x", task: "t", inline: true }, (run) => new Promise<AgentResult>((resolve) => {
		run.signal.addEventListener("abort", () => resolve({ agent: "flow", output: "", usage: emptyUsage(), ok: false, error: "cancelled", failureKind: "abort" }), { once: true });
	}));
	const ac = new AbortController();
	const joined = h.runs.settle([id], ac.signal);
	await tick();
	ac.abort();
	const { runs: [run] } = await joined;
	assert.equal(run?.status, "stopped");
});

test("settle() on a run already settled returns immediately", async () => {
	const h = harness();
	const id = h.runs.launch({ kind: "council", label: "council magi", task: "t", inline: true }, async () => ok("quick"));
	await tick();
	const { runs: [run] } = await h.runs.settle([id], undefined);
	assert.equal((run as AsyncRun).status, "done");
});

test("settle() joins several runs: reports each settle as (done, total), stops all of them on abort, bills each once", async () => {
	const h = harness();
	const pa = parked();
	const pb = parked();
	const a = h.runs.launch({ kind: "council", label: "council a", task: "a", inline: true }, pa.work);
	const b = h.runs.launch({ kind: "council", label: "council b", task: "b", inline: true }, pb.work);
	const seen: string[] = [];
	const joined = h.runs.settle([a, b], undefined, (done, total) => seen.push(`${done}/${total}`));
	await tick();
	pa.release(ok("A"));
	await tick();
	assert.deepEqual(seen, ["1/2"]);
	pb.release(ok("B"));
	const { runs, usage } = await joined;
	assert.deepEqual(runs.map((run) => run.result?.output), ["A", "B"]);
	assert.equal(usage.input, 14, "both runs' usage, once");
	assert.deepEqual(h.discarded.sort(), [a, b].sort(), "neither follow-up is left to fire");

	const ac = new AbortController();
	const c = h.runs.launch({ kind: "flow", label: "flow c", task: "c", inline: true }, (run) => new Promise<AgentResult>((resolve) => {
		run.signal.addEventListener("abort", () => resolve({ agent: "flow", output: "", usage: emptyUsage(), ok: false, error: "cancelled", failureKind: "abort" }), { once: true });
	}));
	const d = h.runs.launch({ kind: "flow", label: "flow d", task: "d", inline: true }, (run) => new Promise<AgentResult>((resolve) => {
		run.signal.addEventListener("abort", () => resolve({ agent: "flow", output: "", usage: emptyUsage(), ok: false, error: "cancelled", failureKind: "abort" }), { once: true });
	}));
	const both = h.runs.settle([c, d], ac.signal);
	await tick();
	ac.abort();
	assert.deepEqual((await both).runs.map((run) => run.status), ["stopped", "stopped"]);
});

test("a run tells its work whether the launching turn has ended: interactive is background, headless is not", async () => {
	const h = harness();
	const seen: boolean[] = [];
	h.runs.launch({ kind: "council", label: "council i", task: "t", inline: false }, async (run) => { seen.push(run.background); return ok("i"); });
	h.runs.launch({ kind: "council", label: "council h", task: "t", inline: true }, async (run) => { seen.push(run.background); return ok("h"); });
	await tick();
	assert.deepEqual(seen, [true, false]);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { type AsyncRun, AsyncRunTracker, buildCompletionReport, CompletionNotifier, buildPeekDigest } from "../../../src/engine/async.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const tick = () => new Promise((r) => setTimeout(r, 5));

const doneRun = (id: string, agent: string, output: string): AsyncRun => ({
	id,
	agent,
	task: "t",
	status: "done",
	progress: { output, turns: 1, tokens: 1 },
	result: { agent, output, usage: usage(), ok: true },
});
const failedRun = (id: string, agent: string, error: string): AsyncRun => ({
	id,
	agent,
	task: "t",
	status: "failed",
	progress: { output: "", turns: 1, tokens: 1 },
	error,
});

/** Controllable clock: timers fire only when tick() is called, modelling debounce/retry rounds. */
function fakeClock() {
	let seq = 0;
	let timers: Array<{ id: number; fn: () => void }> = [];
	return {
		setTimer: (fn: () => void) => {
			const id = ++seq;
			timers.push({ id, fn });
			return id;
		},
		clearTimer: (h: unknown) => {
			timers = timers.filter((t) => t.id !== h);
		},
		/** Fire every timer currently armed (re-arms land in the next round). */
		tick: () => {
			const due = timers;
			timers = [];
			for (const t of due) t.fn();
		},
		armed: () => timers.length,
	};
}

test("the tracker caps retained runs by evicting old completed ones", async () => {
	const tracker = new AsyncRunTracker();
	for (let i = 0; i < 40; i++) {
		tracker.launch({ agent: `a${i}`, task: "t" }, async () => ({ agent: `a${i}`, output: "o", usage: usage(), ok: true }));
	}
	await tick();
	await tick();
	assert.ok(tracker.list().length <= 25, `retained ${tracker.list().length} runs (expected ≤ 25)`);
});

test("launch tracks a run and exposes its result on completion", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "scout", task: "explore" }, async (onProgress) => {
		onProgress({ output: "working", turns: 1, tokens: 5 });
		return { agent: "scout", output: "done", usage: usage(), ok: true } satisfies AgentResult;
	});
	assert.match(id, /^run-/);
	await tick();
	const run = tracker.peek(id);
	assert.equal(run?.status, "done");
	assert.equal(run?.result?.output, "done");
});

test("launch passes the run id to the thunk (so the launcher can key a steer handle by it)", async () => {
	const tracker = new AsyncRunTracker();
	let seen: string | undefined;
	const id = tracker.launch({ agent: "a", task: "t" }, async (_onProgress, runId) => {
		seen = runId;
		return { agent: "a", output: "x", usage: usage(), ok: true };
	});
	await tick();
	assert.equal(seen, id, "the thunk receives the same id launch() returned");
});

test("onComplete fires when a run settles", async () => {
	const tracker = new AsyncRunTracker();
	const completed: string[] = [];
	tracker.onComplete((r) => completed.push(r.id));
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({ agent: "a", output: "x", usage: usage(), ok: true }));
	await tick();
	assert.deepEqual(completed, [id]);
});

test("a failing run is marked failed with its error", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({
		agent: "a",
		output: "",
		usage: usage(),
		ok: false,
		error: "boom",
	}));
	await tick();
	assert.equal(tracker.peek(id)?.status, "failed");
	assert.equal(tracker.peek(id)?.error, "boom");
});

test("running() lists only in-flight runs", async () => {
	const tracker = new AsyncRunTracker();
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	tracker.launch({ agent: "a", task: "t" }, async () => {
		await gate;
		return { agent: "a", output: "x", usage: usage(), ok: true };
	});
	assert.equal(tracker.running().length, 1);
	release();
	await tick();
	assert.equal(tracker.running().length, 0);
});

test("buildPeekDigest summarises runs (counts, ids, statuses)", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "scout", task: "t", status: "running", progress: { output: "", turns: 2, tokens: 30 } },
		{ id: "run-2", agent: "operator", task: "t", status: "done", progress: { output: "", turns: 1, tokens: 10 }, result: { agent: "operator", output: "all good", usage: usage(), ok: true } },
	]);
	assert.match(digest, /2 \(1 running\)/);
	assert.match(digest, /run-1/);
	assert.match(digest, /run-2/);
	assert.match(digest, /all good/);
});

test("buildCompletionReport summarises a mixed batch with one tidy first line", () => {
	const report = buildCompletionReport([doneRun("run-1", "scout", "found it"), failedRun("run-2", "operator", "context length exceeded")], (t) => t);
	const firstLine = report.split("\n")[0];
	assert.equal(firstLine, "[pi-persona] 2 async runs settled — 1 done, 1 failed");
	assert.match(report, /✅ run-1 \(scout\) done:/);
	assert.match(report, /found it/);
	assert.match(report, /❌ 1 failed:/);
	assert.match(report, /run-2 \(operator\): context length exceeded/);
});

test("buildCompletionReport includes anti-loop guidance only when something failed", () => {
	const withFailure = buildCompletionReport([failedRun("run-1", "operator", "boom")], (t) => t);
	assert.match(withFailure, /Do not re-issue the same failing delegation repeatedly/);
	assert.match(withFailure, /retry ONCE with a different model/);
	const allDone = buildCompletionReport([doneRun("run-1", "scout", "ok")], (t) => t);
	assert.doesNotMatch(allDone, /Do not re-issue/);
	assert.match(allDone, /1 async run settled — 1 done, 0 failed/); // singular, no plural "s"
});

test("buildCompletionReport fences untrusted sub-agent text (output and reasons)", () => {
	const fence = (t: string) => `<F>${t}</F>`;
	const report = buildCompletionReport([doneRun("run-1", "scout", "OUT"), failedRun("run-2", "op", "ERR")], fence);
	assert.match(report, /<F>OUT<\/F>/);
	assert.match(report, /<F>.*run-2 \(op\): ERR.*<\/F>/s);
});

test("CompletionNotifier coalesces a burst into a single idle delivery", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = new CompletionNotifier({
		isIdle: () => true,
		hasPending: () => false,
		deliver: (r) => sent.push(r),
		fence: (t) => t,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(doneRun("run-1", "a", "x"));
	n.notify(failedRun("run-2", "b", "boom"));
	n.notify(doneRun("run-3", "c", "y"));
	assert.equal(clock.armed(), 1, "a burst arms exactly one (debounced) flush");
	clock.tick();
	assert.equal(sent.length, 1, "the whole burst is delivered as one message");
	assert.match(sent[0] ?? "", /3 async runs settled — 2 done, 1 failed/);
});

test("CompletionNotifier defers while the supervisor is busy, then delivers when idle", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let idle = false;
	const n = new CompletionNotifier({
		isIdle: () => idle,
		hasPending: () => false,
		deliver: (r) => sent.push(r),
		fence: (t) => t,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(failedRun("run-1", "op", "boom"));
	clock.tick(); // busy → re-arms, delivers nothing
	assert.equal(sent.length, 0);
	assert.equal(clock.armed(), 1, "it keeps a retry armed while busy");
	idle = true;
	clock.tick();
	assert.equal(sent.length, 1, "delivered once the supervisor goes idle");
});

test("CompletionNotifier treats a queued supervisor as busy (avoids piling onto the queue)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let pending = true;
	const n = new CompletionNotifier({
		isIdle: () => true,
		hasPending: () => pending,
		deliver: (r) => sent.push(r),
		fence: (t) => t,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(doneRun("run-1", "a", "x"));
	clock.tick();
	assert.equal(sent.length, 0, "does not deliver while messages are already queued");
	pending = false;
	clock.tick();
	assert.equal(sent.length, 1);
});

test("CompletionNotifier requeues and retries when a delivery races a just-started turn", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let failNext = true;
	const n = new CompletionNotifier({
		isIdle: () => true,
		hasPending: () => false,
		deliver: (r) => {
			if (failNext) {
				failNext = false;
				throw new Error("Agent is already processing a prompt");
			}
			sent.push(r);
		},
		fence: (t) => t,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(failedRun("run-1", "op", "boom"));
	clock.tick(); // deliver throws → requeue + re-arm
	assert.equal(sent.length, 0);
	assert.equal(clock.armed(), 1);
	clock.tick(); // retry succeeds, nothing was lost
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /run-1 \(op\): boom/);
});

test("CompletionNotifier.cancel() drops the armed flush (reload hygiene)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = new CompletionNotifier({
		isIdle: () => true,
		hasPending: () => false,
		deliver: (r) => sent.push(r),
		fence: (t) => t,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(doneRun("run-1", "a", "x"));
	n.cancel();
	assert.equal(clock.armed(), 0, "the timer is cleared");
	clock.tick();
	assert.equal(sent.length, 0, "nothing is delivered after cancel");
});

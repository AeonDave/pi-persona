import { test } from "node:test";
import assert from "node:assert/strict";

import { type AsyncRun, AsyncRunTracker, buildCompletionReport, IdleCoalescingNotifier, buildPeekDigest } from "../../../src/engine/async.ts";
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

test("a thunk that throws synchronously still settles the run as failed (onComplete fires)", async () => {
	const tracker = new AsyncRunTracker();
	const completed: string[] = [];
	tracker.onComplete((r) => completed.push(r.id));
	const id = tracker.launch({ agent: "a", task: "t" }, () => {
		throw new Error("engine blew up before returning a promise");
	});
	await tick();
	assert.deepEqual(completed, [id], "onComplete fires even on a synchronous thunk throw");
	assert.equal(tracker.peek(id)?.status, "failed");
	assert.match(tracker.peek(id)?.error ?? "", /engine blew up/);
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

test("buildCompletionReport suppresses the follow-up when every run failed", () => {
	// All failed → empty string → no supervisor follow-up (prevents retry loops).
	// The user-facing ui.notify in tracker.onComplete surfaces the failure instead.
	const allFailed = buildCompletionReport([failedRun("run-1", "operator", "boom")], (t) => t);
	assert.equal(allFailed, "");
	const allDone = buildCompletionReport([doneRun("run-1", "scout", "ok")], (t) => t);
	assert.doesNotMatch(allDone, /Do not re-issue/);
	assert.match(allDone, /1 async run settled — 1 done, 0 failed/); // singular, no plural "s"
});

test("buildCompletionReport still includes anti-loop guidance on mixed batches (some done, some failed)", () => {
	const mixed = buildCompletionReport([doneRun("run-1", "scout", "ok"), failedRun("run-2", "operator", "boom")], (t) => t);
	assert.match(mixed, /Do not re-issue the same failing delegation repeatedly/);
	assert.match(mixed, /retry ONCE with a different model/);
});

test("buildCompletionReport fences untrusted sub-agent text (output and reasons)", () => {
	const fence = (t: string) => `<F>${t}</F>`;
	const report = buildCompletionReport([doneRun("run-1", "scout", "OUT"), failedRun("run-2", "op", "ERR")], fence);
	assert.match(report, /<F>OUT<\/F>/);
	assert.match(report, /<F>.*run-2 \(op\): ERR.*<\/F>/s);
});

/** A string-rendering notifier (render = join with "|") for exercising the generic mechanism. */
function makeStrNotifier(
	clock: ReturnType<typeof fakeClock>,
	deps: { isIdle: () => boolean; hasPending?: () => boolean; deliver: (m: string) => void },
): IdleCoalescingNotifier<string> {
	return new IdleCoalescingNotifier<string>({
		isIdle: deps.isIdle,
		hasPending: deps.hasPending ?? (() => false),
		deliver: deps.deliver,
		render: (xs) => xs.join("|"),
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
}

test("IdleCoalescingNotifier coalesces a burst into a single idle delivery", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => sent.push(m) });
	n.notify("a");
	n.notify("b");
	n.notify("c");
	assert.equal(clock.armed(), 1, "a burst arms exactly one (debounced) flush");
	clock.tick();
	assert.deepEqual(sent, ["a|b|c"], "the whole burst is rendered and delivered once");
});

test("IdleCoalescingNotifier defers while the supervisor is busy, then delivers when idle", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let idle = false;
	const n = makeStrNotifier(clock, { isIdle: () => idle, deliver: (m) => sent.push(m) });
	n.notify("q");
	clock.tick(); // busy → re-arms, delivers nothing
	assert.equal(sent.length, 0);
	assert.equal(clock.armed(), 1, "it keeps a retry armed while busy");
	idle = true;
	clock.tick();
	assert.deepEqual(sent, ["q"], "delivered once the supervisor goes idle");
});

test("IdleCoalescingNotifier treats a queued supervisor as busy (avoids piling onto the queue)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let pending = true;
	const n = makeStrNotifier(clock, { isIdle: () => true, hasPending: () => pending, deliver: (m) => sent.push(m) });
	n.notify("q");
	clock.tick();
	assert.equal(sent.length, 0, "does not deliver while messages are already queued");
	pending = false;
	clock.tick();
	assert.deepEqual(sent, ["q"]);
});

test("IdleCoalescingNotifier requeues and retries when a delivery races a just-started turn", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let failNext = true;
	const n = makeStrNotifier(clock, {
		isIdle: () => true,
		deliver: (m) => {
			if (failNext) {
				failNext = false;
				throw new Error("Agent is already processing a prompt");
			}
			sent.push(m);
		},
	});
	n.notify("q");
	clock.tick(); // deliver throws → requeue + re-arm
	assert.equal(sent.length, 0);
	assert.equal(clock.armed(), 1);
	clock.tick(); // retry succeeds, nothing was lost
	assert.deepEqual(sent, ["q"]);
});

test("IdleCoalescingNotifier.cancel() drops the armed flush (reload hygiene)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => sent.push(m) });
	n.notify("q");
	n.cancel();
	assert.equal(clock.armed(), 0, "the timer is cleared");
	clock.tick();
	assert.equal(sent.length, 0, "nothing is delivered after cancel");
});

test("IdleCoalescingNotifier renders settled runs via buildCompletionReport", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = new IdleCoalescingNotifier<AsyncRun>({
		isIdle: () => true,
		hasPending: () => false,
		deliver: (m) => sent.push(m),
		render: (runs) => buildCompletionReport(runs, (t) => t),
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	n.notify(doneRun("run-1", "scout", "ok"));
	n.notify(failedRun("run-2", "operator", "boom"));
	clock.tick();
	assert.equal(sent.length, 1, "both settled runs arrive as one report");
	assert.match(sent[0] ?? "", /2 async runs settled — 1 done, 1 failed/);
	assert.match(sent[0] ?? "", /run-2 \(operator\): boom/);
});

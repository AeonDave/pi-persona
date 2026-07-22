import { after, test } from "node:test";

// Keep the event loop ref'd for the whole file. Several tests below await a promise
// resolved only by an UNREF'd timer (tracker.waitFor timeouts, coalescing-notifier flushes).
// Without a ref'd handle the loop drains mid-await → node:test aborts with "Promise
// resolution is still pending but the event loop has already resolved" and cascades
// `cancelledByParent` to every later test. A ref'd keeper, cleared after all tests, holds
// the loop open so those timers fire.
const _loopKeeper = setInterval(() => {}, 60_000);
after(() => clearInterval(_loopKeeper));
import assert from "node:assert/strict";

import { type AsyncRun, AsyncRunTracker, buildCheckIn, buildCompletionReport, buildPeekAlert, dedupeRunsById, IdleCoalescingNotifier, buildPeekDigest, PeekWatcher, renderCompletion } from "../../../src/engine/async.ts";
import type { ProgressSnapshot } from "../../../src/engine/stream.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { PersistenceNudge } from "../../../src/core/nudge.ts";

// The real surrender scan, so the test exercises the actual composition (report + persistence note),
// not a hand-rolled stand-in for it.
const surrenderScan = ((n) => (t: string) => n.scan(t))(new PersistenceNudge());

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

test("a tracker built with a larger maxRetained retains more than the default 25 settled runs", async () => {
	const tracker = new AsyncRunTracker({ maxRetained: 40 });
	for (let i = 0; i < 60; i++) {
		tracker.launch({ agent: `a${i}`, task: "t" }, async () => ({ agent: `a${i}`, output: "o", usage: usage(), ok: true }));
	}
	await tick();
	await tick();
	assert.ok(tracker.list().length <= 40, `retained ${tracker.list().length} runs (expected ≤ 40)`);
	assert.ok(tracker.list().length > 25, `retained ${tracker.list().length} runs (expected > 25 — custom bound honored)`);
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

test("launch carries the optional label/model through onto the tracked entry (existing agent/task-only calls still compile)", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "scout", task: "explore", label: "atlas-static", model: "sonnet" }, async () => ({
		agent: "scout",
		output: "done",
		usage: usage(),
		ok: true,
	}));
	assert.equal(tracker.peek(id)?.label, "atlas-static");
	assert.equal(tracker.peek(id)?.model, "sonnet");
	await tick();
});

const runningRun = (lastAdvanceAt: number, over: Partial<AsyncRun> = {}): AsyncRun => ({
	id: "run-1",
	agent: "operator",
	task: "t",
	status: "running",
	progress: { output: "", turns: 1, tokens: 1 },
	lastAdvanceAt,
	...over,
});

test("PeekWatcher surfaces a stalled leg only once, and re-arms after it recovers", () => {
	const w = new PeekWatcher();
	// advanced 10s ago, 45s window → healthy, nothing to surface
	assert.deepEqual(w.poll([runningRun(100_000)], 110_000, 45_000), []);
	// crossed the window → surfaced exactly once
	assert.deepEqual(w.poll([runningRun(100_000)], 146_000, 45_000).map((r) => r.id), ["run-1"]);
	// still stalled at the SAME advance point → not surfaced again (no re-nag every tick)
	assert.deepEqual(w.poll([runningRun(100_000)], 200_000, 45_000), []);
	// it advanced (lastAdvanceAt moved), so a fresh stall re-arms and re-alerts
	assert.deepEqual(w.poll([runningRun(210_000)], 215_000, 45_000), []); // fresh, not yet stalled
	assert.deepEqual(w.poll([runningRun(210_000)], 260_000, 45_000).map((r) => r.id), ["run-1"]);
});

test("PeekWatcher never surfaces a non-running leg and forgets legs that leave the list", () => {
	// A FRESH watcher must exclude a stalled-by-timestamp done/failed leg via the STATUS guard, not the
	// once-only suppression — so this dies if the status guard regresses (a settled run must never alert).
	assert.deepEqual(new PeekWatcher().poll([runningRun(0, { status: "done" })], 100_000, 45_000), [], "a never-reported done leg is not 'stalled'");
	assert.deepEqual(new PeekWatcher().poll([runningRun(0, { status: "failed" })], 100_000, 45_000), [], "a never-reported failed leg is not 'stalled'");

	const w = new PeekWatcher();
	assert.deepEqual(w.poll([runningRun(0)], 100_000, 45_000).map((r) => r.id), ["run-1"]); // stalled → surfaced
	assert.deepEqual(w.poll([runningRun(0, { status: "done" })], 200_000, 45_000), []); // done → never "stuck"
	assert.deepEqual(w.poll([], 300_000, 45_000), []); // gone → forgotten
	assert.deepEqual(w.poll([runningRun(0)], 400_000, 45_000).map((r) => r.id), ["run-1"]); // reappears stalled → re-alert
	w.reset();
	assert.deepEqual(w.poll([runningRun(0)], 500_000, 45_000).map((r) => r.id), ["run-1"]); // reset re-arms all
});

test("PeekWatcher's stall window is inclusive at the boundary and stallMs=0 disables it", () => {
	assert.deepEqual(new PeekWatcher().poll([runningRun(0)], 45_000, 45_000).map((r) => r.id), ["run-1"], "exactly at the threshold surfaces (>=)");
	assert.deepEqual(new PeekWatcher().poll([runningRun(0)], 44_999, 45_000), [], "one ms short does not");
	assert.deepEqual(new PeekWatcher().poll([runningRun(0)], 10_000_000, 0), [], "stallMs=0 disables the flag, even for an ancient leg");
});

test("PeekWatcher discriminates per-leg in a mixed batch (only the stalled one)", () => {
	const w = new PeekWatcher();
	const fresh = runningRun(100_000, { id: "run-1" });
	const stalled = runningRun(0, { id: "run-2" });
	assert.deepEqual(w.poll([fresh, stalled], 100_000, 45_000).map((r) => r.id), ["run-2"], "the healthy leg is never named in the alert");
});

test("buildPeekAlert renders only stalled legs, patience-first, and never the full heartbeat digest", () => {
	assert.equal(buildPeekAlert([], { now: 1_000 }), "", "no stalled legs ⇒ no wake");
	const out = buildPeekAlert([runningRun(1_000, { progress: { output: "", turns: 5, tokens: 1200 } })], { now: 1_000 + 92_000 });
	assert.match(out, /run-1 \(operator\)/);
	assert.match(out, /92s/);
	assert.match(out, /leave it/i, "patience-first framing");
	assert.match(out, /environment/i, "the ask-the-leg / don't-self-probe boundary");
	assert.match(out, /1 background leg may be stalled:/, "singular head");
	assert.doesNotMatch(out, /Async runs:/, "not the full on-demand digest");
	const two = buildPeekAlert([runningRun(0, { id: "run-2" }), runningRun(0, { id: "run-3" })], { now: 90_000 });
	assert.match(two, /2 background legs may be stalled:/, "plural head");
	assert.match(two, /run-2/);
	assert.match(two, /run-3/);
});

test("buildCheckIn frames the full digest as an occasional glance and keeps the stall markers", () => {
	// A leg stalled past the window must still read 'possibly stuck' in the routine check-in — this dies
	// if buildCheckIn stops forwarding {now, stallMs} into the digest (the off-track glance would go blind).
	const out = buildCheckIn([runningRun(0, { progress: { output: "x", turns: 3, tokens: 500 } })], { now: 90_000, stallMs: 90_000 });
	assert.match(out, /Async runs:/, "carries the full progress digest");
	assert.match(out, /possibly stuck/, "forwards the stall window so a wedge shows on the glance");
	assert.match(out, /Routine check-in/);
	assert.match(out, /off-track/);
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

test("forceSettle stops a still-running ghost (fires onComplete once, leaves the running set)", async () => {
	const tracker = new AsyncRunTracker();
	const completed: string[] = [];
	tracker.onComplete((r) => completed.push(r.id));
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	// A run whose hard-stop handle is gone but whose thunk never settles = the ghost the supervisor's
	// `stop` used to falsely report as "already finished".
	const id = tracker.launch({ agent: "a", task: "t" }, async () => {
		await gate;
		return { agent: "a", output: "late", usage: usage(), ok: true };
	});
	assert.equal(tracker.running().length, 1);
	assert.equal(tracker.forceSettle(id, "force-stopped"), true);
	assert.equal(tracker.peek(id)?.status, "stopped");
	assert.equal(tracker.peek(id)?.error, "force-stopped");
	assert.equal(tracker.running().length, 0, "the ghost leaves the running set");
	assert.deepEqual(completed, [id], "onComplete fires once for the forced settle");
	// The late natural resolution must NOT re-notify or overwrite the forced failure.
	release();
	await tick();
	assert.deepEqual(completed, [id], "the late natural result does not double-fire onComplete");
	assert.equal(tracker.peek(id)?.status, "stopped", "the late natural result does not overwrite the forced stop");
});

test("tracker classifies an engine abort result as stopped, not failed", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({
		agent: "a",
		output: "partial",
		usage: usage(),
		ok: false,
		error: "agent aborted",
		failureKind: "abort",
	}));
	await tick();
	assert.equal(tracker.peek(id)?.status, "stopped");
	assert.equal(tracker.peek(id)?.error, "agent aborted");
});

test("forceSettle is a no-op on unknown, already-settled, and re-forced runs", async () => {
	const tracker = new AsyncRunTracker();
	assert.equal(tracker.forceSettle("run-nope", "x"), false, "unknown id");
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({ agent: "a", output: "x", usage: usage(), ok: true }));
	await tick();
	assert.equal(tracker.peek(id)?.status, "done");
	assert.equal(tracker.forceSettle(id, "x"), false, "already settled naturally");
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const gid = tracker.launch({ agent: "a", task: "t" }, async () => {
		await gate;
		return { agent: "a", output: "x", usage: usage(), ok: true };
	});
	assert.equal(tracker.forceSettle(gid, "first"), true);
	assert.equal(tracker.forceSettle(gid, "second"), false, "a second force-settle is a no-op");
	assert.equal(tracker.peek(gid)?.error, "first", "the first forced error is kept");
	release();
	await tick();
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

test("buildPeekDigest compacts large token counts (164005 → 164k)", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "operator", task: "t", status: "running", progress: { output: "x", turns: 53, tokens: 164_005 } },
	]);
	assert.match(digest, /164k tok/, "tokens shown compact");
	assert.doesNotMatch(digest, /164005/, "not the raw count");
});

test("buildPeekDigest shows the canonical <label> · <model> name — the SAME name the agent-tree node uses — not the bare agent type", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "scout", task: "t", label: "atlas-static", model: "sonnet", status: "running", progress: { output: "", turns: 33, tokens: 381_000 } },
	]);
	assert.match(digest, /\[run-1\] atlas-static · sonnet — running/, "canonical name, with the run id kept as the steer/stop handle");
	assert.doesNotMatch(digest, /\bscout\b/, "the bare agent type is not shown once a label is carried");
});

test("buildPeekDigest falls back to the bare agent type when a run carries no label (back-compat)", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "scout", task: "t", status: "running", progress: { output: "", turns: 1, tokens: 5 } },
	]);
	assert.match(digest, /\[run-1\] scout — running/, "no label ⇒ falls back to the agent type");
});

test("buildPeekDigest omits the model suffix when a run has a label but no model", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "scout", task: "t", label: "atlas-static", status: "running", progress: { output: "", turns: 1, tokens: 5 } },
	]);
	assert.match(digest, /\[run-1\] atlas-static — running/);
	assert.doesNotMatch(digest, /atlas-static ·/, "no model ⇒ no dangling '· ' suffix");
});

test("buildCompletionReport gives an empty result a plain '(no output)' — never an empty fence shell", () => {
	const fence = (t: string) => `<F>${t}</F>`;
	const empty = buildCompletionReport(
		[{ id: "run-1", agent: "operator", task: "t", status: "done", progress: { output: "", turns: 1, tokens: 5 }, result: { agent: "operator", output: "   ", usage: usage(), ok: true } }],
		fence,
	);
	assert.match(empty, /run-1 \(operator\) done:\n\(no output\)/, "whitespace-only output ⇒ plain (no output)");
	assert.doesNotMatch(empty, /<F>/, "no fence is emitted around nothing");
	const real = buildCompletionReport(
		[{ id: "run-1", agent: "operator", task: "t", status: "done", progress: { output: "x", turns: 1, tokens: 5 }, result: { agent: "operator", output: "real result", usage: usage(), ok: true } }],
		fence,
	);
	assert.match(real, /<F>real result<\/F>/, "real output is still fenced");
});

test("the tracker resets the stall clock only when progress actually advances (injected clock)", async () => {
	// Stall detection needs a per-run 'last advanced' stamp: a worker looping without making
	// headway (identical snapshot) must NOT keep its clock alive, or it never reads as stuck.
	let clock = 100;
	const tracker = new AsyncRunTracker({ now: () => clock });
	let onProg!: (s: ProgressSnapshot) => void;
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const id = tracker.launch({ agent: "a", task: "t" }, async (onProgress) => {
		onProg = onProgress; // the thunk runs synchronously up to this await, so onProg is set now
		await gate;
		return { agent: "a", output: "done", usage: usage(), ok: true };
	});
	assert.equal(tracker.peek(id)?.lastAdvanceAt, 100, "stamped at launch");
	clock = 200;
	onProg({ output: "aa", turns: 1, tokens: 5 }); // output grew → real progress
	assert.equal(tracker.peek(id)?.lastAdvanceAt, 200, "an advance resets the stall clock");
	clock = 300;
	onProg({ output: "aa", turns: 1, tokens: 5 }); // identical snapshot → no headway
	assert.equal(tracker.peek(id)?.lastAdvanceAt, 200, "unchanged progress does NOT reset the stall clock");
	release();
	await tick();
});

test("buildPeekDigest flags a running run stalled past stallMs (fresh runs are not flagged)", () => {
	const now = 1_000_000;
	const fresh: AsyncRun = { id: "run-1", agent: "a", task: "t", status: "running", progress: { output: "", turns: 1, tokens: 5 }, lastAdvanceAt: now - 5_000 };
	const stuck: AsyncRun = { id: "run-2", agent: "b", task: "t", status: "running", progress: { output: "", turns: 1, tokens: 5 }, lastAdvanceAt: now - 90_000 };
	const digest = buildPeekDigest([fresh, stuck], { now, stallMs: 45_000 });
	const lines = digest.split("\n");
	const l1 = lines.find((l) => l.includes("run-1")) ?? "";
	const l2 = lines.find((l) => l.includes("run-2")) ?? "";
	assert.doesNotMatch(l1, /stuck/, "a run that advanced recently is not flagged");
	assert.match(l2, /possibly stuck/, "a run stalled past the window is flagged");
});

test("buildPeekDigest without stall opts flags nothing (back-compat)", () => {
	const running: AsyncRun = { id: "run-1", agent: "a", task: "t", status: "running", progress: { output: "", turns: 1, tokens: 5 }, lastAdvanceAt: 0 };
	assert.doesNotMatch(buildPeekDigest([running]), /stuck/, "no stall window supplied ⇒ no flagging");
});

test("buildPeekDigest shows a failed run's ERROR, not its (empty) output", () => {
	// A failed engine run still carries a result (ok:false, output "") — the digest must
	// surface WHY it failed, or /peek shows a bare "failed:" with nothing after it.
	const failedWithResult: AsyncRun = {
		id: "run-9",
		agent: "operator",
		task: "t",
		status: "failed",
		progress: { output: "", turns: 1, tokens: 1 },
		result: { agent: "operator", output: "", usage: usage(), ok: false, error: "model not found" },
		error: "model not found",
	};
	const digest = buildPeekDigest([failedWithResult]);
	assert.match(digest, /run-9.*failed: model not found/);
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

test("buildCompletionReport reports an ALL-FAILED batch too — the supervisor must know", () => {
	// Failures are information, not noise: hiding them would leave the supervisor
	// waiting forever for a result that never comes. Retry loops are prevented at
	// runtime by the DelegationLedger, not by suppressing the report.
	const allFailed = buildCompletionReport([failedRun("run-1", "operator", "boom")], (t) => t);
	assert.match(allFailed, /1 async run settled — 0 done, 1 failed/);
	assert.match(allFailed, /run-1 \(operator\): boom/);
	assert.match(allFailed, /Do not re-issue the same failing delegation repeatedly/);
	const allDone = buildCompletionReport([doneRun("run-1", "scout", "ok")], (t) => t);
	assert.doesNotMatch(allDone, /Do not re-issue/);
	assert.match(allDone, /1 async run settled — 1 done, 0 failed/); // singular, no plural "s"
});

test("buildCompletionReport includes anti-loop guidance on mixed batches (some done, some failed)", () => {
	const mixed = buildCompletionReport([doneRun("run-1", "scout", "ok"), failedRun("run-2", "operator", "boom")], (t) => t);
	assert.match(mixed, /Do not re-issue the same failing delegation repeatedly/);
	assert.match(mixed, /retry ONCE with a different model/);
});

test("buildCompletionReport reports a stopped leg separately, salvages output, and does not suggest retry", () => {
	const fence = (t: string) => `<F>${t}</F>`;
	// A hard-stopped research leg with real accumulated findings (its last progress snapshot).
	const aborted: AsyncRun = { id: "run-3", agent: "research", task: "t", status: "stopped", progress: { output: "found: 0x4016b3 read no bounds check", turns: 32, tokens: 693_000 }, error: "agent aborted" };
	const report = buildCompletionReport([aborted], fence);
	assert.match(report, /0 done, 0 failed, 1 stopped/, "the stop is not counted as a failure");
	assert.match(report, /run-3 \(research\): agent aborted/, "the stop reason is still reported");
	assert.match(report, /partial output before it was stopped/, "the salvage block is labelled as a stop");
	assert.match(report, /<F>found: 0x4016b3 read no bounds check<\/F>/, "the partial content is fenced + recoverable");
	assert.doesNotMatch(report, /retry ONCE|Do not re-issue/, "an intentional stop carries no failure retry guidance");
	// No salvage BLOCK when there is genuinely nothing to salvage (the guidance line mentions
	// "partial output" regardless, so match the block's own `↩ … before it …` marker, not the phrase).
	const empty = buildCompletionReport([failedRun("run-4", "scout", "no model")], fence);
	assert.doesNotMatch(empty, /↩ .*partial output before it/, "no empty salvage block for a leg that produced nothing");
});

test("buildCompletionReport uses the canonical label/model and bounds salvaged partial output", () => {
	const partial = `${"h".repeat(20_000)}TAIL-SENTINEL`;
	const failed: AsyncRun = {
		id: "run-9",
		agent: "operator",
		label: "atlas-static",
		model: "sonnet",
		task: "t",
		status: "stopped",
		progress: { output: partial, turns: 164, tokens: 888_000 },
		error: "agent aborted",
	};
	const report = buildCompletionReport([failed], (t) => `<F>${t}</F>`);
	assert.match(report, /run-9 \(atlas-static · sonnet\): agent aborted/, "stop uses the tree's canonical identity");
	assert.match(report, /partial output truncated; \d+ characters omitted/, "oversized recovery text carries an explicit marker");
	assert.match(report, /TAIL-SENTINEL/, "the useful tail is retained");
	assert.doesNotMatch(report, /h{12001}/, "the full oversized payload is not injected into the supervisor context");
});

test("tracker.waitFor resolves once every listed run settles (a join on async runs)", async () => {
	const tracker = new AsyncRunTracker();
	let releaseA: () => void = () => {};
	let releaseB: () => void = () => {};
	const a = tracker.launch({ agent: "a", task: "t" }, async () => {
		await new Promise<void>((r) => {
			releaseA = r;
		});
		return { agent: "a", output: "A", usage: usage(), ok: true };
	});
	const b = tracker.launch({ agent: "b", task: "t" }, async () => {
		await new Promise<void>((r) => {
			releaseB = r;
		});
		return { agent: "b", output: "B", usage: usage(), ok: true };
	});
	const wait = tracker.waitFor([a, b], 5_000);
	releaseA();
	releaseB();
	const runs = await wait;
	assert.deepEqual(runs.map((r) => r.status).sort(), ["done", "done"]);
	assert.deepEqual(runs.map((r) => r.result?.output).sort(), ["A", "B"]);
});

test("tracker.waitFor resolves with CURRENT states on timeout (never rejects, never hangs)", async () => {
	const tracker = new AsyncRunTracker();
	let release: () => void = () => {};
	const id = tracker.launch({ agent: "slow", task: "t" }, async () => {
		await new Promise<void>((r) => {
			release = r;
		});
		return { agent: "slow", output: "late", usage: usage(), ok: true };
	});
	const runs = await tracker.waitFor([id], 20);
	assert.equal(runs[0]?.status, "running", "the unsettled run is reported as still running");
	release(); // clean up
	await tick();
});

test("tracker.waitFor with already-settled and unknown ids resolves immediately", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({ agent: "a", output: "x", usage: usage(), ok: true }));
	await tick();
	const runs = await tracker.waitFor([id, "run-ghost"], 1_000);
	assert.equal(runs.length, 1, "unknown ids are ignored");
	assert.equal(runs[0]?.status, "done");
});

test("onComplete returns an unsubscribe (waitFor never leaks listeners)", async () => {
	const tracker = new AsyncRunTracker();
	let calls = 0;
	const off = tracker.onComplete(() => calls++);
	tracker.launch({ agent: "a", task: "t" }, async () => ({ agent: "a", output: "x", usage: usage(), ok: true }));
	await tick();
	off();
	tracker.launch({ agent: "b", task: "t" }, async () => ({ agent: "b", output: "y", usage: usage(), ok: true }));
	await tick();
	assert.equal(calls, 1, "no callbacks after unsubscribe");
});

test("IdleCoalescingNotifier.discard drops buffered items (results already collected via wait)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => { sent.push(m); } });
	n.notify("keep");
	n.notify("collected");
	n.discard((x) => x === "collected");
	clock.tick();
	assert.deepEqual(sent, ["keep"], "the discarded item was not re-delivered");
});

test("IdleCoalescingNotifier.peekPending exposes buffered-but-undelivered items (settle→deliver gap)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	// isIdle:false → the notifier never flushes, so items stay buffered (the gap `intercom wait` hit).
	const n = makeStrNotifier(clock, { isIdle: () => false, deliver: (m) => { sent.push(m); } });
	n.notify("a");
	n.notify("b");
	clock.tick();
	assert.deepEqual(n.peekPending(), ["a", "b"], "buffered items are visible before delivery");
	assert.deepEqual(sent, [], "nothing delivered while busy");
	n.discard((x) => x === "a");
	assert.deepEqual(n.peekPending(), ["b"], "discard removes from the pending view too");
});

test("dedupeRunsById keeps the first occurrence per id, order preserved", () => {
	const out = dedupeRunsById([doneRun("run-1", "scout", "A"), doneRun("run-2", "op", "B"), doneRun("run-1", "scout", "A2")]);
	assert.deepEqual(out.map((r) => r.id), ["run-1", "run-2"]);
	assert.equal(out[0]?.result?.output, "A", "the first run-1 wins");
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
	deps: { isIdle: () => boolean; hasPending?: () => boolean; deliver: (m: string) => void | Promise<void> },
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
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => { sent.push(m); } });
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
	const n = makeStrNotifier(clock, { isIdle: () => idle, deliver: (m) => { sent.push(m); } });
	n.notify("q");
	clock.tick(); // busy → re-arms, delivers nothing
	assert.equal(sent.length, 0);
	assert.equal(clock.armed(), 1, "it keeps a retry armed while busy");
	idle = true;
	clock.tick();
	assert.deepEqual(sent, ["q"], "delivered once the supervisor goes idle");
});

test("IdleCoalescingNotifier does not livelock on an orphaned host queue once the supervisor is idle", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, hasPending: () => true, deliver: (m) => { sent.push(m); } });
	n.notify("q");
	clock.tick();
	assert.deepEqual(sent, ["q"], "idle delivery starts the clean turn that can drain stale host follow-ups");
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

test("IdleCoalescingNotifier requeues and retries an asynchronous delivery rejection", async () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let attempts = 0;
	const n = makeStrNotifier(clock, {
		isIdle: () => true,
		deliver: async (m) => {
			attempts += 1;
			await Promise.resolve();
			if (attempts === 1) throw new Error("late host rejection");
			sent.push(m);
		},
	});
	n.notify("q");
	clock.tick();
	await n.flushIfIdle();
	assert.deepEqual(n.peekPending(), ["q"], "rejected in-flight batch is restored");
	assert.equal(clock.armed(), 1, "async rejection leaves a retry armed");
	clock.tick();
	await n.flushIfIdle();
	assert.deepEqual(sent, ["q"], "the restored batch is eventually delivered once");
});

test("IdleCoalescingNotifier kick flushes immediately on an idle transition", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	let idle = false;
	const n = makeStrNotifier(clock, { isIdle: () => idle, deliver: (m) => { sent.push(m); } });
	n.notify("q");
	clock.tick();
	assert.equal(clock.armed(), 1, "busy polling left a fallback retry");
	idle = true;
	n.kick();
	assert.deepEqual(sent, ["q"], "agent_settled-style kick does not wait for the retry cadence");
	assert.equal(clock.armed(), 0, "the obsolete retry timer was cancelled");
});

test("IdleCoalescingNotifier re-refs its timer while a delivery is pending", () => {
	let referenced = false;
	const handle = { ref: () => { referenced = true; } };
	const n = new IdleCoalescingNotifier<string>({
		isIdle: () => false,
		deliver: () => {},
		render: (items) => items.join(","),
		setTimer: () => handle,
		clearTimer: () => {},
	});
	n.notify("q");
	assert.equal(referenced, true, "an outstanding delivery keeps the host event loop alive");
	n.cancel();
});

test("IdleCoalescingNotifier.cancel() drops the armed flush (reload hygiene)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => { sent.push(m); } });
	n.notify("q");
	n.cancel();
	assert.equal(clock.armed(), 0, "the timer is cleared");
	clock.tick();
	assert.equal(sent.length, 0, "nothing is delivered after cancel");
});

test("IdleCoalescingNotifier.cancel() also drops buffered items (no leak across sessions)", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = makeStrNotifier(clock, { isIdle: () => true, deliver: (m) => { sent.push(m); } });
	n.notify("stale"); // buffered by the session being torn down
	n.cancel(); // reload/dispose hygiene: the instance is reused for the next session
	n.notify("fresh"); // a new item on the reused notifier
	clock.tick();
	assert.deepEqual(sent, ["fresh"], "a pre-cancel item must never ride along on the next delivery");
});

test("IdleCoalescingNotifier renders settled runs via buildCompletionReport", () => {
	const clock = fakeClock();
	const sent: string[] = [];
	const n = new IdleCoalescingNotifier<AsyncRun>({
		isIdle: () => true,
		hasPending: () => false,
		deliver: (m) => { sent.push(m); },
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

test("IdleCoalescingNotifier honours minIntervalMs and holds capped items until reset (R6)", () => {
	const clock = fakeClock();
	const delivered: string[] = [];
	let now = 0;
	const n = new IdleCoalescingNotifier<string>({
		isIdle: () => true, hasPending: () => false,
		deliver: (m) => { delivered.push(m); }, render: (items) => items.join(","),
		setTimer: clock.setTimer, clearTimer: clock.clearTimer,
		debounceMs: 1, minIntervalMs: 100, maxDeliveries: 2, now: () => now,
	});
	n.notify("a"); clock.tick(); assert.deepEqual(delivered, ["a"], "first delivers");
	now = 50; n.notify("b"); clock.tick(); assert.deepEqual(delivered, ["a"], "within min-interval ⇒ held");
	now = 150; clock.tick(); assert.deepEqual(delivered, ["a", "b"], "after min-interval ⇒ delivered");
	now = 300; n.notify("c"); clock.tick(); assert.deepEqual(delivered, ["a", "b"], "hit maxDeliveries ⇒ delayed");
	assert.deepEqual(n.peekPending(), ["c"], "the ceiling never drops buffered work");
	assert.equal(clock.armed(), 1, "a capped batch retains a liveness retry");
	n.resetDeliveries();
	assert.deepEqual(delivered, ["a", "b", "c"], "reset reopens the gate and flushes immediately");
	assert.deepEqual(n.peekPending(), []);
});

// renderCompletion — the completion report PLUS the premature-surrender counterweight, shared by
// the background completion notifier AND the `intercom wait` join so a blocked leg gets the same
// note however it is collected (the sync tool_result hook never sees a background run).

test("renderCompletion appends the surrender note when a DONE leg reports a blocked marker", () => {
	const runs = [doneRun("run-1", "operator", "tried A, B. [BLOCKED: need domain creds]")];
	const out = renderCompletion(runs, (t) => t, surrenderScan);
	assert.match(out, /1 async run settled — 1 done, 0 failed/, "the base completion report is intact");
	assert.match(out, /recovery pass/i, "the persistence note rides the completion report");
});

test("renderCompletion leaves a clean batch untouched — identical to the plain report", () => {
	const runs = [doneRun("run-1", "scout", "found it — file:line list attached")];
	const out = renderCompletion(runs, (t) => t, surrenderScan);
	assert.doesNotMatch(out, /recovery pass/i);
	assert.equal(out, buildCompletionReport(runs, (t) => t), "no surrender ⇒ byte-identical to buildCompletionReport");
});

test("renderCompletion scans DONE legs only — a failed leg's marker is not a banked surrender", () => {
	// A failed run is already surfaced as a failure by buildCompletionReport; the 'don't bank it'
	// note is for a leg that came back DONE while quietly giving up. Guard and append agree: done-only.
	const runs = [failedRun("run-1", "operator", "[BLOCKED: dead end]")];
	const out = renderCompletion(runs, (t) => t, surrenderScan);
	assert.doesNotMatch(out, /recovery pass/i, "a failed leg does not trigger the surrender note");
	assert.match(out, /0 done, 1 failed/, "still reported as a failure");
});

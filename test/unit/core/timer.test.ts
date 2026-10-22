import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRemaining, renderTimerFire, TimerScheduler, type TimerEntry } from "../../../src/core/timer.ts";

/** A controllable clock + timer queue so scheduling is deterministic (no real wall clock). */
function harness(startNow = 1_000_000) {
	let now = startNow;
	let nextHandle = 0;
	const queue = new Map<number, { fn: () => void; fireAt: number }>();
	const fired: TimerEntry[] = [];
	const scheduler = new TimerScheduler({
		now: () => now,
		setTimer: (fn, ms) => {
			const h = nextHandle++;
			queue.set(h, { fn, fireAt: now + ms });
			return h;
		},
		clearTimer: (h) => queue.delete(h as number),
		onFire: (e) => fired.push(e),
	});
	return {
		scheduler,
		fired,
		setNow: (n: number) => {
			now = n;
		},
		advance: (ms: number) => {
			now += ms;
			// fire every scheduled callback whose time has arrived, in time order
			for (const [h, t] of [...queue.entries()].sort((a, b) => a[1].fireAt - b[1].fireAt)) {
				if (t.fireAt <= now) {
					queue.delete(h);
					t.fn();
				}
			}
		},
		pending: () => queue.size,
	};
}

test("arm with delayMs schedules and fires at expiry", () => {
	const h = harness();
	const r = h.scheduler.arm({ label: "release", message: "spawn now", delayMs: 60_000 });
	assert.ok(r.ok && r.entry);
	assert.equal(r.entry?.fireAtEpochMs, 1_060_000);
	assert.equal(h.fired.length, 0, "not fired before time");
	h.advance(60_000);
	assert.equal(h.fired.length, 1, "fired at expiry");
	assert.equal(h.fired[0]?.message, "spawn now");
	assert.equal(h.fired[0]?.observedAtEpochMs, 1_060_000, "the fire records the scheduler-observed wall clock");
	assert.equal(h.scheduler.size, 0, "removed from armed set after firing");
});

test("the scheduler exposes its injected current clock for fresh time reads", () => {
	const h = harness();
	assert.equal(h.scheduler.now(), 1_000_000);
});

test("arm with atEpochMs fires at the absolute time", () => {
	const h = harness();
	const r = h.scheduler.arm({ message: "go", atEpochMs: 1_000_000 + 90_000 });
	assert.ok(r.ok);
	assert.equal(r.entry?.label, r.entry?.id, "label defaults to the id");
	h.advance(89_000);
	assert.equal(h.fired.length, 0);
	h.advance(1_000);
	assert.equal(h.fired.length, 1);
});

test("rejects when neither or both of delayMs/atEpochMs are given", () => {
	const h = harness();
	assert.equal(h.scheduler.arm({ message: "x" }).ok, false);
	assert.equal(h.scheduler.arm({ message: "x", delayMs: 5_000, atEpochMs: 2_000_000 }).ok, false);
});

test("rejects an empty message", () => {
	const h = harness();
	assert.equal(h.scheduler.arm({ message: "   ", delayMs: 5_000 }).ok, false);
});

test("rejects a past absolute time and a sub-minimum delay", () => {
	const h = harness();
	assert.equal(h.scheduler.arm({ message: "x", atEpochMs: 500_000 }).ok, false, "past time rejected");
	assert.equal(h.scheduler.arm({ message: "x", delayMs: 100 }).ok, false, "below min delay rejected");
});

test("rejects an invalid injected clock instead of arming an unusable timer", () => {
	const h = harness(Number.NaN);
	const result = h.scheduler.arm({ message: "x", atEpochMs: 2_000_000 });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /clock is not a finite number/);
	assert.equal(h.scheduler.size, 0);
});

test("rejects a delay beyond the max", () => {
	const h = harness();
	assert.equal(h.scheduler.arm({ message: "x", delayMs: 25 * 60 * 60 * 1000 }).ok, false);
});

test("cancel prevents firing; unknown id returns false", () => {
	const h = harness();
	const r = h.scheduler.arm({ message: "x", delayMs: 60_000 });
	const id = r.entry?.id as string;
	assert.equal(h.scheduler.cancel(id), true);
	assert.equal(h.scheduler.cancel(id), false, "already cancelled");
	assert.equal(h.scheduler.cancel("timer-999"), false, "unknown id");
	h.advance(60_000);
	assert.equal(h.fired.length, 0, "a cancelled timer never fires");
});

test("list is sorted soonest-first with live remaining time; cancelAll clears all", () => {
	const h = harness();
	h.scheduler.arm({ label: "late", message: "b", delayMs: 120_000 });
	h.scheduler.arm({ label: "soon", message: "a", delayMs: 30_000 });
	const list = h.scheduler.list();
	assert.deepEqual(
		list.map((t) => t.label),
		["soon", "late"],
	);
	assert.equal(list[0]?.remainingMs, 30_000);
	assert.equal(h.scheduler.size, 2);
	h.scheduler.cancelAll();
	assert.equal(h.scheduler.size, 0);
	assert.equal(h.pending(), 0, "underlying timers cleared too");
});

test("ids are unique and monotonic", () => {
	const h = harness();
	const a = h.scheduler.arm({ message: "x", delayMs: 5_000 }).entry?.id;
	const b = h.scheduler.arm({ message: "y", delayMs: 5_000 }).entry?.id;
	assert.notEqual(a, b);
});

test("the armed-timer count is bounded — a looping supervisor cannot pin unbounded OS timers", () => {
	const h = harness();
	for (let i = 0; i < 32; i++) {
		const r = h.scheduler.arm({ message: `wake ${i}`, delayMs: 60_000 });
		assert.ok(r.ok, `timer ${i} armed`);
	}
	const over = h.scheduler.arm({ message: "one too many", delayMs: 60_000 });
	assert.equal(over.ok, false);
	assert.match(over.error ?? "", /maximum 32/);
	// A fired timer frees its slot.
	h.advance(60_000);
	assert.equal(h.fired.length, 32);
	const again = h.scheduler.arm({ message: "after the batch fired", delayMs: 60_000 });
	assert.ok(again.ok, "slots free up after firing");
});

test("the follow-up message is length-bounded — it is re-injected into context at fire time", () => {
	const h = harness();
	const r = h.scheduler.arm({ message: "x".repeat(4_001), delayMs: 60_000 });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /maximum 4000/);
	assert.ok(h.scheduler.arm({ message: "x".repeat(4_000), delayMs: 60_000 }).ok, "at the cap is fine");
});

test("renderTimerFire batches multiple fires into one wake message", () => {
	const entries: TimerEntry[] = [
		{ id: "timer-1", label: "release", fireAtEpochMs: 0, armedAtEpochMs: 0, observedAtEpochMs: 1_500, message: "check status" },
		{ id: "timer-2", label: "recheck", fireAtEpochMs: 0, armedAtEpochMs: 0, observedAtEpochMs: 1_700, message: "summarize changes" },
	];
	const out = renderTimerFire(entries);
	assert.match(out, /2 timers fired/);
	assert.match(out, /due 1970-01-01T00:00:00\.000Z; observed 1970-01-01T00:00:01\.500Z/);
	assert.match(out, /check status/);
	assert.match(out, /summarize changes/);
	assert.equal(renderTimerFire([]), "");
});

test("formatRemaining renders h/m/s compactly", () => {
	assert.equal(formatRemaining(45 * 1000), "45s");
	assert.equal(formatRemaining((3 * 60 + 5) * 1000), "3m 05s");
	assert.equal(formatRemaining((60 * 60 + 3 * 60) * 1000), "1h 03m");
	assert.equal(formatRemaining(-500), "0s");
});

// ── arm/cancel hooks: the seam the agent tree's timer rows hang on ──────────────────────────────

test("onArmed sees every admitted alarm and onCancelled every explicit cancel, never a fire", () => {
	let now = 1_000_000;
	const queue = new Map<number, { fn: () => void; fireAt: number }>();
	let nextHandle = 0;
	const armed: string[] = [];
	const cancelled: string[] = [];
	const fired: string[] = [];
	const scheduler = new TimerScheduler({
		now: () => now,
		setTimer: (fn, ms) => {
			const h = nextHandle++;
			queue.set(h, { fn, fireAt: now + ms });
			return h;
		},
		clearTimer: (h) => queue.delete(h as number),
		onFire: (e) => fired.push(e.id),
		onArmed: (e) => armed.push(`${e.id}:${e.label}:${e.fireAtEpochMs}`),
		onCancelled: (e) => cancelled.push(e.id),
	});
	assert.equal(scheduler.arm({ message: "x", delayMs: 500 }).ok, false, "a rejected arm is not announced");
	assert.deepEqual(armed, []);
	const a = scheduler.arm({ label: "status review", message: "check", delayMs: 60_000 });
	const b = scheduler.arm({ message: "go", delayMs: 120_000 });
	const c = scheduler.arm({ message: "later", delayMs: 180_000 });
	assert.ok(a.ok && b.ok && c.ok);
	assert.deepEqual(armed, ["timer-1:status review:1060000", "timer-2:timer-2:1120000", "timer-3:timer-3:1180000"]);

	assert.equal(scheduler.cancel("timer-2"), true);
	assert.equal(scheduler.cancel("timer-2"), false, "a second cancel is unknown and announces nothing");
	assert.deepEqual(cancelled, ["timer-2"]);

	now += 60_000;
	for (const [h, t] of [...queue.entries()]) if (t.fireAt <= now) { queue.delete(h); t.fn(); }
	assert.deepEqual(fired, ["timer-1"]);
	assert.deepEqual(cancelled, ["timer-2"], "a fire is reported through onFire only");

	scheduler.cancelAll();
	assert.deepEqual(cancelled, ["timer-2", "timer-3"], "cancelAll reports each alarm it dropped, once");
	assert.equal(scheduler.size, 0);
	scheduler.cancelAll();
	assert.deepEqual(cancelled, ["timer-2", "timer-3"], "an empty cancelAll announces nothing");
});

/** A scheduler wired to a fake clock, announcing admitted alarms through `onArmed`. */
function labelHarness(maxLabelChars?: number) {
	const armed: TimerEntry[] = [];
	const scheduler = new TimerScheduler({
		now: () => 1_000_000,
		setTimer: () => 0,
		clearTimer: () => {},
		onFire: () => {},
		onArmed: (e) => armed.push(e),
		...(maxLabelChars === undefined ? {} : { maxLabelChars }),
	});
	return { scheduler, armed };
}

test("an over-long label is clipped to 120 chars ending in an ellipsis, never rejected", () => {
	const { scheduler, armed } = labelHarness();
	const r = scheduler.arm({ label: "x".repeat(500), message: "check", delayMs: 60_000 });
	assert.ok(r.ok && r.entry, "a verbose label never costs the alarm");
	assert.equal(r.entry.label.length, 120);
	assert.ok(r.entry.label.endsWith("…"));
	assert.equal(r.entry.label, `${"x".repeat(119)}…`);
	assert.equal(scheduler.list()[0]?.label, r.entry.label, "list carries the bounded label");
	assert.equal(armed[0]?.label, r.entry.label, "onArmed receives the bounded label");
	const text = renderTimerFire([r.entry]);
	assert.ok(text.includes(r.entry.label), "the fire message carries the bounded label");
	assert.equal(text.includes("x".repeat(120)), false, "and nothing of the unbounded original");
});

test("a label of exactly the bound is kept verbatim", () => {
	const { scheduler, armed } = labelHarness();
	const label = "y".repeat(120);
	const r = scheduler.arm({ label, message: "check", delayMs: 60_000 });
	assert.ok(r.ok && r.entry);
	assert.equal(r.entry.label, label);
	assert.equal(scheduler.list()[0]?.label, label);
	assert.equal(armed[0]?.label, label);
});

test("the label is trimmed before it is measured, and a blank one still falls back to the id", () => {
	const { scheduler } = labelHarness();
	const padded = scheduler.arm({ label: `   ${"z".repeat(120)}   `, message: "check", delayMs: 60_000 });
	assert.ok(padded.ok && padded.entry);
	assert.equal(padded.entry.label, "z".repeat(120), "surrounding whitespace is not counted against the bound");
	const blank = scheduler.arm({ label: "   ", message: "check", delayMs: 60_000 });
	assert.ok(blank.ok && blank.entry);
	assert.equal(blank.entry.label, blank.entry.id);
});

test("maxLabelChars overrides the bound", () => {
	const { scheduler } = labelHarness(10);
	const r = scheduler.arm({ label: "abcdefghijklmnop", message: "check", delayMs: 60_000 });
	assert.ok(r.ok && r.entry);
	assert.equal(r.entry.label, "abcdefghi…");
	assert.equal(r.entry.label.length, 10);
});

test("clipping never splits a surrogate pair", () => {
	const { scheduler } = labelHarness(10);
	// "a".repeat(8) + 😀 (2 code units) + tail: the cut would land between the pair's halves.
	const r = scheduler.arm({ label: `${"a".repeat(8)}😀tail`, message: "check", delayMs: 60_000 });
	assert.ok(r.ok && r.entry);
	assert.ok(r.entry.label.length <= 10);
	assert.ok(r.entry.label.endsWith("…"));
	assert.equal(r.entry.label, `${"a".repeat(8)}…`, "the dangling high surrogate is dropped, not left unpaired");
	assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.entry.label), false);
});

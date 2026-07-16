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
	assert.equal(h.scheduler.size, 0, "removed from armed set after firing");
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

test("renderTimerFire batches multiple fires into one wake message", () => {
	const entries: TimerEntry[] = [
		{ id: "timer-1", label: "release", fireAtEpochMs: 0, armedAtEpochMs: 0, message: "spawn Paperwork" },
		{ id: "timer-2", label: "recheck", fireAtEpochMs: 0, armedAtEpochMs: 0, message: "re-run nmap" },
	];
	const out = renderTimerFire(entries);
	assert.match(out, /2 timers fired/);
	assert.match(out, /spawn Paperwork/);
	assert.match(out, /re-run nmap/);
	assert.equal(renderTimerFire([]), "");
});

test("formatRemaining renders h/m/s compactly", () => {
	assert.equal(formatRemaining(45 * 1000), "45s");
	assert.equal(formatRemaining((3 * 60 + 5) * 1000), "3m 05s");
	assert.equal(formatRemaining((60 * 60 + 3 * 60) * 1000), "1h 03m");
	assert.equal(formatRemaining(-500), "0s");
});

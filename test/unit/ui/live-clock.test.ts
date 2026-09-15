import { test } from "node:test";
import assert from "node:assert/strict";

import { LiveClock } from "../../../src/ui/live-clock.ts";

test("LiveClock ticks only while live, then stops itself", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let live = true;
	let ticks = 0;
	const clock = new LiveClock({ intervalMs: 1_000, isLive: () => live, onTick: () => ticks++ });
	clock.start();
	clock.start(); // idempotent: one interval
	assert.equal(clock.running, true);
	t.mock.timers.tick(3_000);
	assert.equal(ticks, 3);
	live = false;
	t.mock.timers.tick(1_000);
	assert.equal(ticks, 3, "no tick once not live");
	assert.equal(clock.running, false, "stops itself when nothing is live");
	t.mock.timers.tick(5_000);
	assert.equal(ticks, 3);
});

test("LiveClock.start is a no-op when nothing is live and stop is safe to repeat", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const clock = new LiveClock({ intervalMs: 1_000, isLive: () => false, onTick: () => assert.fail("must not tick") });
	clock.start();
	assert.equal(clock.running, false);
	clock.stop();
	clock.stop();
});

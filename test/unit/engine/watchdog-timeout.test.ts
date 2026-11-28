import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TIMER_DELAY_MS } from "../../../src/core/config.ts";
import { armWatchdogTimeout } from "../../../src/engine/watchdog-timeout.ts";

test("a long watchdog preserves its deadline when the first timer segment runs late", ({ mock }) => {
	let now = 0;
	let fired = 0;
	mock.method(performance, "now", () => now);
	mock.timers.enable({ apis: ["setTimeout"] });
	armWatchdogTimeout(() => { fired += 1; }, MAX_TIMER_DELAY_MS + 1000);
	const advance = (delayMs: number): void => {
		now += delayMs;
		mock.timers.tick(delayMs);
	};

	advance(MAX_TIMER_DELAY_MS + 250);
	assert.equal(fired, 0);
	advance(749);
	assert.equal(fired, 0);
	advance(1);
	assert.equal(fired, 1);
	advance(1000);
	assert.equal(fired, 1);
});

test("disarming a long watchdog cancels its current timer segment", ({ mock }) => {
	let now = 0;
	let fired = false;
	mock.method(performance, "now", () => now);
	mock.timers.enable({ apis: ["setTimeout"] });
	const disarm = armWatchdogTimeout(() => { fired = true; }, MAX_TIMER_DELAY_MS + 1000);
	now += MAX_TIMER_DELAY_MS;
	mock.timers.tick(MAX_TIMER_DELAY_MS);
	assert.equal(fired, false);
	disarm();
	disarm();
	now += 1000;
	mock.timers.tick(1000);
	assert.equal(fired, false);
});

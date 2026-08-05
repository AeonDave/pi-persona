import { test } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency, Semaphore } from "../../../src/orchestration/parallel.ts";

test("mapWithConcurrency preserves input order regardless of completion order", async () => {
	const r = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
		await new Promise((res) => setTimeout(res, (5 - n) * 5));
		return n * 10;
	});
	assert.deepEqual(r, [10, 20, 30, 40]);
});

test("mapWithConcurrency never exceeds the concurrency limit", async () => {
	let inFlight = 0;
	let max = 0;
	await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
		inFlight++;
		max = Math.max(max, inFlight);
		await new Promise((res) => setTimeout(res, 10));
		inFlight--;
		return 0;
	});
	assert.ok(max <= 2, `max in-flight ${max} should be <= 2`);
});

test("mapWithConcurrency handles empty input and clamps concurrency to >= 1", async () => {
	assert.deepEqual(await mapWithConcurrency<number, number>([], 4, async (n) => n), []);
	assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (n) => n), [1, 2]);
});

test("mapWithConcurrency stops pulling new items once a callback rejects", async () => {
	const started: number[] = [];
	await assert.rejects(
		() =>
			mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (_item, i) => {
				started.push(i);
				await new Promise((res) => setTimeout(res, i === 1 ? 1 : 30));
				if (i === 1) throw new Error("boom");
				return i;
			}),
		/boom/,
	);
	// The queue is only observable AFTER the surviving worker's current item would settle.
	await new Promise((res) => setTimeout(res, 100));
	assert.deepEqual(started, [0, 1], "the surviving worker must not launch the queued items");
});

test("mapWithConcurrency surfaces the first error at once, without waiting on a slow in-flight sibling", async () => {
	const started: number[] = [];
	let slowFinished = false;
	const t0 = Date.now();
	await assert.rejects(
		() =>
			mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (_item, i) => {
				started.push(i);
				if (i === 0) throw new Error("run exceeded token budget");
				await new Promise((res) => setTimeout(res, 400));
				slowFinished = true;
				return i;
			}),
		/token budget/,
	);
	const elapsed = Date.now() - t0;
	// A run-fatal breach must reach the operator now — not after the slowest healthy leg, which
	// for a delegated agent is minutes.
	assert.ok(elapsed < 300, `the batch rejected after ${elapsed}ms — it waited on the in-flight sibling`);
	assert.equal(slowFinished, false, "the sibling was still in flight when the error surfaced");
	// Containment is unchanged: the abandoned worker still pulls nothing new.
	await new Promise((res) => setTimeout(res, 500));
	assert.deepEqual(started, [0, 1], "no further item was launched after the failure");
});

test("Semaphore.with bounds concurrency across independently-launched jobs", async () => {
	const sem = new Semaphore(2);
	let inFlight = 0;
	let max = 0;
	const job = () =>
		sem.with(async () => {
			inFlight++;
			max = Math.max(max, inFlight);
			await new Promise((res) => setTimeout(res, 10));
			inFlight--;
		});
	// Launched independently (not as one batch) — the async-delegate shape.
	await Promise.all([job(), job(), job(), job(), job(), job()]);
	assert.ok(max <= 2, `max in-flight ${max} should be <= 2`);
});

test("Semaphore releases the slot when a job throws (no starvation)", async () => {
	const sem = new Semaphore(1);
	await assert.rejects(() => sem.with(async () => Promise.reject(new Error("boom"))), /boom/);
	let ran = false;
	await sem.with(async () => {
		ran = true;
	});
	assert.equal(ran, true, "the slot freed by the failed job is reusable");
});

test("Semaphore clamps to at least one slot", async () => {
	const sem = new Semaphore(0);
	let ran = false;
	await sem.with(async () => {
		ran = true;
	});
	assert.equal(ran, true);
});

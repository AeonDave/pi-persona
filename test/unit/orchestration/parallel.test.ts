import { test } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "../../../src/orchestration/parallel.ts";

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

import { test } from "node:test";
import assert from "node:assert/strict";

import { clampBestOf, positiveInteger } from "../../../src/orchestration/params.ts";

test("positiveInteger falls back on junk and floors a fraction", () => {
	assert.equal(positiveInteger(3, 2), 3);
	assert.equal(positiveInteger(1.9, 2), 1);
	assert.equal(positiveInteger(0, 2), 2);
	assert.equal(positiveInteger(-4, 2), 2);
	assert.equal(positiveInteger(Number.NaN, 2), 2);
	assert.equal(positiveInteger(Number.POSITIVE_INFINITY, 2), 2);
	assert.equal(positiveInteger("3", 2), 2);
});

test("clampBestOf falls back to majority then never exceeds the roster", () => {
	assert.deepEqual(clampBestOf(undefined, 3), { bestOf: 2, clamped: false });
	assert.deepEqual(clampBestOf(10, 3), { bestOf: 3, clamped: true });
	assert.deepEqual(clampBestOf(2, 3), { bestOf: 2, clamped: false });
	assert.deepEqual(clampBestOf(0, 5), { bestOf: 3, clamped: false }, "junk uses majority, which already fits");
});

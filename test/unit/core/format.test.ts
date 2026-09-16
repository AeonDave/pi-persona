import { test } from "node:test";
import assert from "node:assert/strict";

import { cappedList, compactTokens } from "../../../src/core/format.ts";

test("compactTokens compacts thousands and millions", () => {
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(164_005), "164k");
	assert.equal(compactTokens(1_234_567), "1.2M");
	assert.equal(compactTokens(2_000_000), "2M");
});

test("cappedList joins up to cap names and marks the overflow", () => {
	assert.equal(cappedList(["a", "b"], 2), "a, b");
	assert.equal(cappedList(["a", "b", "c"], 2), "a, b, …");
	assert.equal(cappedList([], 2), "");
});

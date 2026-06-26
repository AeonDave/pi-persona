import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTokens, formatUsage } from "../../../src/ui/usage.ts";

test("formatTokens scales to k/M", () => {
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(2344), "2.3k");
	assert.equal(formatTokens(12000), "12k");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatUsage shows input/output/cache/cost, omitting zeros", () => {
	assert.equal(
		formatUsage({ input: 10, output: 2344, cacheRead: 12000, cacheWrite: 500, cost: 0.05, contextTokens: 0, turns: 1 }),
		"↑10 ↓2.3k R12k W500 $0.0500",
	);
	assert.equal(
		formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }),
		"",
	);
});

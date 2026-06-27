import { test } from "node:test";
import assert from "node:assert/strict";

import { getStrategy } from "../../../src/orchestration/strategy.ts";

// Registry completeness: every built-in strategy MUST be reachable by name (so a new
// strategy file can't be silently unregistered), and each must declare a matching name.
const BUILTIN_NAMES = ["fanout", "pipeline", "map", "critic-loop", "council-rounds", "magi", "judge"];

test("getStrategy resolves every built-in strategy by name", () => {
	for (const name of BUILTIN_NAMES) {
		const s = getStrategy(name);
		assert.ok(s, `strategy "${name}" is registered`);
		assert.equal(s?.name, name, `strategy "${name}" declares a matching name`);
		assert.equal(typeof s?.run, "function", `strategy "${name}" has a run()`);
	}
});

test("getStrategy returns undefined for an unknown strategy", () => {
	assert.equal(getStrategy("does-not-exist"), undefined);
});

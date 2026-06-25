import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRoster, parseTeams } from "../../../src/orchestration/roster.ts";

test("parseTeams reads team -> agent list (inline lists)", () => {
	const t = parseTeams("review: [security, performance]\nmagi: [melchior, balthasar, casper]");
	assert.deepEqual(t.review, ["security", "performance"]);
	assert.deepEqual(t.magi, ["melchior", "balthasar", "casper"]);
});

test("parseTeams handles block lists and skips empty teams", () => {
	const t = parseTeams("build:\n  - planner\n  - coder\nempty: []");
	assert.deepEqual(t.build, ["planner", "coder"]);
	assert.equal(t.empty, undefined);
});

test("makeRoster.team returns the agents, or [] for an unknown team", () => {
	const r = makeRoster({ a: ["x", "y"] });
	assert.deepEqual(r.team("a"), ["x", "y"]);
	assert.deepEqual(r.team("nope"), []);
});

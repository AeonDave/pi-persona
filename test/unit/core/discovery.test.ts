import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeByPrecedence } from "../../../src/core/discovery.ts";

test("a single layer resolves every file with nothing shadowed", () => {
	const r = mergeByPrecedence([
		[
			{ name: "scout", path: "/u/scout.md", scope: "user" },
			{ name: "planner", path: "/u/planner.md", scope: "user" },
		],
	]);
	assert.equal(r.resolved.length, 2);
	assert.equal(r.shadowed.length, 0);
});

test("a higher-precedence layer shadows same-named files from lower layers", () => {
	const user = [{ name: "magi", path: "/u/magi.md", scope: "user" }];
	const project = [{ name: "magi", path: "/p/magi.md", scope: "project" }];
	const r = mergeByPrecedence([user, project]); // project is higher precedence
	assert.equal(r.resolved.length, 1);
	assert.equal(r.resolved[0]?.scope, "project");
	assert.equal(r.resolved[0]?.path, "/p/magi.md");
	assert.equal(r.shadowed.length, 1);
	assert.equal(r.shadowed[0]?.scope, "user");
});

test("three layers record every shadowed loser for diagnostics", () => {
	const r = mergeByPrecedence([
		[{ name: "x", path: "/builtin/x.md", scope: "builtin" }],
		[{ name: "x", path: "/u/x.md", scope: "user" }],
		[{ name: "x", path: "/p/x.md", scope: "project" }],
	]);
	assert.equal(r.resolved[0]?.scope, "project");
	assert.deepEqual(
		r.shadowed.map((f) => f.scope).sort(),
		["builtin", "user"],
	);
});

test("distinct names across layers are all resolved", () => {
	const r = mergeByPrecedence([
		[{ name: "a", path: "/u/a.md", scope: "user" }],
		[{ name: "b", path: "/p/b.md", scope: "project" }],
	]);
	assert.equal(r.resolved.length, 2);
	assert.equal(r.shadowed.length, 0);
});

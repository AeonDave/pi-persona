import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRoster, memberBaseLabel, parseTeams, roleHint, rosterNodeKeys, rosterSpec } from "../../../src/orchestration/roster.ts";

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

test("parseTeams reads inline-map members that specialise ONE agent (role/model/skills)", () => {
	const yaml = [
		"review:",
		'  - { agent: reviewer, role: "security lens", skills: [source-review-technique] }',
		'  - { agent: reviewer, role: "perf lens", model: "prov/fast" }',
		"  - scout",
	].join("\n");
	const t = parseTeams(yaml);
	assert.equal(t.review?.length, 3);
	assert.deepEqual(rosterSpec(t.review![0]!), { agent: "reviewer", role: "security lens", skills: ["source-review-technique"] });
	assert.deepEqual(rosterSpec(t.review![1]!), { agent: "reviewer", role: "perf lens", model: "prov/fast" });
	assert.deepEqual(rosterSpec(t.review![2]!), { agent: "scout" }, "a bare string is a plain member");
});

test("rosterSpec normalises a bare name and drops empty specialisation fields", () => {
	assert.deepEqual(rosterSpec("operator"), { agent: "operator" });
	assert.deepEqual(rosterSpec({ agent: "reviewer", role: "  " }), { agent: "reviewer" }, "blank role dropped");
});

test("a map member with no agent name is skipped (not a crash)", () => {
	const t = parseTeams('bad:\n  - { role: "no agent" }\n  - good');
	assert.deepEqual(t.bad, ["good"]);
});

test("roleHint picks the emphasised keyword, skipping connective ALL-CAPS words", () => {
	assert.equal(roleHint("Focus ONLY on the SECURITY lens: injection, authz."), "SECURITY");
	assert.equal(roleHint("Focus ONLY on the PERFORMANCE lens: hot paths."), "PERFORMANCE");
	// no emphasised keyword → a short prefix of the role text (first few words, capped).
	assert.equal(roleHint("look at the database layer only"), "look at the database");
});

test("memberBaseLabel is the agent name, or `agent · HINT` when it carries a role", () => {
	assert.equal(memberBaseLabel("scout"), "scout");
	assert.equal(memberBaseLabel({ agent: "reviewer", role: "Focus ONLY on the TESTS lens" }), "reviewer · TESTS");
});

test("rosterNodeKeys disambiguates same-agent roster-role members by lens (no #N when distinct)", () => {
	const team = parseTeams(
		[
			"review:",
			'  - { agent: reviewer, role: "Focus ONLY on the SECURITY lens" }',
			'  - { agent: reviewer, role: "Focus ONLY on the PERFORMANCE lens" }',
			'  - { agent: reviewer, role: "Focus ONLY on the TESTS lens" }',
		].join("\n"),
	).review!;
	assert.deepEqual(rosterNodeKeys(team), ["reviewer · SECURITY", "reviewer · PERFORMANCE", "reviewer · TESTS"]);
});

test("rosterNodeKeys suffixes #N only when the base label repeats (degenerate identical members)", () => {
	assert.deepEqual(rosterNodeKeys(["scout", "scout", "operator"]), ["scout", "scout#2", "operator"]);
});

test("parseTeams resolves build team for compete strategy (adoption example)", () => {
	const yaml = "repair: [operator, verifier]\nbuild: [operator, operator]";
	const t = parseTeams(yaml);
	assert.deepEqual(t.build, ["operator", "operator"]);
	assert.deepEqual(t.repair, ["operator", "verifier"]);
});

// NP1 — roster members carry tools/isolation/mcp (parity with the delegate path's specOf()).

test("rosterSpec carries tools/isolation/mcp through to the run spec (parity with the delegate path)", () => {
	const member = { agent: "operator", tools: ["read", "grep"], isolation: "worktree" as const, mcp: true };
	assert.deepEqual(rosterSpec(member), { agent: "operator", tools: ["read", "grep"], isolation: "worktree", mcp: true });
});

test("rosterSpec drops isolation: none and mcp: false, mirroring specOf()'s mapping exactly", () => {
	assert.deepEqual(rosterSpec({ agent: "operator", isolation: "none", mcp: false }), { agent: "operator" });
});

test("parseTeams reads inline-map members carrying tools/isolation/mcp (roster parity with delegate tasks)", () => {
	const yaml = ["review:", "  - { agent: operator, tools: [read, grep], isolation: worktree, mcp: true }"].join("\n");
	const t = parseTeams(yaml);
	assert.equal(t.review?.length, 1);
	assert.deepEqual(rosterSpec(t.review![0]!), { agent: "operator", tools: ["read", "grep"], isolation: "worktree", mcp: true });
});

test("rosterSpec regression-pins the no-new-fields path: absent tools/isolation/mcp ⇒ identical to today's output (no stray keys)", () => {
	assert.deepEqual(rosterSpec("scout"), { agent: "scout" });
	const spec = rosterSpec({ agent: "reviewer", role: "sec lens" });
	assert.deepEqual(spec, { agent: "reviewer", role: "sec lens" });
	assert.deepEqual(Object.keys(spec).sort(), ["agent", "role"], "no tools/isolation/mcp key present when unset");
});

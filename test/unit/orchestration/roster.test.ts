import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAuxActor } from "../../../src/orchestration/params.ts";
import { parseMembersBlock } from "../../../src/persona/persona.ts";
import { makeRoster, memberBaseLabel, parseRuntimeRosterMember, parseTeams, roleHint, rosterNodeKeys, rosterSpec } from "../../../src/orchestration/roster.ts";

test("thinking survives authored teams, runtime members, persona members and auxiliary actors", () => {
	const members = parseTeams("panel:\n  - { agent: a, thinking: low }\n  - { agent: a, thinking: high }\n  - { agent: a, thinking: xhigh }").panel!;
	assert.deepEqual(members.map((m) => rosterSpec(m).thinking), ["low", "high", "xhigh"]);
	const runtime = parseRuntimeRosterMember({ agent: "a", thinking: "off" });
	assert.deepEqual(runtime, { ok: true, member: { agent: "a", thinking: "off" } });
	assert.deepEqual(parseAuxActor({ agent: "a", thinking: "max" }, "arbiter"), { ok: true, spec: { agent: "a", thinking: "max" } });
	assert.deepEqual(parseMembersBlock([{ agent: "a", thinking: "minimal" }]), { ok: true, members: [{ agent: "a", thinking: "minimal" }] });
});

test("malformed explicit thinking rejects static teams, runtime and persona members, and aux actors", () => {
	for (const thinking of ["ultra", "", null, 2, true, ["high"]]) {
		assert.equal(parseRuntimeRosterMember({ agent: "a", thinking }).ok, false);
		assert.equal(parseMembersBlock([{ agent: "a", thinking }]).ok, false);
		assert.equal(parseAuxActor({ agent: "a", thinking }, "arbiter")?.ok, false);
	}
	assert.throws(() => parseTeams("panel:\n  - { agent: a, thinking: ultra }"), /thinking/);
});

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
	assert.equal(roleHint("Focus ONLY on the CORRECTNESS lens: edge cases."), "CORRECTNESS");
	// no emphasised keyword → a short prefix of the role text (first few words, capped).
	assert.equal(roleHint("look at the database layer only"), "look at the database");
});

test("roleHint ignores code, paths, environment identifiers, hashes and generic Git refs", () => {
	assert.equal(roleHint("PI_PERSONA_RESULT_READER_TOKEN / HEAD"), "role");
	assert.equal(roleHint("Focus PI_PERSONA_RESULT_READER_TOKEN / HEAD; use SECURITY lens"), "SECURITY");
	assert.equal(roleHint("Review `src/core/result.ts` and abcdef0123456789 on HEAD"), "Review");
	assert.equal(roleHint("$PI_PERSONA src/ /tmp/result on HEAD"), "role", "leading sigils and trailing path separators stay filtered");
	assert.equal(roleHint("SECURITY: review auth"), "SECURITY", "a heading colon is punctuation, not a technical identifier");
	assert.equal(roleHint("https://example.test C:\\repo"), "role", "URI and drive separators still identify technical tokens");
	assert.equal(roleHint("café 🚀 et méthode"), "café et méthode");
	assert.equal(roleHint("é".repeat(25)), `${"é".repeat(19)}…`, "truncation keeps Unicode code points intact");
	assert.equal(roleHint("A".repeat(64)), `${"A".repeat(19)}…`, "emphasised keywords use the same hint bound");
});

test("roleHint strips terminal and direction controls before deriving a safe lens", () => {
	const escaped = "\u001b[31mSECURITY\u001b[0m lens\nsecond line";
	assert.equal(roleHint(escaped), "SECURITY");
	assert.equal(roleHint("\u001b]0;forged title\u0007SECURITY lens"), "SECURITY");
	assert.equal(roleHint("SE\u202eCURITY lens"), "SECURITY");
});

test("technical-only role hints use a neutral label and retain deterministic collision suffixes", () => {
	const members = [
		{ agent: "judge", role: "PI_PERSONA_RESULT_READER_TOKEN / HEAD" },
		{ agent: "judge", role: "CACHE_RESULT_TOKEN / HEAD" },
	];
	assert.deepEqual(members.map(memberBaseLabel), ["judge · role", "judge · role"]);
	assert.deepEqual(rosterNodeKeys(members), ["judge · role", "judge · role#2"]);
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

test("rosterSpec preserves an explicit empty tool allowlist", () => {
	assert.deepEqual(rosterSpec({ agent: "locked", tools: [] }), { agent: "locked", tools: [] });
});

test("rosterSpec preserves explicit isolation: none and mcp: false overrides", () => {
	assert.deepEqual(rosterSpec({ agent: "operator", isolation: "none", mcp: false }), {
		agent: "operator",
		isolation: "none",
		mcp: false,
	});
});

test("parseTeams reads inline-map members carrying tools/isolation/mcp (roster parity with delegate tasks)", () => {
	const yaml = [
		"review:",
		"  - { agent: operator, tools: [read, grep], isolation: worktree, mcp: true }",
		"  - { agent: scout, isolation: none, mcp: false }",
	].join("\n");
	const t = parseTeams(yaml);
	assert.equal(t.review?.length, 2);
	assert.deepEqual(rosterSpec(t.review![0]!), { agent: "operator", tools: ["read", "grep"], isolation: "worktree", mcp: true });
	assert.deepEqual(rosterSpec(t.review![1]!), { agent: "scout", isolation: "none", mcp: false });
});

test("rosterSpec regression-pins the no-new-fields path: absent tools/isolation/mcp ⇒ identical to today's output (no stray keys)", () => {
	assert.deepEqual(rosterSpec("scout"), { agent: "scout" });
	const spec = rosterSpec({ agent: "reviewer", role: "sec lens" });
	assert.deepEqual(spec, { agent: "reviewer", role: "sec lens" });
	assert.deepEqual(Object.keys(spec).sort(), ["agent", "role"], "no tools/isolation/mcp key present when unset");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDelegationBrief, buildExocomBrief } from "../../../src/core/brief.ts";

const AGENTS = [
	{ name: "operator", description: "Generic adaptive technical executor verticalized by skills." },
	{ name: "scout", description: "Read-only explorer — locates the relevant facts and reports them tight." },
	{ name: "reviewer" },
];

test("no agents + no persona → no brief (vanilla pi stays untouched)", () => {
	assert.equal(
		buildDelegationBrief({ agents: [], teams: {}, flows: [], standing: false, asyncDefault: true }),
		undefined,
	);
});

test("no agents + a delegating persona → seed guidance, not a broken roster", () => {
	const brief = buildDelegationBrief({ agents: [], teams: {}, flows: [], standing: true, asyncDefault: true });
	assert.ok(brief);
	assert.match(brief ?? "", /\/persona seed/);
	assert.match(brief ?? "", /cannot run/i);
});

test("empty targets but agents ARE installed → 'widen the allowlist', NOT the fresh-install seed lie", () => {
	// A persona holds `delegate` but its permission allowlist matches none of the 5 installed
	// agents (filtered to []). The brief must diagnose the restriction, not claim nothing is seeded.
	const brief = buildDelegationBrief({ agents: [], teams: {}, flows: [], standing: true, asyncDefault: true, installedCount: 5 });
	assert.ok(brief);
	assert.match(brief ?? "", /allows none of the 5/);
	assert.match(brief ?? "", /allowlist/i);
	assert.equal(/\/persona seed/.test(brief ?? ""), false, "must not tell the model to seed — agents ARE installed");
});

test("lists each agent with its clipped description", () => {
	const long = "x".repeat(200);
	const brief = buildDelegationBrief({
		agents: [{ name: "operator", description: long }, { name: "scout" }],
		teams: {},
		flows: [],
		standing: true,
		asyncDefault: true,
	});
	assert.ok(brief);
	assert.match(brief ?? "", /- operator — x+…/);
	assert.match(brief ?? "", /- scout/);
	// clipped: the 200-char description must not survive whole
	assert.equal((brief ?? "").includes(long), false);
});

test("teams render as name[members] with ×N for repeated members; flows listed when present", () => {
	const brief = buildDelegationBrief({
		agents: AGENTS,
		teams: { review: ["reviewer", "reviewer", "reviewer"], repair: ["operator", "verifier"] },
		flows: ["ship-check"],
		standing: true,
		asyncDefault: true,
	});
	assert.match(brief ?? "", /review\[reviewer×3\]/);
	assert.match(brief ?? "", /repair\[operator, verifier\]/);
	assert.match(brief ?? "", /Flows: ship-check/);
});

test("no flows → no Flows line", () => {
	const brief = buildDelegationBrief({ agents: AGENTS, teams: {}, flows: [], standing: true, asyncDefault: true });
	assert.equal(/Flows:/.test(brief ?? ""), false);
});

test("standing brief states the hand-off default and a minimum call using operator", () => {
	const brief = buildDelegationBrief({ agents: AGENTS, teams: {}, flows: [], standing: true, asyncDefault: true });
	assert.match(brief ?? "", /Hand off by default/i);
	assert.match(brief ?? "", /delegate\(\{ agent: "operator"/);
	assert.match(brief ?? "", /council/);
});

test("without operator the example uses the first listed agent", () => {
	const brief = buildDelegationBrief({
		agents: [{ name: "scout" }],
		teams: {},
		flows: [],
		standing: true,
		asyncDefault: true,
	});
	assert.match(brief ?? "", /delegate\(\{ agent: "scout"/);
});

test("no persona → soft discovery line, no standing mandate", () => {
	const brief = buildDelegationBrief({ agents: AGENTS, teams: {}, flows: [], standing: false, asyncDefault: true });
	assert.ok(brief);
	assert.equal(/Hand off by default/i.test(brief ?? ""), false);
	assert.match(brief ?? "", /delegate/);
});

test("asyncDefault phrases the push model; sync default phrases the blocking call", () => {
	const bg = buildDelegationBrief({ agents: AGENTS, teams: {}, flows: [], standing: true, asyncDefault: true });
	const sync = buildDelegationBrief({ agents: AGENTS, teams: {}, flows: [], standing: true, asyncDefault: false });
	assert.match(bg ?? "", /background/i);
	assert.match(bg ?? "", /don't watch or poll/i);
	assert.equal(/don't watch or poll/i.test(sync ?? ""), false);
});

test("caps the agent list and says how many more", () => {
	const many = Array.from({ length: 20 }, (_, i) => ({ name: `agent${i}` }));
	const brief = buildDelegationBrief({ agents: many, teams: {}, flows: [], standing: true, asyncDefault: true });
	assert.match(brief ?? "", /and 4 more/);
});

test("buildExocomBrief: no peers → no brief", () => {
	assert.equal(buildExocomBrief([]), undefined);
});

test("buildExocomBrief: lists peers with persona — purpose, and the exocom_send guidance line", () => {
	const brief = buildExocomBrief([
		{ name: "orion", persona: "dev", purpose: "implements features" },
		{ name: "vega", persona: "reviewer", purpose: "reviews diffs" },
	]);
	assert.ok(brief);
	assert.match(brief ?? "", /- orion \(dev — implements features\)/);
	assert.match(brief ?? "", /- vega \(reviewer — reviews diffs\)/);
	assert.match(brief ?? "", /NOT your sub-agents/);
	assert.match(brief ?? "", /exocom_send\(\{ target: "<name>", message: "<request>" \}\)/);
});

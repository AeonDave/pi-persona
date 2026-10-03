import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMembersBlock, parsePersona, resolveCouncilInvocation } from "../../../src/persona/persona.ts";
import { parseTeams } from "../../../src/orchestration/roster.ts";
import {
	ADHOC_MEMBERS_KEY,
	resolveOrchestrationMembers,
	runPersonaStrategy,
} from "../../../src/persona/orchestrate.ts";
import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

const persona = (fm: string): NonNullable<ReturnType<typeof parsePersona>> => parsePersona(`---\nname: adhoc\npersona: true\n${fm}\n---\nBODY`, "adhoc.md")!;

test("council.members parses bare agent names and inline specialisations", () => {
	// Block-list form (same shape `teams.yaml` uses): the YAML subset only parses an inline
	// map as a block item, so a flow list `[scout, { agent: x }]` would NOT reach us as a map.
	const p = persona(
		'council:\n  strategy: fanout\n  members:\n    - scout\n    - { agent: reviewer, role: "SECURITY lens", model: "p/rev" }',
	);
	assert.deepEqual(p.council?.members, ["scout", { agent: "reviewer", role: "SECURITY lens", model: "p/rev" }]);
	assert.equal(p.council?.membersProblem, undefined, "a valid block carries no diagnostic");
});

test("an explicitly empty or malformed council.members block is DIAGNOSED, never silently dropped", () => {
	const empty = persona("council:\n  strategy: fanout\n  members: []");
	assert.equal(empty.council?.members, undefined);
	assert.match(empty.council?.membersProblem ?? "", /members/i);

	const malformed = persona('council:\n  strategy: fanout\n  members:\n    - scout\n    - { role: "no agent here" }');
	assert.equal(malformed.council?.members, undefined);
	assert.match(malformed.council?.membersProblem ?? "", /members\[1\]/);

	const notAList = persona("council:\n  strategy: fanout\n  members: scout");
	assert.match(notAList.council?.membersProblem ?? "", /members/i);
});

test("per-call members win the profile's named roster for THIS call only", () => {
	const p = persona("council:\n  strategy: fanout\n  roster: magi");
	assert.ok(p);
	const withMembers = resolveCouncilInvocation([p], p, { members: ["scout", { agent: "reviewer", role: "SECURITY" }] });
	assert.ok(withMembers.ok);
	assert.deepEqual(withMembers.value.members, ["scout", { agent: "reviewer", role: "SECURITY" }]);
	assert.equal(withMembers.value.roster, "", "an inline roster replaces the named team (empty roster = no named team)");

	// …and the declaration itself is untouched: the next call is back on the named team.
	const next = resolveCouncilInvocation([p], p, {});
	assert.ok(next.ok);
	assert.equal(next.value.roster, "magi");
	assert.equal(next.value.members, undefined);
});

test("an explicitly empty members list is a diagnostic, NOT a silent MAGI fallback", () => {
	const p = persona("council:\n  strategy: fanout\n  roster: magi");
	assert.ok(p);
	const empty = resolveCouncilInvocation([p], p, { members: [] });
	assert.equal(empty.ok, false);
	if (empty.ok) return;
	assert.match(empty.error, /members/i);

	const junk = resolveCouncilInvocation([p], p, { members: [{ role: "no agent" }] });
	assert.equal(junk.ok, false);
});

test("a persona whose declared council.members is unusable surfaces the diagnostic", () => {
	const p = persona("council:\n  strategy: fanout\n  roster: magi\n  members: []");
	assert.ok(p);
	const resolved = resolveCouncilInvocation([p], p, { persona: "adhoc" });
	assert.equal(resolved.ok, false);
	if (resolved.ok) return;
	assert.match(resolved.error, /members/i);
});

test("resolveOrchestrationMembers: inline wins, named team next, unknown name diagnosed, no roster → []", () => {
	const inline = [{ agent: "scout", role: "RECON" }];
	assert.deepEqual(resolveOrchestrationMembers({ members: inline, roster: "magi" }, { magi: ["melchior"] }), inline);
	assert.deepEqual(resolveOrchestrationMembers({ roster: "magi" }, { magi: ["melchior"] }), ["melchior"]);
	assert.deepEqual(resolveOrchestrationMembers({}, { magi: ["melchior"] }), []);
	assert.throws(
		() => resolveOrchestrationMembers({ roster: "nope" }, { magi: ["melchior"] }),
		/unknown roster "nope"/,
	);
	assert.throws(
		() => resolveOrchestrationMembers({ roster: "nope" }, {}),
		/no teams/i,
	);
});

test("runPersonaStrategy runs the inline members (with their specialisation) and never mutates deps.teams", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => {
			specs.push(s);
			return { agent: s.agent, output: `out:${s.agent}`, usage: usage(), ok: true };
		},
	};
	const teams = { magi: ["melchior", "balthasar", "casper"] };
	const before = structuredClone(teams);
	const r = await runPersonaStrategy(
		{ mode: "strategy", strategy: "fanout", roster: "magi", members: [{ agent: "scout", role: "RECON", model: "p/scout" }] },
		"task",
		{ engine, teams, limits: LIMITS },
	);
	assert.ok(r);
	assert.deepEqual(specs.map((s) => s.agent), ["scout"], "the inline members ran, not the named team");
	assert.equal(specs[0]?.role, "RECON");
	assert.equal(specs[0]?.model, "p/scout");
	assert.deepEqual(teams, before, "the shared team map is untouched");
	assert.equal(Object.hasOwn(teams, ADHOC_MEMBERS_KEY), false, "the reserved inline key is a per-call clone, never stored");
});
// ── strict runtime validation: a malformed FIELD is a diagnostic, never a silent default ──

test("parseMembersBlock accepts a fully-specified, well-typed member", () => {
	const ok = parseMembersBlock([
		"scout",
		{
			agent: "reviewer",
			role: "SECURITY lens",
			model: "p/rev",
			skills: ["security"],
			tools: ["read"],
			isolation: "worktree",
			mcp: true,
		},
	]);
	assert.ok(ok.ok);
	assert.deepEqual(ok.members, [
		"scout",
		{ agent: "reviewer", role: "SECURITY lens", model: "p/rev", skills: ["security"], tools: ["read"], isolation: "worktree", mcp: true },
	]);
});

test("parseMembersBlock rejects a wrongly-typed specialisation field instead of dropping it", () => {
	// A dropped `tools` silently grants the agent's DEFAULT tool permissions — the member
	// then runs WIDER than the caller asked for, so this must be refused, not normalised.
	const cases: Array<[unknown, RegExp]> = [
		[{ agent: "operator", tools: ["read", 42] }, /tools/],
		[{ agent: "operator", tools: "read" }, /tools/],
		[{ agent: "operator", skills: "security" }, /skills/],
		[{ agent: "operator", skills: [7] }, /skills/],
		[{ agent: "operator", model: 42 }, /model/],
		[{ agent: "operator", role: ["x"] }, /role/],
		[{ agent: "operator", mcp: "yes" }, /mcp/],
		[{ agent: "operator", isolation: "maybe" }, /isolation/],
		[{ agent: "operator", colour: "red" }, /colour/],
		[{ agent: "   " }, /agent/],
	];
	for (const [value, expected] of cases) {
		const parsed = parseMembersBlock([value]);
		assert.equal(parsed.ok, false, `${JSON.stringify(value)} must be rejected`);
		if (parsed.ok) continue;
		assert.match(parsed.error, expected, `${JSON.stringify(value)} names the offending field`);
	}
});

test("the council resolver surfaces the field diagnostic before any dispatch", () => {
	const p = persona("council:\n  strategy: fanout");
	assert.ok(p);
	const resolved = resolveCouncilInvocation([p], p, { members: [{ agent: "operator", tools: ["read", 42] }] });
	assert.equal(resolved.ok, false);
	if (resolved.ok) return;
	assert.match(resolved.error, /tools/);
});

test("the LENIENT static parser still normalises teams.yaml (its documented, separate contract)", () => {
	// teams.yaml is authored, trusted project data: parseTeams stays lenient — a wrongly-typed
	// scalar is DROPPED and list entries are COERCED to strings. Runtime-supplied members
	// (tool call, aux actor param) go through the strict path above, where that same input is
	// refused instead of normalised.
	const teams = parseTeams("t:\n  - { agent: operator, model: 42, tools: [\"read\", 42] }\n  - scout\n");
	assert.deepEqual(teams.t, [{ agent: "operator", tools: ["read", "42"] }, "scout"]);
});

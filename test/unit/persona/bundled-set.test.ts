// The bundled personas as ONE set (elite is a deliberately larger, separate prompt).
//
// What a persona declares is data the runtime acts on, and the parsers are lenient by design (an unknown
// key is dropped, an unknown strategy param only warns). So a typo in a bundled file is silent in
// production; these tests are where it fails loudly. They also pin the shared shape that keeps the
// personas' prompts differing only in persona-specific judgement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYamlSubset, splitFrontmatter } from "../../../src/core/frontmatter.ts";
import { parseTeams, rosterSpec } from "../../../src/orchestration/roster.ts";
import { knownParams, missingRequiredParams } from "../../../src/orchestration/strategy.ts";
import { parsePersona, resolveCouncilInvocation } from "../../../src/persona/persona.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SET = readdirSync(`${ROOT}personas`)
	.filter((f) => f.endsWith(".md") && f !== "elite.md")
	.map((f) => {
		const text = readFileSync(`${ROOT}personas/${f}`, "utf8");
		return { name: f.slice(0, -3), fm: parseYamlSubset(splitFrontmatter(text).frontmatter), persona: parsePersona(text, f)! };
	});
const BUNDLED_AGENTS = new Set(
	readdirSync(`${ROOT}agents`)
		.filter((f) => f.endsWith(".md"))
		.map((f) => parseYamlSubset(splitFrontmatter(readFileSync(`${ROOT}agents/${f}`, "utf8")).frontmatter).name as string),
);
const TEAMS = parseTeams(readFileSync(`${ROOT}teams.yaml`, "utf8"));

/** Each bundled persona and the method it declares as its own: what `council` runs when the call omits all three. */
const DECLARED_METHOD: Record<string, { strategy: string; roster: string; params: Record<string, unknown> } | undefined> = {
	audit: { strategy: "synthesize", roster: "review", params: { synthesizer: "reviewer", peers: true } },
	dev: { strategy: "critic-loop", roster: "repair", params: { rounds: 3 } },
	judge: { strategy: "judge", roster: "magi", params: { judge: "reviewer", contract: "default" } },
	magi: { strategy: "magi", roster: "magi", params: {} },
	planner: undefined,
	researcher: undefined,
	swarm: { strategy: "map", roster: "swarm", params: { ownership: "declare" } },
	verify: { strategy: "critic-loop", roster: "repair", params: { rounds: 4 } },
};

test("the bundled persona set is the one these tests describe", () => {
	assert.deepEqual(SET.map((p) => p.name).sort(), Object.keys(DECLARED_METHOD).sort());
});

test("every bundled persona has the same frontmatter shape: identity, one-line description, uniform prompt mode", () => {
	const ORDER = ["name", "label", "persona", "description", "coaching", "systemPromptMode", "tools", "delegation", "council"];
	for (const { name, fm, persona } of SET) {
		const keys = Object.keys(fm);
		assert.deepEqual(keys, ORDER.filter((k) => keys.includes(k)), `${name}: frontmatter keys use the shared order`);
		for (const required of ["name", "label", "persona", "description", "systemPromptMode"]) assert.ok(keys.includes(required), `${name}: declares ${required}`);
		assert.equal(fm.name, name);
		assert.equal(persona.isPersona, true);
		assert.equal(persona.systemPromptMode, "append", `${name}: keeps Pi's own tool guidance`);
		const description = persona.description ?? "";
		assert.ok(description.length >= 80 && description.length <= 290, `${name}: description is one line saying what it is for (${description.length} chars)`);
		assert.match(description, /\bPick\b/, `${name}: description says when to pick it`);
		if ("coaching" in fm) assert.equal(fm.coaching, true, `${name}: coaching is only ever stated as true`);
	}
});

test("every bundled persona body has the shared sections in order and stays within its size budget", () => {
	for (const { name, persona } of SET) {
		const body = persona.body.trim();
		assert.ok(!body.startsWith("**"), `${name}: opens with its identity paragraph, not a lead-in`);
		assert.match(body.split("\n\n")[0]!, /^You are /, `${name}: identity paragraph names the persona`);
		assert.deepEqual(
			[...body.matchAll(/^\*\*([^*]+?)\.\*\* /gm)].map((m) => m[1]),
			["Method", "Evidence bar", "Reporting", "Boundaries"],
			`${name}: lead-ins`,
		);
		const flat = body.replace(/\s+/g, " ");
		const bytes = Buffer.byteLength(body);
		assert.ok(bytes >= 1200 && bytes <= 2200, `${name}: body is 1.2-2.2 KB (${bytes} B)`);
		// Whatever launches a run is woken by its result: ONE shared sentence says so, in every persona.
		assert.match(
			flat,
			/end your turn: (?:the|their) [\w ,'-]+ wakes? you(?: once)? \(headless: the call returns (?:it|them) inline\)/,
			`${name}: says to end the turn and that the result wakes it`,
		);
		// The runtime and the per-turn brief already carry these; a persona sentence must add judgement, not restate them.
		assert.doesNotMatch(body, /\b(?:scopeRoe|requiredArtifacts|stopConditions)\b|intercom|untrusted|\bpeek\b|\bsleep\b/i, `${name}: restates the platform`);
	}
});

test("every bundled persona's declared method is valid against the strategy registry, the teams and the agents", () => {
	const personas = SET.map((p) => p.persona);
	for (const { name, fm, persona } of SET) {
		const expected = DECLARED_METHOD[name];
		if (!expected) {
			assert.equal(persona.council, undefined, `${name}: declares no council`);
			continue;
		}
		const council = persona.council!;
		assert.deepEqual(Object.keys(fm.council as object), Object.keys(council), `${name}: no council key is silently dropped by the parser`);
		const schema = knownParams(council.strategy!);
		assert.ok(schema, `${name}: strategy "${council.strategy}" is registered`);
		for (const key of Object.keys(council.params ?? {})) assert.ok(key in schema, `${name}: "${key}" is a param of ${council.strategy}`);
		assert.equal(missingRequiredParams(council.strategy!, council.params ?? {}), undefined, `${name}: every required param is declared`);
		const team = TEAMS[council.roster!];
		assert.ok(team && team.length > 0, `${name}: roster "${council.roster}" is a team`);
		for (const member of team) assert.ok(BUNDLED_AGENTS.has(rosterSpec(member).agent), `${name}: ${rosterSpec(member).agent} is a bundled agent`);
		for (const [param, value] of Object.entries(council.params ?? {})) {
			if (schema[param]?.type === "agent") assert.ok(BUNDLED_AGENTS.has(value as string), `${name}: params.${param} names a bundled agent`);
		}
		// The persona's defaults are its method: a council call that omits everything must resolve to exactly them.
		const resolved = resolveCouncilInvocation(personas, persona, {});
		assert.deepEqual(resolved.ok && resolved.value, { ...expected, persona: name });
	}
});

test("every bundled persona's delegation policy and tool deny are spelled as the parser reads them", () => {
	const POLICY_KEYS = ["requireBrief", "outputContract", "requireDisjointWrites", "requireFreshVerification", "verificationAgents"];
	const policies: Record<string, unknown> = {};
	for (const { name, fm, persona } of SET) {
		if (fm.delegation !== undefined) {
			const declared = Object.keys(fm.delegation as object);
			for (const key of declared) assert.ok(POLICY_KEYS.includes(key), `${name}: delegation.${key} is a policy key`);
			assert.deepEqual(Object.keys(persona.delegation ?? {}), declared, `${name}: no delegation key is silently dropped by the parser`);
			for (const agent of persona.delegation?.verificationAgents ?? []) assert.ok(BUNDLED_AGENTS.has(agent), `${name}: verification agent ${agent} is bundled`);
			policies[name] = persona.delegation;
		}
		if (fm.tools !== undefined) assert.deepEqual(Object.keys(fm.tools as object), Object.keys(persona.tools ?? {}), `${name}: tools keys are allow/deny`);
	}
	// A persona that launches writers carries a call-time gate: capabilities are enforced, never prompt-only.
	assert.deepEqual(policies.swarm, { requireBrief: true, requireDisjointWrites: true });
	assert.deepEqual(policies.audit, { requireBrief: true });
	assert.deepEqual(policies.verify, { requireFreshVerification: true, verificationAgents: ["verifier"] });
	assert.deepEqual(SET.find((p) => p.name === "planner")!.persona.tools, { deny: ["edit"] });
	assert.deepEqual(SET.filter((p) => p.persona.coaching).map((p) => p.name).sort(), ["dev", "planner", "researcher", "swarm"]);
});

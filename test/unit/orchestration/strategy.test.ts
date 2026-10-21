import { test } from "node:test";
import assert from "node:assert/strict";

import { getStrategy, knownParams, strategyCatalog, strategyNames, missingRequiredParams } from "../../../src/orchestration/strategy.ts";

// Registry completeness: every built-in strategy MUST be reachable by name (so a new
// strategy file can't be silently unregistered), and each must declare a matching name.
const BUILTIN_NAMES = ["fanout", "pipeline", "map", "critic-loop", "council-rounds", "debate", "magi", "judge", "pair", "synthesize", "compete"];

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

test("knownParams exposes a strategy's declared params; magi has reflect + aggregate", () => {
	const p = knownParams("magi");
	assert.ok(p && "reflect" in p && "aggregate" in p);
	assert.equal(p.reflect?.type, "boolean");
	assert.deepEqual(knownParams("fanout"), {}, "a known param-less strategy exposes an empty schema");
	assert.equal(knownParams("nope"), undefined);
});

// ── self-description: the registry teaches the model WHICH method fits, and what it needs ────

const NAMES = ["fanout", "pipeline", "map", "critic-loop", "council-rounds", "debate", "magi", "judge", "pair", "synthesize", "compete"];

test("every built-in strategy describes the problem class it answers in one short line", () => {
	for (const name of NAMES) {
		const when = getStrategy(name)?.when;
		assert.ok(when, `strategy "${name}" declares a \`when\``);
		assert.equal(/\n/.test(when), false, `"${name}".when is one line`);
		assert.ok(when.length <= 130, `"${name}".when is ${when.length} chars — keep it terse`);
	}
});

test("positional rosters are declared where position matters", () => {
	assert.match(getStrategy("map")?.roster ?? "", /splitter.*worker/);
	assert.match(getStrategy("pair")?.roster ?? "", /driver.*navigator/);
	assert.match(getStrategy("critic-loop")?.roster ?? "", /generator.*critic/);
	assert.match(getStrategy("compete")?.roster ?? "", /competitors/);
});

test("`required` names declared params, and exactly the judge-bearing strategies require an arbiter", () => {
	for (const name of NAMES) {
		const s = getStrategy(name);
		for (const key of s?.required ?? []) assert.ok(s?.params && key in s.params, `"${name}".required names an undeclared param "${key}"`);
	}
	assert.deepEqual(getStrategy("judge")?.required, ["judge"]);
	assert.deepEqual(getStrategy("compete")?.required, ["judge"]);
	assert.deepEqual(NAMES.filter((n) => getStrategy(n)?.required?.length), ["judge", "compete"]);
});

test("strategyCatalog renders one line per registered strategy, generated from the registry", () => {
	const lines = strategyCatalog().split("\n");
	assert.equal(lines.length, NAMES.length);
	for (const name of strategyNames()) {
		const line = lines.find((l) => l.startsWith(`- ${name}`));
		assert.ok(line, `a line for ${name}`);
		assert.ok(line.includes(getStrategy(name)?.when ?? "\0"), `${name}: the line carries its \`when\``);
	}
	const judgeLine = lines.find((l) => l.startsWith("- judge"));
	assert.match(judgeLine ?? "", /\(judge\*, contract\)/, "a required param is starred");
	assert.match(lines.find((l) => l.startsWith("- map")) ?? "", /roster: \[splitter, worker\]/);
	assert.match(lines.find((l) => l.startsWith("- magi")) ?? "", /\(aggregate, reflect\)/, "param keys still show");
});

test("missingRequiredParams names the absent required param; blank counts as absent; an unknown strategy is the run's to report", () => {
	assert.equal(missingRequiredParams("magi", {}), undefined);
	assert.equal(missingRequiredParams("nope", {}), undefined, "unknown strategies are not judged here");
	assert.equal(missingRequiredParams("judge", { judge: "reviewer" }), undefined);
	assert.equal(missingRequiredParams("judge", { judge: { agent: "reviewer", role: "tiebreak" } }), undefined);
	for (const blank of [{}, { judge: undefined }, { judge: null }, { judge: "" }, { judge: "   " }]) {
		assert.match(missingRequiredParams("compete", blank) ?? "", /^"compete" requires params.judge — the arbiter agent/);
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePersona, resolveCouncilInvocation } from "../../../src/persona/persona.ts";
import { getStrategy, strategyCatalog, strategyNames } from "../../../src/orchestration/strategy.ts";

const persona = (name: string, fm: string) => parsePersona(`---\nname: ${name}\npersona: true\n${fm}\n---\nBODY`, `${name}.md`)!;
const resolve = (active: ReturnType<typeof persona> | undefined, request: Parameters<typeof resolveCouncilInvocation>[2]) => {
	const r = resolveCouncilInvocation(active ? [active] : [], active, request);
	assert.ok(r.ok);
	return r.value;
};

test("naming a method seats the team that method is built for, instead of whatever roster the profile or the fallback holds", () => {
	// no persona: the fallback team was `magi`, three read-only voters - useless as a map splitter or a compete racer
	assert.equal(resolve(undefined, { strategy: "map" }).roster, "swarm");
	assert.equal(resolve(undefined, { strategy: "compete", params: { judge: "reviewer" } }).roster, "build");
	assert.equal(resolve(undefined, { strategy: "critic-loop" }).roster, "repair");
	assert.equal(resolve(undefined, { strategy: "synthesize" }).roster, "review");
	// a persona's own roster belongs to the persona's own method: a switch to a voting method leaves `repair`
	const dev = persona("dev", "council:\n  strategy: critic-loop\n  roster: repair");
	assert.equal(resolve(dev, { strategy: "magi" }).roster, "magi");
	assert.equal(resolve(dev, { strategy: "map" }).roster, "swarm");
});

test("an explicit roster or members still win, and a method with no team of its own keeps the inherited roster", () => {
	const dev = persona("dev", "council:\n  strategy: critic-loop\n  roster: repair");
	assert.equal(resolve(dev, { strategy: "map", roster: "magi" }).roster, "magi");
	assert.equal(resolve(dev, { strategy: "map", members: ["scout", "operator"] }).roster, "");
	assert.equal(resolve(dev, { strategy: "fanout" }).roster, "repair", "fanout declares no team: the profile's roster is the sensible panel");
});

test("persona defaults resolve exactly as declared when the call names no strategy", () => {
	for (const [strategy, roster] of [["critic-loop", "repair"], ["synthesize", "review"], ["map", "swarm"], ["magi", "magi"], ["judge", "magi"]] as const) {
		const p = persona(`p-${strategy}`, `council:\n  strategy: ${strategy}\n  roster: ${roster}`);
		const r = resolve(p, {});
		assert.deepEqual([r.strategy, r.roster], [strategy, roster]);
		// restating the profile's own strategy is not a switch either
		assert.equal(resolve(p, { strategy }).roster, roster);
	}
	assert.equal(resolve(undefined, {}).roster, "magi", "no persona, no strategy: the built-in MAGI panel, as ever");
});

test("the catalog tells the model which team each method defaults to, from the same field the resolver reads", () => {
	const catalog = strategyCatalog();
	for (const name of strategyNames()) {
		const team = getStrategy(name)?.team;
		const line = catalog.split("\n").find((l) => l.startsWith(`- ${name}`)) ?? "";
		// `magi` is the fallback every call already gets: only a different default team is worth the tokens
		if (team && team !== "magi") assert.match(line, new RegExp(`default team ${team}[.;]`), `${name} advertises its team`);
		else assert.doesNotMatch(line, /default team/);
	}
});

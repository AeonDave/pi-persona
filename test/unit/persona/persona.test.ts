import { test } from "node:test";
import assert from "node:assert/strict";

import { composeSystemPrompt, expandCouncilPreset, parsePersona, resolveCouncilInvocation } from "../../../src/persona/persona.ts";

const MAGI = `---
name: magi
label: "🧠 MAGI"
persona: true
model: anthropic/claude-x
thinking: high
systemPromptMode: append
tools:
  allow: ["*"]
delegate:
  allow: [melchior, balthasar, casper]
skills: [code-review]
orchestration:
  mode: strategy
  strategy: magi
  roster: magi
---
You are the MAGI orchestrator.`;

test("parsePersona reads identity, permissions, orchestration grammar, and body", () => {
	const p = parsePersona(MAGI, "/p/magi.md");
	assert.ok(p);
	assert.equal(p.name, "magi");
	assert.equal(p.label, "🧠 MAGI");
	assert.equal(p.isPersona, true);
	assert.equal(p.model, "anthropic/claude-x");
	assert.equal(p.thinking, "high");
	assert.equal(p.systemPromptMode, "append");
	assert.deepEqual(p.tools, { allow: ["*"] });
	assert.deepEqual(p.delegate, { allow: ["melchior", "balthasar", "casper"] });
	assert.equal(p.orchestration?.mode, "strategy");
	assert.equal(p.orchestration?.strategy, "magi");
	assert.equal(p.orchestration?.roster, "magi");
	assert.equal(p.body, "You are the MAGI orchestrator.");
	assert.equal(p.source, "/p/magi.md");
});

test("parsePersona returns null when the name is missing", () => {
	assert.equal(parsePersona("---\nlabel: x\n---\nbody", "/s"), null);
});

test("a file without `persona: true` parses but is not a switchable persona", () => {
	const p = parsePersona("---\nname: plain\n---\nBody", "/s");
	assert.ok(p);
	assert.equal(p.isPersona, false);
	assert.equal(p.label, "plain");
	assert.equal(p.systemPromptMode, "append");
	assert.equal(p.orchestration, undefined);
});

test("a council block may carry just a preset (strategy filled in by expansion)", () => {
	const p = parsePersona("---\nname: q\npersona: true\ncouncil:\n  preset: magi-rounds\n  params: { rounds: 5 }\n---\nbody", "/s");
	assert.equal(p?.council?.preset, "magi-rounds");
	assert.deepEqual(p?.council?.params, { rounds: 5 });
});

test("expandCouncilPreset merges a preset under authored fields (authored wins, params shallow-merge)", () => {
	const presets = { "magi-rounds": { strategy: "council-rounds", roster: "magi", params: { rounds: 3, bestOf: 3 } } };
	const expanded = expandCouncilPreset({ preset: "magi-rounds", params: { rounds: 5 } }, presets);
	assert.equal(expanded?.strategy, "council-rounds");
	assert.equal(expanded?.roster, "magi");
	assert.deepEqual(expanded?.params, { rounds: 5, bestOf: 3 }, "authored rounds override; bestOf inherited");
	assert.equal((expanded as { preset?: string }).preset, undefined, "the preset key is consumed");
});

test("expandCouncilPreset leaves a preset-less spec unchanged and drops an unknown preset", () => {
	assert.deepEqual(expandCouncilPreset({ strategy: "magi", roster: "magi" }, {}), { strategy: "magi", roster: "magi" });
	// unknown preset → keep authored fields, drop the dangling preset key
	assert.deepEqual(expandCouncilPreset({ preset: "ghost", strategy: "magi" }, {}), { strategy: "magi" });
});

test("a persona parses coaching: true (opts into the contact_supervisor comm plane)", () => {
	const on = parsePersona("---\nname: c\npersona: true\ncoaching: true\n---\nbody", "/s");
	assert.equal(on?.coaching, true);
	const off = parsePersona("---\nname: c\npersona: true\n---\nbody", "/s");
	assert.equal(off?.coaching, undefined, "absent ⇒ no coaching (opt-in)");
});

test("a persona parses orchestration params (numbers + nested)", () => {
	const p = parsePersona(
		"---\nname: m\npersona: true\norchestration:\n  mode: strategy\n  strategy: magi\n  roster: magi\n  params:\n    aggregate: unanimity\n    rounds: 3\n---\nbody",
		"/s",
	);
	assert.equal(p?.orchestration?.strategy, "magi");
	assert.deepEqual(p?.orchestration?.params, { aggregate: "unanimity", rounds: 3 });
});

test("a persona parses a council block + description (tool-driven, data-only ensemble)", () => {
	const p = parsePersona(
		"---\nname: magiv2\npersona: true\ndescription: nine-member council\ncouncil:\n  strategy: council-rounds\n  roster: magiv2\n  params:\n    rounds: 3\n    bestOf: 7\n---\nbody",
		"/s",
	);
	assert.equal(p?.description, "nine-member council");
	assert.equal(p?.council?.strategy, "council-rounds");
	assert.equal(p?.council?.roster, "magiv2");
	assert.deepEqual(p?.council?.params, { rounds: 3, bestOf: 7 });
	assert.equal(p?.orchestration, undefined, "a council block does NOT trigger the mandatory input-hook");
});

test("an L1 declarative persona (mode: parallel, roster) parses its grammar", () => {
	const p = parsePersona(
		"---\nname: review\npersona: true\norchestration:\n  mode: parallel\n  roster: review\n---\nReview supervisor.",
		"/s",
	);
	assert.equal(p?.orchestration?.mode, "parallel");
	assert.equal(p?.orchestration?.roster, "review");
});

test("composeSystemPrompt appends by default and replaces when asked", () => {
	const magi = parsePersona(MAGI, "/s")!;
	assert.equal(composeSystemPrompt("BASE", magi), "BASE\n\nYou are the MAGI orchestrator.");

	const replace = parsePersona(
		"---\nname: r\npersona: true\nsystemPromptMode: replace\n---\nONLY THIS.",
		"/s",
	)!;
	assert.equal(composeSystemPrompt("BASE", replace), "ONLY THIS.");
});

test("audit council params include peers: true (adoption example)", () => {
	const audit = parsePersona(
		"---\nname: audit\npersona: true\ncouncil:\n  strategy: synthesize\n  roster: review\n  params: { synthesizer: reviewer, peers: true }\n---\nAudit supervisor.",
		"/p/audit.md",
	)!;
	assert.equal(audit.council?.strategy, "synthesize");
	assert.equal(audit.council?.roster, "review");
	assert.deepEqual(audit.council?.params, { synthesizer: "reviewer", peers: true });
});

test("resolveCouncilInvocation borrows a named persona's council without changing the active caller", () => {
	const elite = parsePersona("---\nname: elite\npersona: true\n---\nELITE", "elite.md");
	const magi = parsePersona(
		"---\nname: magi\npersona: true\ncouncil:\n  strategy: magi\n  roster: magi\n  params:\n    reflect: true\n---\nMAGI",
		"magi.md",
	);
	assert.ok(elite);
	assert.ok(magi);
	const resolved = resolveCouncilInvocation([elite, magi], elite, {
		persona: "magi",
		params: { reflect: false },
	});
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.deepEqual(resolved.value, {
		strategy: "magi",
		roster: "magi",
		params: { reflect: false },
		persona: "magi",
	});
	assert.equal(elite.name, "elite");
	assert.equal(elite.body, "ELITE");
});

test("resolveCouncilInvocation rejects an explicit persona with no council even when overrides are supplied", () => {
	const solo = parsePersona("---\nname: solo\npersona: true\n---\nSOLO", "solo.md");
	assert.ok(solo);
	assert.deepEqual(
		resolveCouncilInvocation([solo], solo, {
			persona: "solo",
			strategy: "magi",
			roster: "magi",
		}),
		{ ok: false, error: 'persona "solo" declares no usable council' },
	);
});

test("dev persona includes a tool-driven pair council (adoption example)", () => {
	const dev = parsePersona(
		"---\nname: dev\npersona: true\ncouncil:\n  strategy: pair\n  roster: repair\n---\nDev engineer.",
		"/p/dev.md",
	)!;
	assert.equal(dev.council?.strategy, "pair");
	assert.equal(dev.council?.roster, "repair");
	assert.equal(dev.council?.params, undefined);
});

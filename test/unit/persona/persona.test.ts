import { test } from "node:test";
import assert from "node:assert/strict";

import { composeSystemPrompt, parsePersona } from "../../../src/persona/persona.ts";

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
	assert.deepEqual(p.skills, { allow: ["code-review"] });
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

test("a persona parses orchestration params (numbers + nested)", () => {
	const p = parsePersona(
		"---\nname: m\npersona: true\norchestration:\n  mode: strategy\n  strategy: magi\n  roster: magi\n  params:\n    aggregate: unanimity\n    rounds: 3\n---\nbody",
		"/s",
	);
	assert.equal(p?.orchestration?.strategy, "magi");
	assert.deepEqual(p?.orchestration?.params, { aggregate: "unanimity", rounds: 3 });
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

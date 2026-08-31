import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("delegation policy is data-driven for any custom persona name", () => {
	const custom = parsePersona(
		"---\nname: my-own-supervisor\npersona: true\ndelegation:\n  requireBrief: true\n  outputContract: finding\n  requireDisjointWrites: true\n  requireFreshVerification: true\n  verificationAgents: [check-bot, proof-bot]\n---\nCustom supervisor.",
		"/p/custom.md",
	)!;
	assert.deepEqual(custom.delegation, {
		requireBrief: true,
		outputContract: "finding",
		requireDisjointWrites: true,
		requireFreshVerification: true,
		verificationAgents: ["check-bot", "proof-bot"],
	});
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

// Differential guard for docs/SPINE.md's "unset / off ⇒ byte-identical to pre-spine behavior".
// `preSpine` is the pre-spine composeSystemPrompt transcribed VERBATIM from the commit before the
// spine landed; anything the off path returns must equal it, on every mode × body shape. Written
// as a differential (not hand-written expectations) so the claim cannot be certified by a test
// that merely restates whatever the new code happens to do.
function preSpineCompose(base: string, persona: { systemPromptMode: string; body: string }): string {
	if (persona.systemPromptMode === "replace") return persona.body;
	if (!persona.body.trim()) return base;
	return `${base}\n\n${persona.body}`;
}

test("with the spine OFF every composition is byte-identical to the pre-spine implementation", () => {
	for (const mode of ["append", "replace"]) {
		for (const body of ["You are X.", "", "\n", "   \n\t "]) {
			const p = parsePersona(`---\nname: p\npersona: true\nsystemPromptMode: ${mode}\n---\n${body}`, "/s")!;
			for (const off of [undefined, "", "   \n "]) {
				assert.equal(
					composeSystemPrompt("BASE", p, off),
					preSpineCompose("BASE", p),
					`mode=${mode} body=${JSON.stringify(body)} spine=${JSON.stringify(off)}`,
				);
			}
			// `spine: false` is the other off switch: it must land on the same pre-spine bytes.
			const optedOut = { ...p, spine: false as const };
			assert.equal(composeSystemPrompt("BASE", optedOut, "SPINE"), preSpineCompose("BASE", p), `spine:false mode=${mode}`);
		}
	}
});

test("the spine sits between Pi's base prompt and the persona body (append) and replaces the base entirely (replace)", () => {
	const magi = parsePersona(MAGI, "/s")!;
	assert.equal(composeSystemPrompt("BASE", magi, "SPINE"), "BASE\n\nSPINE\n\nYou are the MAGI orchestrator.");

	const replace = parsePersona("---\nname: r\npersona: true\nsystemPromptMode: replace\n---\nONLY THIS.", "/s")!;
	assert.equal(composeSystemPrompt("BASE", replace, "SPINE"), "SPINE\n\nONLY THIS.", "replace drops Pi's base, so the spine is the only scaffolding left");
});

test("an empty-bodied persona still gets the spine — the same shape a no-persona turn gets", () => {
	const empty = parsePersona("---\nname: r\npersona: true\nsystemPromptMode: replace\n---\n", "/s")!;
	assert.equal(composeSystemPrompt("BASE", empty, "SPINE"), "BASE\n\nSPINE");
});

test("`spine: false` frontmatter opts a persona out of the shared layer", () => {
	const out = parsePersona("---\nname: judge\npersona: true\nspine: false\n---\nVerdict only.", "/s")!;
	assert.equal(out.spine, false);
	assert.equal(composeSystemPrompt("BASE", out, "SPINE"), "BASE\n\nVerdict only.");

	const optedIn = parsePersona("---\nname: j2\npersona: true\nspine: true\n---\nVerdict only.", "/s")!;
	assert.equal(optedIn.spine, undefined, "only an explicit false is recorded — nothing else changes behavior");
	assert.equal(composeSystemPrompt("BASE", optedIn, "SPINE"), "BASE\n\nSPINE\n\nVerdict only.");
});

test("with no spine the composition is BYTE-IDENTICAL to the pre-spine result", () => {
	const append = parsePersona(MAGI, "/s")!;
	const replace = parsePersona("---\nname: r\npersona: true\nsystemPromptMode: replace\n---\nONLY THIS.", "/s")!;
	const empty = parsePersona("---\nname: e\npersona: true\nsystemPromptMode: replace\n---\n", "/s")!;
	for (const off of [undefined, "", "   \n "]) {
		assert.equal(composeSystemPrompt("BASE", append, off), "BASE\n\nYou are the MAGI orchestrator.");
		assert.equal(composeSystemPrompt("BASE", replace, off), "ONLY THIS.");
		// Pre-spine, `replace` short-circuited on the mode BEFORE it looked at the body, so an
		// empty-bodied replace persona composed to an empty prompt. The off path still does.
		assert.equal(composeSystemPrompt("BASE", empty, off), "");
	}
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

test("the bundled dev persona uses a sequential fail-closed repair council", () => {
	const path = fileURLToPath(new URL("../../../personas/dev.md", import.meta.url));
	const dev = parsePersona(readFileSync(path, "utf8"), path)!;
	assert.equal(dev.council?.strategy, "critic-loop");
	assert.equal(dev.council?.roster, "repair");
	assert.deepEqual(dev.council?.params, { rounds: 3 });
	assert.deepEqual(dev.delegation, {
		requireBrief: true,
		requireDisjointWrites: true,
		requireFreshVerification: true,
		verificationAgents: ["verifier"],
	});
	for (const field of ["scopeRoe", "position", "constraints", "requiredArtifacts", "stopConditions"]) {
		assert.match(dev.body, new RegExp(`\\b${field}\\b`));
	}
});

test("the bundled elite persona exposes a sequential evidence-assurance council", () => {
	const path = fileURLToPath(new URL("../../../personas/elite.md", import.meta.url));
	const elite = parsePersona(readFileSync(path, "utf8"), path)!;
	assert.equal(elite.council?.strategy, "critic-loop");
	assert.equal(elite.council?.roster, "offensive-assurance");
	assert.deepEqual(elite.council?.params, { rounds: 3 });
	assert.deepEqual(elite.delegation, { requireBrief: true, outputContract: "finding" });
	for (const field of ["scopeRoe", "position", "constraints", "requiredArtifacts", "stopConditions"]) {
		assert.match(elite.body, new RegExp(`\\b${field}\\b`));
	}
	assert.match(elite.body, /outputContract:\s*"finding"/);
	assert.match(elite.body, /target egress/i, "Elite makes the target's network egress an explicit invariant");
	assert.match(
		elite.body,
		/local (?:CLI|process|stdio).*not (?:proof|evidence) of local (?:target )?egress/is,
		"Elite does not confuse a local launcher with a locally-originated target request",
	);
	assert.match(
		elite.body,
		/UNKNOWN[\s\S]*do not (?:use|touch).*target/i,
		"Elite fails closed when a network-capable tool's target egress is unknown",
	);
	assert.match(
		elite.body,
		/Propagate the invariant into every delegation:[\s\S]*scopeRoe[\s\S]*constraints[\s\S]*(?:local\/VPN|local.*VPN)/i,
		"Elite propagates the local/VPN-only boundary into delegated legs",
	);
	assert.doesNotMatch(
		elite.body,
		/\bretr(?:y|ies|ied|ying)\b|\bjitter\b/i,
		"retry policy belongs to Pi's runtime, not the Elite prompt",
	);
});

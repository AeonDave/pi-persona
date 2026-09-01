import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { type ContractDef, contractInstructions, DEFAULT_CONTRACT, extractJsonCandidate, parseAndValidate, parseContract, pinContract, validateAgainst } from "../../../src/core/contract.ts";

test("parseContract reads a contracts/*.contract.json into a ContractDef", () => {
	const r = parseContract(
		JSON.stringify({
			name: "review-verdict",
			fields: { vote: { type: "string", required: true }, confidence: { type: "number", min: 0, max: 1 }, stance: { type: "enum", values: ["approve", "reject"] } },
		}),
	);
	assert.ok(r.ok);
	if (r.ok) {
		assert.equal(r.def.name, "review-verdict");
		assert.equal(r.def.fields.vote?.required, true);
		assert.equal(r.def.fields.confidence?.max, 1);
		assert.deepEqual(r.def.fields.stance?.values, ["approve", "reject"]);
		// round-trips through validation
		assert.equal(parseAndValidate('{"vote":"approve","stance":"approve"}', r.def).ok, true);
	}
});

test("parseContract rejects malformed files (bad JSON, missing name/fields, bad type)", () => {
	assert.equal(parseContract("not json").ok, false);
	assert.equal(parseContract(JSON.stringify({ fields: {} })).ok, false, "missing name");
	assert.equal(parseContract(JSON.stringify({ name: "x" })).ok, false, "missing fields");
	assert.equal(parseContract(JSON.stringify({ name: "x", fields: { a: { type: "wat" } } })).ok, false, "bad field type");
	assert.equal(parseContract(JSON.stringify({ name: "x", fields: { a: { type: "enum" } } })).ok, false, "enum needs values");
});

test("parseAndValidate unwraps fences, validates, and reports a contract error on failure", () => {
	const def: ContractDef = { name: "v", fields: { result: { type: "string", required: true } } };
	const ok = parseAndValidate('```json\n{"result":"hi"}\n```', def);
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.value, { result: "hi" });
	const notJson = parseAndValidate("definitely not json", def);
	assert.equal(notJson.ok, false);
	assert.match(notJson.error ?? "", /contract v failed/);
	const missing = parseAndValidate('{"x":1}', def);
	assert.equal(missing.ok, false);
	assert.match(missing.error ?? "", /result/);
});

test("extractJsonCandidate unwraps fenced / prose-wrapped JSON so JSON.parse survives", () => {
	// The actual magi bug: a member wraps its JSON in a ```json fence → raw JSON.parse throws.
	const fenced = '```json\n{"result": "ship it", "vote": "json", "confidence": 0.95}\n```';
	assert.deepEqual(JSON.parse(extractJsonCandidate(fenced)), { result: "ship it", vote: "json", confidence: 0.95 });
	// Pure JSON is returned untouched.
	assert.equal(extractJsonCandidate('{"a":1}'), '{"a":1}');
	// Fence without a language tag.
	assert.deepEqual(JSON.parse(extractJsonCandidate('```\n{"a":1}\n```')), { a: 1 });
	// Surrounding prose before/after the object.
	assert.deepEqual(JSON.parse(extractJsonCandidate('Here you go:\n{"a":1}\nHope it helps!')), { a: 1 });
	// A fenced array.
	assert.deepEqual(JSON.parse(extractJsonCandidate("```json\n[1, 2, 3]\n```")), [1, 2, 3]);
	// A brace inside a string value must not truncate the object.
	assert.deepEqual(JSON.parse(extractJsonCandidate('{"result": "use } here"}')), { result: "use } here" });
});

test("extractJsonCandidate: prose with braces BEFORE a fenced JSON block (the verifier bug)", () => {
	// Regression: a report quoting code with ${x} or {brace} in prose, followed by a fenced JSON answer.
	// The old regex only unwrapped a fence spanning the ENTIRE output; the fallback then sliced from the
	// first brace found in the prose, yielding invalid JSON and failing a correct leg.
	const proseWithBraces = 'Ran `${x}` interpolation and a {brace} in prose.\n\n```json\n{"result":"ok","confidence":0.9}\n```';
	assert.deepEqual(JSON.parse(extractJsonCandidate(proseWithBraces)), { result: "ok", confidence: 0.9 });

	// Multiple fences: the LAST one is the answer (contract says "prose before it is fine, nothing after").
	const multiFence = '```js\nconst x = { a: 1 };\n```\n\nReport done.\n\n```json\n{"result":"ship it"}\n```';
	assert.deepEqual(JSON.parse(extractJsonCandidate(multiFence)), { result: "ship it" });

	// A markdown table (which contains `|` not braces) before the fenced JSON.
	const tableBeforeFence = '| cmd | code |\n|---|---|\n| a | 0 |\n\n```json\n{"result":"ok"}\n```';
	assert.deepEqual(JSON.parse(extractJsonCandidate(tableBeforeFence)), { result: "ok" });

	// Fenced JSON with trailing prose (the agent accidentally added text after the closing fence).
	const trailingProse = '```json\n{"result":"ok"}\n```\n\nDone.';
	assert.deepEqual(JSON.parse(extractJsonCandidate(trailingProse)), { result: "ok" });
});

test("extractJsonCandidate: balanced scan handles nested/escaped braces in JSON values", () => {
	// Nested braces inside a JSON object value.
	const nested = 'some prose {not json}.\n{"data":{"inner":{"deep":true}}}';
	assert.deepEqual(JSON.parse(extractJsonCandidate(nested)), { data: { inner: { deep: true } } });

	// Prose with braces around a bare JSON object (no fence, braces in both places).
	const bareMixed = 'Code: if (x) { y() }\n\n{"result":"pass"}';
	assert.deepEqual(JSON.parse(extractJsonCandidate(bareMixed)), { result: "pass" });
});

test("extractJsonCandidate: a trailing bracketed token must not shadow the real answer object", () => {
	// A correct answer followed by prose that itself parses as JSON ("[2]") used to be
	// returned as THE candidate: the real object was never tried and the leg failed
	// "expected a JSON object".
	const bracketed = '{"result":"ship it","vote":"x"}\n\nI picked option [2] because of the above.';
	assert.deepEqual(JSON.parse(extractJsonCandidate(bracketed)), { result: "ship it", vote: "x" });
});

test("parseAndValidate walks candidates until one VALIDATES, not just parses", () => {
	// Trailing prose with a bracketed token: "[2]" parses but is not a contract object;
	// the real object behind it is.
	const bracketed = '{"result":"ship it","vote":"x"}\n\nI picked option [2] because of the above.';
	const r = parseAndValidate(bracketed, DEFAULT_CONTRACT);
	assert.equal(r.ok, true);
	assert.equal(r.value?.result, "ship it");

	// Trailing prose with braces: the balanced slice from the last "}" spans into the
	// prose and fails; the earlier balanced object is the answer.
	const braced = '{"result":"ship it"}\n\nDone {thanks}.';
	const r2 = parseAndValidate(braced, DEFAULT_CONTRACT);
	assert.equal(r2.ok, true);
	assert.equal(r2.value?.result, "ship it");

	// A genuinely invalid output still fails, reporting validation errors of the best
	// parseable candidate rather than a later garbage one.
	const wrongShape = '### 1. finding\n\n[{"a":1}]';
	const r3 = parseAndValidate(wrongShape, DEFAULT_CONTRACT);
	assert.equal(r3.ok, false);
	assert.match(r3.error ?? "", /contract default failed/);

	// No parseable JSON at all keeps the classic error.
	const r4 = parseAndValidate("no json here", DEFAULT_CONTRACT);
	assert.equal(r4.ok, false);
	assert.match(r4.error ?? "", /not valid JSON/);
});

test("DEFAULT_CONTRACT requires result and declares the voting/judging fields", () => {
	assert.equal(DEFAULT_CONTRACT.name, "default");
	assert.equal(DEFAULT_CONTRACT.fields.result?.required, true);
	assert.ok(DEFAULT_CONTRACT.fields.stance);
	assert.ok(DEFAULT_CONTRACT.fields.confidence);
});

test("pinContract produces a stable sha256 hash, equal for equal defs", () => {
	const a = pinContract(DEFAULT_CONTRACT);
	const b = pinContract(structuredClone(DEFAULT_CONTRACT));
	assert.match(a.hash, /^[0-9a-f]{64}$/);
	assert.equal(a.hash, b.hash);
	assert.equal(a.name, "default");
});

test("pinContract hash changes when the contract changes", () => {
	const a = pinContract(DEFAULT_CONTRACT);
	const modified = structuredClone(DEFAULT_CONTRACT);
	modified.fields.extra = { type: "string" };
	assert.notEqual(a.hash, pinContract(modified).hash);
});

test("validateAgainst accepts a valid object and rejects non-objects", () => {
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "done" }).ok, true);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, "nope").ok, false);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, ["a"]).ok, false);
});

test("validateAgainst enforces required fields", () => {
	const r = validateAgainst(DEFAULT_CONTRACT, { output: "x" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.includes("result")));
});

test("validateAgainst enforces types, enums, and number bounds", () => {
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: 123 }).ok, false);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "x", stance: "approve" }).ok, true);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "x", stance: "bogus" }).ok, false);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "x", confidence: 0.5 }).ok, true);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "x", confidence: 2 }).ok, false);
	assert.equal(validateAgainst(DEFAULT_CONTRACT, { result: "x", confidence: "high" }).ok, false);
});

test("contractInstructions renders one line per field with type/required/enum/bounds", () => {
	const text = contractInstructions(DEFAULT_CONTRACT);
	assert.match(text, /^--- output contract \(default\) ---/);
	assert.match(text, /- result \(string, required\)/);
	assert.match(text, /- confidence \(number, 0\.\.1\)/);
	assert.match(text, /- stance \(enum, one of: approve \| reject \| revise\)/);
	assert.match(text, /Include every required field/);
	assert.match(text, /BARE option token/, "a contract with a vote field carries the vote-hygiene hint");
	// A member's answer following these instructions round-trips through validation.
	assert.equal(parseAndValidate('prose first…\n{"result":"ok","vote":"a","confidence":0.8}', DEFAULT_CONTRACT).ok, true);
});

test("contractInstructions omits the vote-hygiene hint when the contract has no vote field", () => {
	const def: ContractDef = { name: "plain", fields: { result: { type: "string", required: true } } };
	assert.ok(!contractInstructions(def).includes("BARE option token"));
});

test("contractInstructions renders one-sided bounds as >=/<=", () => {
	const def: ContractDef = { name: "b", fields: { score: { type: "number", min: 0 }, cap: { type: "number", max: 10 } } };
	const text = contractInstructions(def);
	assert.match(text, /- score \(number, >= 0\)/);
	assert.match(text, /- cap \(number, <= 10\)/);
});

test("minLength gates a string field (a non-empty/substantive proof) — parse, validate, instruct", () => {
	const r = parseContract(JSON.stringify({ name: "finding", fields: { proof: { type: "string", required: true, minLength: 12 } } }));
	assert.ok(r.ok);
	if (!r.ok) return;
	assert.equal(r.def.fields.proof?.minLength, 12);
	// present-but-too-short (incl. empty) → rejected; a substantive proof → accepted
	assert.equal(validateAgainst(r.def, { proof: "" }).ok, false);
	assert.equal(validateAgainst(r.def, { proof: "short" }).ok, false);
	assert.equal(validateAgainst(r.def, { proof: "curl … → HTB{live_flag_from_exploit}" }).ok, true);
	// the derived instruction advertises the floor so the agent knows the proof must be real
	assert.match(contractInstructions(r.def), /- proof \(string, required, min 12 chars\)/);
});

test("the shipped finding contract requires live-exploit provenance (a substantive proof)", () => {
	const content = readFileSync(new URL("../../../contracts/finding.contract.json", import.meta.url), "utf-8");
	const r = parseContract(content);
	assert.ok(r.ok, "finding.contract.json parses");
	if (!r.ok) return;
	assert.equal(r.def.name, "finding");
	assert.equal(r.def.fields.result?.required, true);
	assert.equal(r.def.fields.proof?.required, true);
	assert.ok((r.def.fields.proof?.minLength ?? 0) > 0, "proof carries a non-empty floor");
	// a result with no proof is rejected; a result WITH a live-exploit proof passes
	assert.equal(parseAndValidate('{"result":"rooted"}', r.def).ok, false);
	assert.equal(parseAndValidate('{"result":"rooted","proof":"id → uid=0(root) via CVE-2021-4034 pkexec, live"}', r.def).ok, true);
});

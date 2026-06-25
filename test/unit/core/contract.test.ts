import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONTRACT, pinContract, validateAgainst } from "../../../src/core/contract.ts";

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

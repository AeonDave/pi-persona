import { test } from "node:test";
import assert from "node:assert/strict";

import { type ContractDef, DEFAULT_CONTRACT, contractInstructions, parseAndValidate } from "../../../src/core/contract.ts";

test("a hostile oversized key cannot inflate the contract failure message", () => {
	const reply = `{"result":"x","${"k".repeat(400_000)}":{"__proto__":1}}`;
	const r = parseAndValidate(reply, DEFAULT_CONTRACT);
	assert.equal(r.ok, false);
	assert.ok(r.error!.length <= 2_100, `error was ${r.error!.length} chars`);
	assert.match(r.error!, /forbidden key/);
});

test("top-level non-identifier fields print as a quoted name, not a bracket path", () => {
	const def: ContractDef = {
		name: "risk",
		fields: { "risk-level": { type: "string", required: true }, plain: { type: "string" } },
	};
	const text = contractInstructions(def);
	assert.match(text, /^- "risk-level" \(string, required\)$/m);
	assert.match(text, /^- plain \(string\)$/m);
	const r = parseAndValidate("{}", def);
	assert.match(r.error!, /missing required field: "risk-level"/);
});

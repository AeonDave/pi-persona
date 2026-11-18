import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { type ContractDef, contractInstructions, parseAndValidate, parseContract, pinContract, validateAgainst } from "../../../src/core/contract.ts";

const findingsSchema = () => ({
	name: "findings",
	fields: {
		result: { type: "string", required: true },
		findings: {
			type: "array", required: true, maxItems: 50,
			items: { type: "object", fields: {
				file: { type: "string", required: true, minLength: 1 },
				line: { type: "integer", required: true, min: 1 },
				severity: { type: "enum", required: true, values: ["low", "medium", "high"] },
				evidence: { type: "string", required: true, minLength: 12 },
			} },
		},
	},
});

const validOutput = () => ({ result: "one finding", findings: [{ file: "src/app.ts", line: 12, severity: "high", evidence: "request /demo returned 500" }] });
const def = () => findingsSchema() as unknown as ContractDef;

test("recursive contracts parse, validate records and preserve ordinary extra fields", () => {
	const parsed = parseContract(JSON.stringify(findingsSchema()));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const value = { ...validOutput(), note: { reviewed: true } };
	assert.deepEqual(validateAgainst(parsed.def, value), { ok: true, errors: [], value });
	assert.equal(validateAgainst(parsed.def, { result: "none", findings: [] }).ok, true);
	assert.equal(parseAndValidate(`Report.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, parsed.def).ok, true);
});

test("recursive failures identify the exact field or array index", () => {
	const wrong = { result: "bad", findings: [{ file: "", line: 1.5, severity: "critical", evidence: null }] };
	const result = validateAgainst(def(), wrong);
	assert.equal(result.ok, false);
	assert.deepEqual(result.errors, [
		"field findings[0].file must be at least 1 characters",
		"field findings[0].line must be an integer",
		"field findings[0].severity must be one of: low, medium, high",
		"missing required field: findings[0].evidence",
	]);
	assert.match(parseAndValidate(JSON.stringify(wrong), def()).error ?? "", /findings\[0\]\.line/);
	assert.match(validateAgainst(def(), { result: "bad", findings: [null] }).errors.join(";"), /findings\[0\] must be an object/);
});

test("a complete JSON reply cannot bypass its contract through a matching inner object", () => {
	const invalid = { result: "outer", findings: [{ line: 1.5 }], quoted: validOutput() };
	const parsed = parseAndValidate(JSON.stringify(invalid), def());
	assert.equal(parsed.ok, false);
	assert.match(parsed.error ?? "", /findings\[0\]\.line must be an integer/);
	assert.equal(parseAndValidate(JSON.stringify([validOutput()]), def()).ok, false);
	assert.equal(parseAndValidate(`{"result":"outer","findings":[],"__proto__":{},"quoted":${JSON.stringify(validOutput())}}`, def()).ok, false);
});

test("a complete fenced or prose-wrapped JSON object cannot be replaced by its nested excerpt", () => {
	const invalid = JSON.stringify({ result: "outer", findings: [{ line: 1.5 }], quoted: validOutput() });
	for (const output of [`\`\`\`json\n${invalid}\n\`\`\``, `Report:\n${invalid}`]) {
		const parsed = parseAndValidate(output, def());
		assert.equal(parsed.ok, false);
		assert.match(parsed.error ?? "", /findings\[0\]\.line must be an integer/);
	}
	const separate = `Quoted invalid object: ${invalid}\n\nAnswer:\n${JSON.stringify(validOutput())}`;
	assert.equal(parseAndValidate(separate, def()).ok, true, "distinct complete answer objects remain recoverable");
});

test("arrays of arrays and optional nested objects use the same validator", () => {
	const parsed = parseContract(JSON.stringify({ name: "matrix", fields: {
		matrix: { type: "array", required: true, minItems: 1, maxItems: 2, items: { type: "array", minItems: 1, items: { type: "boolean" } } },
		meta: { type: "object", fields: { score: { type: "number", min: 0, max: 1 } } },
	} }));
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	assert.equal(validateAgainst(parsed.def, { matrix: [[true, false]] }).ok, true);
	assert.equal(validateAgainst(parsed.def, { matrix: [[true]], meta: { score: 0.5 } }).ok, true);
	assert.match(validateAgainst(parsed.def, { matrix: [[true, 1]] }).errors.join(";"), /matrix\[0\]\[1\] must be a boolean/);
	assert.match(validateAgainst(parsed.def, { matrix: [] }).errors.join(";"), /matrix must contain at least 1 items/);
	assert.match(validateAgainst(parsed.def, { matrix: [[true], [true], [true]] }).errors.join(";"), /matrix must contain at most 2 items/);
	assert.match(validateAgainst(parsed.def, { matrix: [[]] }).errors.join(";"), /matrix\[0\] must contain at least 1 items/);
});

test("schema validation rejects malformed and misplaced constraints with nested paths", () => {
	const invalid = [
		{ type: "array" }, { type: "object" }, { type: "string", required: "yes" },
		{ type: "number", min: "1" }, { type: "number", min: 3, max: 2 },
		{ type: "string", minLength: -1 }, { type: "string", minLength: 1.5 },
		{ type: "enum", values: ["x", 2] }, { type: "boolean", min: 0 },
		{ type: "string", fields: {} }, { type: "array", items: { type: "string" }, maxItems: 1025 },
		{ type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 },
		{ type: "array", items: { type: "string" }, minItems: 0.5 },
		{ type: "array", items: { type: "wrong" } }, { type: "string", typo: true },
	];
	for (const field of invalid) {
		const parsed = parseContract(JSON.stringify({ name: "bad", fields: { nested: { type: "object", fields: { broken: field } } } }));
		assert.equal(parsed.ok, false, JSON.stringify(field));
		if (!parsed.ok) assert.match(parsed.error, /nested\.broken/);
	}
	const nonFinite = { name: "bad", fields: { x: { type: "number", min: Infinity } } } as ContractDef;
	assert.equal(validateAgainst(nonFinite, { x: 1 }).ok, false);
	assert.throws(() => pinContract(nonFinite), /finite/);
});

test("schema recursion, field count and enum size have hard bounds", () => {
	let field: unknown = { type: "string" };
	for (let i = 0; i < 10; i++) field = { type: "array", items: field };
	for (const fields of [
		{ deep: field },
		Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, { type: "string" }])),
		{ choice: { type: "enum", values: Array.from({ length: 129 }, (_, i) => `${i}`) } },
	]) assert.equal(parseContract(JSON.stringify({ name: "bounded", fields })).ok, false);
});

test("hostile keys, cycles, accessors and non-JSON objects fail closed without throwing", () => {
	for (const key of ["__proto__", "constructor", "prototype"]) {
		assert.equal(parseContract(`{"name":"bad","fields":{"${key}":{"type":"string"}}}`).ok, false);
		assert.equal(validateAgainst(def(), JSON.parse(`{"result":"x","findings":[],"extra":{"${key}":true}}`)).ok, false);
	}
	const cyclic = validOutput() as Record<string, unknown>;
	cyclic.self = cyclic;
	assert.equal(validateAgainst(def(), cyclic).ok, false);
	const schema = def();
	schema.fields.loop = { type: "object", fields: schema.fields } as never;
	assert.throws(() => pinContract(schema), /cycl|depth/i);
	assert.equal(validateAgainst(schema, validOutput()).ok, false);
	assert.equal(validateAgainst(def(), { ...validOutput(), extra: new Date() }).ok, false);
	assert.equal(validateAgainst(def(), { ...validOutput(), extra: Infinity }).ok, false);
	const accessor = Object.defineProperty(validOutput(), "extra", { enumerable: true, get() { throw new Error("must not run"); } });
	assert.doesNotThrow(() => assert.equal(validateAgainst(def(), accessor).ok, false));
});

test("rejected programmatic schema diagnostics never execute its name accessor", () => {
	let getterCalls = 0;
	const schema = Object.defineProperty({ fields: {} }, "name", { enumerable: true, get() { getterCalls++; throw new Error("must not run"); } }) as ContractDef;
	const result = parseAndValidate("{}", schema);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /name must be a JSON data property/);
	assert.equal(getterCalls, 0);
});

test("output size, recursion and errors are bounded even in unknown extra fields", () => {
	assert.equal(validateAgainst(def(), { result: "large", findings: Array.from({ length: 1025 }, () => validOutput().findings[0]) }).ok, false);
	const wrong = { result: "wrong", findings: Array.from({ length: 50 }, () => ({})) };
	assert.ok(validateAgainst(def(), wrong).errors.length <= 32);
	let extra: unknown = true;
	for (let i = 0; i < 40; i++) extra = { child: extra };
	assert.equal(validateAgainst(def(), { ...validOutput(), extra }).ok, false);
	assert.equal(validateAgainst(def(), { ...validOutput(), extra: Array.from({ length: 1024 }, () => Array(16).fill(0)) }).ok, false);
});

test("nested instructions describe required item fields and pinned contracts are immutable snapshots", () => {
	const schema = def();
	const pinned = pinContract(schema);
	const before = contractInstructions(pinned.def);
	assert.match(before, /findings \(array, required, max 50 items\)/);
	assert.match(before, /findings\[\] \(object\)/);
	assert.match(before, /findings\[\]\.line \(integer, required, >= 1\)/);
	assert.match(before, /findings\[\]\.severity \(enum, required, one of: low \| medium \| high\)/);
	assert.equal(Object.isFrozen(pinned.def), true);
	assert.equal(Object.isFrozen(pinned.def.fields.findings), true);
	const items = (schema.fields.findings as unknown as { items: { fields: Record<string, { min?: number; values?: string[] }> } }).items;
	items.fields.line!.min = 100;
	items.fields.severity!.values!.push("critical");
	assert.equal(contractInstructions(pinned.def), before);
	assert.equal(validateAgainst(pinned.def, validOutput()).ok, true);
	assert.notEqual(pinContract(schema).hash, pinned.hash);
});

test("the optional shipped findings contract validates file, integer line, severity and evidence", () => {
	const parsed = parseContract(readFileSync(new URL("../../../contracts/findings.contract.json", import.meta.url), "utf8"));
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	assert.equal(parsed.def.name, "findings");
	assert.equal(validateAgainst(parsed.def, validOutput()).ok, true);
	assert.equal(validateAgainst(parsed.def, { result: "none", findings: [] }).ok, true);
	assert.equal(validateAgainst(parsed.def, { result: "bad", findings: [{ file: "a", line: 0, severity: "bogus", evidence: "" }] }).ok, false);
});

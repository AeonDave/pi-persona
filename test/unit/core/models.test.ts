import { test } from "node:test";
import assert from "node:assert/strict";

import { type ModelLite, resolveModelRef } from "../../../src/core/models.ts";

const MODELS: ModelLite[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "amazon-bedrock", id: "claude-sonnet-4-6" },
	{ provider: "openrouter", id: "owl-alpha" },
	{ provider: "openrouter", id: "qwen-plus" },
];

test("an exact provider/id is returned unchanged", () => {
	const r = resolveModelRef("anthropic/claude-sonnet-4-6", MODELS);
	assert.deepEqual(r, { ok: true, ref: "anthropic/claude-sonnet-4-6" });
});

test("a unique substring canonicalises to provider/id (e.g. 'owl-alpha')", () => {
	assert.deepEqual(resolveModelRef("owl-alpha", MODELS), { ok: true, ref: "openrouter/owl-alpha" });
	assert.deepEqual(resolveModelRef("owl", MODELS), { ok: true, ref: "openrouter/owl-alpha" });
});

test("an ambiguous name (same id across providers) fails with the candidates", () => {
	const r = resolveModelRef("claude-sonnet-4-6", MODELS);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "ambiguous");
		assert.deepEqual(r.candidates.sort(), ["amazon-bedrock/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"]);
	}
});

test("an unknown name fails 'unknown' with the full list", () => {
	const r = resolveModelRef("gpt-9-ultra", MODELS);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "unknown");
		assert.equal(r.candidates.length, 4);
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { type ModelLite, providerFallbacks, resolveModelRef } from "../../../src/core/models.ts";

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

test("an ambiguous name (same id across providers) fails with the candidates when no provider is preferred", () => {
	const r = resolveModelRef("claude-sonnet-4-6", MODELS);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "ambiguous");
		assert.deepEqual(r.candidates.sort(), ["amazon-bedrock/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"]);
	}
});

test("an ambiguous name resolves to the loader/session provider when one is given", () => {
	// "sonnet" exists under anthropic + bedrock; the session provider is anthropic → it wins.
	assert.deepEqual(resolveModelRef("sonnet", MODELS, "anthropic"), { ok: true, ref: "anthropic/claude-sonnet-4-6" });
	assert.deepEqual(resolveModelRef("claude-sonnet-4-6", MODELS, "anthropic"), {
		ok: true,
		ref: "anthropic/claude-sonnet-4-6",
	});
});

test("the preferred provider's matches are listed first when still ambiguous", () => {
	const models = [
		{ provider: "amazon-bedrock", id: "claude-sonnet-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
	];
	const r = resolveModelRef("sonnet", models, "anthropic"); // two anthropic sonnets → ambiguous, anthropic-only
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.candidates.every((c) => c.startsWith("anthropic/")), "narrowed to the preferred provider");
		assert.equal(r.candidates.length, 2);
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

test("providerFallbacks lists the SAME id under other providers, excluding the failed ref", () => {
	// anthropic failed → the same sonnet id is also on bedrock → reroute there.
	assert.deepEqual(providerFallbacks("anthropic/claude-sonnet-4-6", MODELS), ["amazon-bedrock/claude-sonnet-4-6"]);
	// bedrock failed → anthropic is the alternate.
	assert.deepEqual(providerFallbacks("amazon-bedrock/claude-sonnet-4-6", MODELS), ["anthropic/claude-sonnet-4-6"]);
});

test("providerFallbacks is empty when the id exists under only one provider", () => {
	assert.deepEqual(providerFallbacks("openrouter/owl-alpha", MODELS), []);
});

test("providerFallbacks puts the preferred provider first among alternates", () => {
	const models: ModelLite[] = [
		{ provider: "amazon-bedrock", id: "m" },
		{ provider: "copilot", id: "m" },
		{ provider: "anthropic", id: "m" },
	];
	// the failed one is copilot; prefer anthropic → it leads, bedrock follows.
	assert.deepEqual(providerFallbacks("copilot/m", models, "anthropic"), ["anthropic/m", "amazon-bedrock/m"]);
});

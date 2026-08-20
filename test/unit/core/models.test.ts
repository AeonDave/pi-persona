import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_MODEL_ROUTING_POLICY,
	type ModelLite,
	providerFallbacks,
	resolveModelRef,
} from "../../../src/core/models.ts";

const MODELS: ModelLite[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "amazon-bedrock", id: "claude-sonnet-4-6" },
	{ provider: "openrouter", id: "owl-alpha" },
	{ provider: "openrouter", id: "qwen-plus" },
];
const PERMISSIVE_POLICY = { rules: [] };

test("an exact provider/id is returned unchanged", () => {
	const r = resolveModelRef("anthropic/claude-sonnet-4-6", MODELS, undefined, PERMISSIVE_POLICY);
	assert.deepEqual(r, { ok: true, ref: "anthropic/claude-sonnet-4-6" });
});

test("a unique substring canonicalises to provider/id (e.g. 'owl-alpha')", () => {
	assert.deepEqual(resolveModelRef("owl-alpha", MODELS), { ok: true, ref: "openrouter/owl-alpha" });
	assert.deepEqual(resolveModelRef("owl", MODELS), { ok: true, ref: "openrouter/owl-alpha" });
});

test("an ambiguous name (same id across providers) fails with the candidates when no provider is preferred", () => {
	const r = resolveModelRef("claude-sonnet-4-6", MODELS, undefined, PERMISSIVE_POLICY);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "ambiguous");
		assert.deepEqual(r.candidates.sort(), ["amazon-bedrock/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"]);
	}
});

test("an ambiguous name resolves to the loader/session provider when one is given", () => {
	// "sonnet" exists under anthropic + bedrock; the session provider is anthropic → it wins.
	assert.deepEqual(resolveModelRef("sonnet", MODELS, "anthropic", PERMISSIVE_POLICY), { ok: true, ref: "anthropic/claude-sonnet-4-6" });
	assert.deepEqual(resolveModelRef("claude-sonnet-4-6", MODELS, "anthropic", PERMISSIVE_POLICY), {
		ok: true,
		ref: "anthropic/claude-sonnet-4-6",
	});
});

test("same model line, several versions on the session provider → newest wins (no models lookup)", () => {
	const models = [
		{ provider: "amazon-bedrock", id: "claude-sonnet-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4" },
	];
	// "sonnet" is three anthropic versions differing only by version → the newest is the
	// natural pick, not an ambiguous rejection that forces a `models` call.
	assert.deepEqual(resolveModelRef("sonnet", models, "anthropic", PERMISSIVE_POLICY), { ok: true, ref: "anthropic/claude-sonnet-4-6" });
});

test("distinct model lines on the session provider STAY ambiguous (no silent cross-family pick)", () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
		{ provider: "anthropic", id: "claude-opus-4-8" },
	];
	// "claude" matches both families on the same provider — different lines, so the newest-
	// version shortcut must NOT fire; the caller has to disambiguate the family.
	const r = resolveModelRef("claude", models, "anthropic", PERMISSIVE_POLICY);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "ambiguous");
		assert.equal(r.candidates.length, 2);
	}
});

test("cross-provider ambiguity is never auto-resolved by version (safety: only same-provider)", () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "openrouter", id: "claude-sonnet-4-6" },
	];
	// No preferred provider → the version shortcut (which is session-provider-scoped) can't
	// fire, so a name spanning providers stays ambiguous rather than picking a route for you.
	const r = resolveModelRef("sonnet", models, undefined, PERMISSIVE_POLICY);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "ambiguous");
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
	assert.deepEqual(providerFallbacks("anthropic/claude-sonnet-4-6", MODELS, undefined, PERMISSIVE_POLICY), ["amazon-bedrock/claude-sonnet-4-6"]);
	// bedrock failed → anthropic is the alternate.
	assert.deepEqual(providerFallbacks("amazon-bedrock/claude-sonnet-4-6", MODELS, undefined, PERMISSIVE_POLICY), ["anthropic/claude-sonnet-4-6"]);
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

test("paid OpenAI model routing never falls back to OpenCode or OpenRouter", () => {
	const models: ModelLite[] = [
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
		{ provider: "opencode", id: "gpt-5.6-luna" },
		{ provider: "openrouter", id: "gpt-5.6-luna" },
	];
	assert.deepEqual(providerFallbacks("openai-codex/gpt-5.6-luna", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), []);
	assert.deepEqual(resolveModelRef("gpt-5.6-luna", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), {
		ok: true,
		ref: "openai-codex/gpt-5.6-luna",
	});
	assert.deepEqual(resolveModelRef("opencode/gpt-5.6-luna", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), {
		ok: true,
		ref: "opencode/gpt-5.6-luna",
	});
});

test("Anthropic model routing is pinned to claude-pro-max-native", () => {
	const models: ModelLite[] = [
		{ provider: "claude-pro-max-native", id: "claude-opus-4-8" },
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "openrouter", id: "claude-opus-4-8" },
	];
	assert.deepEqual(providerFallbacks("claude-pro-max-native/claude-opus-4-8", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), []);
	assert.deepEqual(resolveModelRef("claude-opus-4-8", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), {
		ok: true,
		ref: "claude-pro-max-native/claude-opus-4-8",
	});
	assert.deepEqual(resolveModelRef("anthropic/claude-opus-4-8", models, undefined, DEFAULT_MODEL_ROUTING_POLICY), {
		ok: true,
		ref: "anthropic/claude-opus-4-8",
	});
});

test("model routing policy is data-driven and can be overridden", () => {
	const models: ModelLite[] = [
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
		{ provider: "opencode", id: "gpt-5.6-luna" },
	];
	const permissive = { rules: [] };
	assert.deepEqual(providerFallbacks("openai-codex/gpt-5.6-luna", models, undefined, permissive), ["opencode/gpt-5.6-luna"]);
	assert.ok(DEFAULT_MODEL_ROUTING_POLICY.rules.length > 0);
});

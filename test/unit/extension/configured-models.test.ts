import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { configuredModels } from "../../../src/extension/engine.ts";

type ModelRef = { provider: string; id: string };

function context(registry: object, model?: ModelRef): ExtensionContext {
	return { modelRegistry: registry, ...(model ? { model } : {}) } as unknown as ExtensionContext;
}

test("configuredModels keeps host availability at model granularity within the active provider", () => {
	const active = { provider: "subscription", id: "current" };
	const hidden = { provider: active.provider, id: "account-denied" };
	assert.deepEqual(configuredModels(context({ getAll: () => [active, hidden], getAvailable: () => [active] }, active)), [active]);
});

test("a registered provider id alone never restores its entire built-in catalog", () => {
	const hidden = { provider: "registered", id: "inherited-unavailable" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [hidden], getAvailable: () => [], getRegisteredProviderIds: () => [hidden.provider],
	})), []);
});

test("an absent native bridge restores only its explicitly declared chat models", () => {
	const curated = { provider: "native", id: "curated" };
	const inherited = { provider: "native", id: "inherited" };
	const image = { provider: "native", id: "image-only" };
	const available = { provider: "other", id: "ready" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [available, curated, inherited, image], getAvailable: () => [available],
		getRegisteredProviderIds: () => [curated.provider],
		getRegisteredProviderConfig: () => ({ models: [{ id: curated.id }, { id: image.id, type: "image" }, { id: "not-in-registry" }] }),
	})), [available, curated]);
});

test("a native provider catalog survives an omitted auth snapshot without restoring unrelated same-provider rows", () => {
	const curated = { provider: "native", id: "curated" };
	const inherited = { provider: "native", id: "inherited" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [curated, inherited], getAvailable: () => [],
		getRegisteredProviderIds: () => [curated.provider],
		getRegisteredNativeProvider: () => ({ getModels: () => [curated, { provider: "foreign", id: inherited.id }] }),
	})), [curated]);
});

test("extension compatibility never revives filtered models once that provider has an availability snapshot", () => {
	const accepted = { provider: "native", id: "accepted" };
	const denied = { provider: "native", id: "denied" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [accepted, denied], getAvailable: () => [accepted],
		getRegisteredProviderIds: () => [accepted.provider],
		getRegisteredProviderConfig: () => ({ models: [{ id: accepted.id }, { id: denied.id }] }),
		getRegisteredNativeProvider: () => ({ getModels: () => [accepted, denied] }),
	})), [accepted]);
});

test("a credential-filtered provider with zero available models stays empty despite its explicit catalog", () => {
	const denied = { provider: "native", id: "denied" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [denied], getAvailable: () => [], getRegisteredProviderIds: () => [denied.provider],
		getProvider: () => ({ filterModels: () => [] }),
		getRegisteredProviderConfig: () => ({ models: [{ id: denied.id }] }),
		getRegisteredNativeProvider: () => ({ getModels: () => [denied] }),
	})), []);
});

test("only the exact active model is restored when it is absent from availability", () => {
	const active = { provider: "subscription", id: "current" };
	const hidden = { provider: active.provider, id: "account-denied" };
	assert.deepEqual(configuredModels(context({ getAll: () => [active, hidden], getAvailable: () => [] }, active)), [active]);
});

test("throwing or absent legacy availability APIs retain the historical catalog fallback", () => {
	const known = { provider: "legacy", id: "known" };
	assert.deepEqual(configuredModels(context({ getAll: () => [known] })), [known]);
	assert.deepEqual(configuredModels(context({ getAll: () => [known], getAvailable: () => { throw new Error("legacy facade"); } })), [known]);
});

test("broken registration metadata cannot lose available models or prevent another bridge from being included", () => {
	const available = { provider: "ready", id: "model" };
	const curated = { provider: "good", id: "curated" };
	assert.deepEqual(configuredModels(context({
		getAll: () => [available, curated], getAvailable: () => [available], getRegisteredProviderIds: () => ["broken", "good"],
		getRegisteredProviderConfig: (provider: string) => {
			if (provider === "broken") throw new Error("broken extension");
			return { models: [{ id: curated.id }] };
		},
	})), [available, curated]);
});

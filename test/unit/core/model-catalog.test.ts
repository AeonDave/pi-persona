import { test } from "node:test";
import assert from "node:assert/strict";

import { orderModelCandidates, shortlistModels } from "../../../src/core/model-catalog.ts";
import type { ModelLite } from "../../../src/core/models.ts";

const model = (id: string, provider = "mine"): ModelLite => ({ provider, id });
const refs = (models: readonly ModelLite[]) => models.map((m) => `${m.provider}/${m.id}`);

test("shortlist retains the exact active model and the newer representative without changing provider pins", () => {
	const models = [model("gpt-5-sol"), model("gpt-6-sol"), model("gpt-6.1-sol"), model("gpt-99-sol", "other")];
	assert.deepEqual(refs(shortlistModels(models, model("gpt-5-sol"))), ["mine/gpt-5-sol", "mine/gpt-6.1-sol", "other/gpt-99-sol"]);
	assert.deepEqual(refs(shortlistModels(models, model("not-in-catalog"))), ["mine/gpt-6.1-sol", "other/gpt-99-sol"], "an absent active model is never invented");
});

test("shortlist compares numeric generations across lanes before their names", () => {
	const models = ["gpt-4", "gpt-4o", "gpt-4-turbo", "gpt-5-mini", "gpt-6-sol", "gpt-6-luna", "gpt-9-sol", "gpt-10-sol"].map((id) => model(id));
	assert.deepEqual(refs(shortlistModels(models)), ["mine/gpt-10-sol", "mine/gpt-6-luna", "mine/gpt-5-mini", "mine/gpt-4", "mine/gpt-4o", "mine/gpt-4-turbo"]);
});

test("shortlist removes snapshot dates before version comparison and prefers undated same-version aliases", () => {
	const models = [
		model("gpt-2-2029-12-31"), model("gpt-3"),
		model("claude-sonnet-4-5-20261022"), model("claude-sonnet-4-6"),
		model("gpt-4o-2024-08-06"), model("gpt-4o-2024-11-20"), model("gpt-4o"),
		model("other-2-2024-01-01"), model("other-2-2025-01-01"),
	];
	assert.deepEqual(new Set(refs(shortlistModels(models))), new Set([
		"mine/gpt-3", "mine/claude-sonnet-4-6", "mine/gpt-4o", "mine/other-2-2025-01-01",
	]));
});

test("shortlist preserves named tiers, numeric size lanes and opaque aliases", () => {
	const ids = [
		"claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5",
		"gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5-mini", "gpt-5-nano",
		"llama-3.1-8b-instruct", "llama-3.2-8b-instruct", "llama-3.1-70b-instruct",
		"named-latest", "opaque-alpha", "opaque-beta",
	];
	const selected = refs(shortlistModels(ids.map((id) => model(id))));
	assert.equal(selected.length, ids.length - 1);
	for (const id of ids.filter((id) => id !== "llama-3.1-8b-instruct")) assert.ok(selected.includes(`mine/${id}`), id);
});

test("shortlist is bounded and shuffle-stable with an active model beyond the old caps, without mutation", () => {
	const models = Array.from({ length: 460 }, (_, i) => Object.freeze(model(`opaque-${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`)));
	const active = models.at(-1)!;
	const before = [...models];
	const selected = shortlistModels(Object.freeze(models), active, 4);
	assert.equal(selected.length, 4);
	assert.deepEqual(selected[0], active);
	assert.deepEqual(shortlistModels([...models].reverse(), active, 4), selected);
	assert.deepEqual(shortlistModels([...models.slice(100), ...models.slice(0, 100)], active, 4), selected);
	assert.deepEqual(models, before);
	assert.equal(shortlistModels(models, active).length, 40);
});

test("shortlist deduplicates exact refs, preserves opaque ids and obeys empty/zero limits", () => {
	const models = [model("zeta"), model("alpha"), model("alpha"), model("beta", "aaa")];
	assert.deepEqual(refs(shortlistModels(models)), ["aaa/beta", "mine/alpha", "mine/zeta"]);
	assert.deepEqual(refs(shortlistModels(models, model("missing"))), ["mine/alpha", "mine/zeta", "aaa/beta"]);
	assert.deepEqual(shortlistModels([], model("alpha")), []);
	assert.deepEqual(shortlistModels(models, model("alpha"), 0), []);
	assert.deepEqual(refs(shortlistModels(models, model("alpha"), 1)), ["mine/alpha"]);
});

test("candidate ordering retains an active match beyond the query cap and every older version", () => {
	const models = [...Array.from({ length: 459 }, (_, i) => model(`gpt-${i + 2}-sol`)), model("gpt-1-sol")];
	const active = models.at(-1)!;
	const ordered = orderModelCandidates(models, active);
	assert.equal(ordered.length, models.length, "search matches never collapse into representatives");
	assert.deepEqual(ordered[0], active);
	assert.deepEqual(ordered[1], model("gpt-460-sol"));
	assert.ok(ordered.slice(0, 40).includes(active), "a broad query still shows the exact active match");
	assert.deepEqual(new Set(refs(ordered)), new Set(refs(models)), "older matched versions remain searchable");
});

test("candidate ordering preserves exact snapshots and uses the same numeric/provider policy as shortlists", () => {
	const models = [
		model("gpt-3-sol", "aaa"), model("gpt-3-sol-20251231"), model("gpt-3-sol"),
		model("gpt-3-sol-2025-01-01"), model("gpt-10-sol"), model("gpt-4-luna"),
		model("gpt-10-sol"), model("opaque-beta"), model("opaque-alpha"),
	];
	const before = [...models];
	const active = model("gpt-3-sol-2025-01-01");
	const expected = [
		"mine/gpt-3-sol-2025-01-01", "mine/gpt-10-sol", "mine/gpt-4-luna", "mine/gpt-3-sol",
		"mine/gpt-3-sol-20251231", "mine/opaque-alpha", "mine/opaque-beta", "aaa/gpt-3-sol",
	];
	assert.deepEqual(refs(orderModelCandidates(Object.freeze(models), active)), expected);
	assert.deepEqual(refs(orderModelCandidates([...models].reverse(), active)), expected, "input order cannot change query ranking");
	assert.deepEqual(models, before, "ranking does not mutate the catalog");
	assert.deepEqual(orderModelCandidates([], active), []);
	assert.deepEqual(refs(orderModelCandidates([model("gpt-2-sol"), model("gpt-10-sol")], model("missing"))), ["mine/gpt-10-sol", "mine/gpt-2-sol"], "an absent active ref is not inserted");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { orderModelCandidates, recommendModels, shortlistModels } from "../../../src/core/model-catalog.ts";
import { modelCostTiers, type ModelCostMetadata } from "../../../src/core/model-tier.ts";
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

test("embedded valid snapshot dates never outrank model generations or erase adapter versions", () => {
	const older = model("anthropic.claude-sonnet-4-20250514-v1:0", "gateway");
	const newer = model("anthropic.claude-sonnet-4-5-20250929-v1:0", "gateway");
	assert.deepEqual(shortlistModels([older, newer]), [newer]);
	assert.deepEqual(orderModelCandidates([older, newer]), [newer, older], "full search retains both exact refs");
	const adapterV2 = model("anthropic.claude-sonnet-4-5-20240101-v2:0", "gateway");
	assert.deepEqual(shortlistModels([newer, adapterV2]), [adapterV2], "the v2:0 suffix remains part of the version tuple");
	const prefixedV2 = model("v2:0-line-4-20240101");
	const prefixedV1 = model("v1:0-line-4-20250101");
	assert.deepEqual(shortlistModels([prefixedV1, prefixedV2]), [prefixedV2], "numeric adapter prefixes remain intact too");
});

test("embedded snapshot dates rank only after versions and keep undated aliases preferred", () => {
	const older = model("line-4-2024-01-01-v1:0");
	const newer = model("line-4-20250101-v1:0");
	const alias = model("line-4-v1:0");
	assert.deepEqual(shortlistModels([older, newer]), [newer]);
	assert.deepEqual(shortlistModels([older, newer, alias]), [alias]);
	assert.deepEqual(orderModelCandidates([older, alias, newer]), [alias, newer, older]);
	assert.deepEqual(shortlistModels([model("20250101-line-4-v1:0"), model("line-5-v1:0")]), [model("line-5-v1:0")], "a leading date token cannot become the primary version");
});

test("invalid calendar dates and ordinary dotted numeric versions remain version tokens", () => {
	for (const id of ["line-4-20250229-v1:0", "line-4-20251301-v1:0", "line-4-2025-04-31-v1:0"]) {
		const invalid = model(id);
		assert.deepEqual(shortlistModels([model("line-4-10-v1:0"), invalid]), [invalid], id);
	}
	const dotted = model("line-2025.05.14-v1:0");
	assert.deepEqual(shortlistModels([model("line-5-v1:0"), dotted]), [dotted], "a dotted release tuple is not a calendar-date token");
});

test("a truncated provider shortlist favors the active root then rotates roots instead of filling an alphabetical chunk", () => {
	const alpha = Array.from({ length: 45 }, (_, i) => model(`alpha/lane-${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}-1`, "gateway"));
	const active = model("zeta/working-1", "gateway");
	const models = [...alpha, model("beta/line-1", "gateway"), model("zeta/working-2", "gateway"), model("zeta/other-1", "gateway"), active];
	const before = [...models];
	const selected = shortlistModels(Object.freeze(models), active, 6);
	assert.deepEqual(refs(selected), [
		"gateway/zeta/working-1", "gateway/zeta/working-2", "gateway/alpha/lane-aa-1",
		"gateway/beta/line-1", "gateway/zeta/other-1", "gateway/alpha/lane-ab-1",
	]);
	assert.deepEqual(shortlistModels([...models].reverse(), active, 6), selected, "root admission is shuffle-stable");
	assert.deepEqual(models, before, "rotating roots does not mutate the catalog");
	const forty = refs(shortlistModels(models, active));
	assert.equal(forty.length, 40);
	assert.ok(forty.includes("gateway/beta/line-1"), "a large alphabetically early root cannot consume all forty slots");
	assert.ok(forty.includes("gateway/zeta/working-2"), "the active vendor's latest representative is admitted too");
	assert.deepEqual(new Set(refs(orderModelCandidates(models, active))), new Set(refs(models)), "full query ordering still retains every original model");
});

test("root rotation keeps native ordering when it fits and defines active-first behavior under small caps", () => {
	const active = model("gpt-6.1-sol");
	const models = [model("o4-mini"), model("gpt-5-mini"), model("gpt-6-astra"), active];
	assert.deepEqual(refs(shortlistModels(models, active)), ["mine/gpt-6.1-sol", "mine/gpt-6-astra", "mine/gpt-5-mini", "mine/o4-mini"], "an unsaturated native catalog retains its established numeric ordering");
	assert.deepEqual(refs(shortlistModels(models, active, 1)), ["mine/gpt-6.1-sol"]);
	assert.deepEqual(refs(shortlistModels(models, active, 2)), ["mine/gpt-6.1-sol", "mine/gpt-6-astra"]);
	assert.deepEqual(refs(shortlistModels(models, active, 3)), ["mine/gpt-6.1-sol", "mine/gpt-6-astra", "mine/o4-mini"], "a saturated multi-root native catalog shares the same generic fairness policy");
});

test("provider priority remains outside root rotation, with fair admission even without an active model", () => {
	const early = Array.from({ length: 45 }, (_, i) => model(`alpha/lane-${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}-1`, "gateway"));
	const tail = [model("beta/line-1", "gateway"), model("zeta/line-1", "gateway")];
	assert.deepEqual(refs(shortlistModels([...early, ...tail], undefined, 3)), ["gateway/alpha/lane-aa-1", "gateway/beta/line-1", "gateway/zeta/line-1"]);
	const active = model("zeta/working-1", "gateway");
	const other = model("independent-1", "aaa");
	assert.ok(shortlistModels([other, ...early, ...tail, active], active, 3).every((m) => m.provider === "gateway"), "root balancing never displaces the preferred provider");
	assert.deepEqual(refs(shortlistModels([other, ...early, ...tail], undefined, 3)), ["aaa/independent-1", "gateway/alpha/lane-aa-1", "gateway/beta/line-1"], "each provider balances against its remaining slots");
});

const priced = (id: string, price: number, provider = "mine"): ModelCostMetadata => ({ provider, id, cost: { input: price / 2, output: price / 2 } });

test("recommendations keep the working model and nearby generations, then order cost bands before recency", () => {
	const current = priced("gpt-6-astra", 9);
	const models = [
		priced("gpt-5.4-mini", 0.25), priced("gpt-6-luna", 1), priced("gpt-6-sol", 2),
		priced("gpt-6.1-sol", 3), current, model("gpt-6.9-unknown"),
		priced("gpt-6-luna", 0.01, "other"), model("o6-mini"),
	];
	const before = [...models];
	const selected = recommendModels(Object.freeze(models), current);
	assert.deepEqual(refs(selected), ["mine/gpt-6-astra", "mine/gpt-6-luna", "mine/gpt-6.1-sol", "mine/gpt-6.9-unknown"]);
	assert.strictEqual(selected[0], current, "the exact current model remains visible even when expensive");
	assert.strictEqual(selected[1], models[1], "metadata and original model identity survive discovery");
	assert.deepEqual(recommendModels([...models].reverse(), current), selected);
	assert.deepEqual(models, before, "recommendations cannot mutate or remove the full catalog");
	assert.ok(orderModelCandidates(models, current).some((m) => m.id === "gpt-5.4-mini"), "explicit searches retain the older lane");
	assert.deepEqual(recommendModels(models, current, 1), [current]);
	assert.deepEqual(refs(recommendModels(models, current, 2)), ["mine/gpt-6-astra", "mine/gpt-6-luna"]);
	assert.deepEqual(recommendModels(models, current, 0), []);
});

test("recommendations find the current generation before collapsing newer versions of each lane", () => {
	const current = model("gpt-5-sol");
	const models = [current, model("gpt-5.2-sol"), model("gpt-6-sol"), model("gpt-5-luna"), model("gpt-6-luna")];
	assert.deepEqual(refs(recommendModels(models, current)), ["mine/gpt-5-sol", "mine/gpt-5.2-sol", "mine/gpt-5-luna"]);
	assert.deepEqual(recommendModels([current, model("gpt-4-mini"), model("gpt-6-luna")], current), [current], "older lanes never fill unused slots");
});

test("recommendations fall back to the textual family for unversioned supervisors without inventing refs", () => {
	const current = model("suite-current");
	const models = [current, model("suite-fast-2"), model("suite-slow-3"), model("foreign-99")];
	assert.deepEqual(refs(recommendModels(models, current)), ["mine/suite-current", "mine/suite-slow-3", "mine/suite-fast-2"]);
	assert.deepEqual(recommendModels(models, model("absent")), [], "an unrelated family is not a guessed substitute");
	assert.deepEqual(recommendModels([], current), []);
	assert.deepEqual(recommendModels(models, undefined, 2), shortlistModels(models, undefined, 2), "unanchored discovery retains general root rotation");
});

test("recommendations ignore snapshot dates as generations and retain distinct numeric size lanes", () => {
	const current = model("vendor.line-4-5-20250929-v1:0", "gateway");
	const models = [current, model("vendor.line-4-6-20240101-v1:0", "gateway"), model("vendor.line-5-20250101-v1:0", "gateway")];
	assert.deepEqual(refs(recommendModels(models, current)), ["gateway/vendor.line-4-5-20250929-v1:0", "gateway/vendor.line-4-6-20240101-v1:0"]);
	const small = model("llama-3.1-8b-instruct");
	assert.deepEqual(new Set(refs(recommendModels([small, model("llama-3.2-8b-instruct"), model("llama-3.1-70b-instruct"), model("llama-2-70b-instruct")], small))), new Set(["mine/llama-3.1-8b-instruct", "mine/llama-3.2-8b-instruct", "mine/llama-3.1-70b-instruct"]));
});

test("recommendations retain the uncapped provider cost reference and put missing or zero prices last", () => {
	const current = model("line-6-current");
	const models = [current, priced("line-6-cheap", 1), priced("line-6.2-costly", 5), priced("line-5-legacy", 0.1), model("line-6.9-missing"), priced("line-6.8-zero", 0)];
	const reference = shortlistModels(models, undefined, Number.MAX_SAFE_INTEGER);
	const tiers = modelCostTiers(models, reference);
	assert.equal(tiers.get("mine/line-6-cheap"), "medium", "the legacy reference price still contributes to provider-relative bands");
	assert.equal(tiers.get("mine/line-6.2-costly"), "high");
	assert.deepEqual(refs(recommendModels(models, current)), ["mine/line-6-current", "mine/line-6-cheap", "mine/line-6.2-costly", "mine/line-6.9-missing", "mine/line-6.8-zero"]);
	assert.deepEqual(refs(recommendModels(models, current, 2)), ["mine/line-6-current", "mine/line-6-cheap"], "capping cannot recompute cost bands");
});

test("recommendation families distinguish actual model names both directly and behind gateway namespaces", () => {
	for (const namespace of ["", "openai/"]) {
		const current = model(`${namespace}gpt-4.1`);
		const nearby = model(`${namespace}gpt-4.2-sol`);
		const otherFamily = model(`${namespace}o4-mini`);
		const otherVendor = model("another/gpt-4.2-sol");
		const models = [current, nearby, otherFamily, otherVendor];
		assert.deepEqual(recommendModels(models, current), [current, nearby], namespace || "direct model ids");
		assert.ok(orderModelCandidates(models, current).includes(otherFamily), "family recommendations do not shrink full searches");
	}
});

test("recommendation families retain dotted gateway vendor and region namespaces", () => {
	const current = model("us.anthropic.claude-opus-4-5-20251101-v1:0");
	const nearby = model("us.anthropic.claude-sonnet-4-6-v1:0");
	const models = [current, nearby,
		model("us.anthropic.other-4-7-v1:0"),
		model("us.another.claude-sonnet-4-7-v1:0"),
		model("eu.anthropic.claude-sonnet-4-7-v1:0"),
	];
	assert.deepEqual(recommendModels(models, current), [current, nearby]);
});

test("numeric gateway namespaces cannot replace the actual model generation", () => {
	const current = model("01-vendor/gpt-6-astra");
	const nearby = model("01-vendor/gpt-6-luna");
	assert.deepEqual(recommendModels([current, nearby, model("01-vendor/gpt-5.4-mini")], current), [current, nearby]);
});

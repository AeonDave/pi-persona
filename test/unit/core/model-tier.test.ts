import assert from "node:assert/strict";
import { test } from "node:test";

import { modelCandidateDetails, modelCostTiers, type ModelCostMetadata } from "../../../src/core/model-tier.ts";

function priced(provider: string, id: string, price: number): ModelCostMetadata {
	return { provider, id, cost: { input: price / 2, output: price / 2 } };
}

test("relative cost bands use distinct prices within each provider", () => {
	const models = [priced("p", "a", 1), priced("p", "b", 2), priced("p", "c", 3), priced("p", "d", 4), priced("p", "e", 5), priced("p", "f", 6)];
	assert.deepEqual([...modelCostTiers(models)], [
		["p/a", "low"], ["p/b", "low"], ["p/c", "medium"], ["p/d", "medium"], ["p/e", "high"], ["p/f", "high"],
	]);
});

test("aliases with equal prices cannot skew bands or receive different tiers", () => {
	const reference = [priced("p", "a", 1), priced("p", "b", 2), priced("p", "c", 3)];
	const aliases = Array.from({ length: 20 }, (_, i) => priced("p", `alias-${i}`, 1));
	const tiers = modelCostTiers([...reference, ...aliases]);
	assert.equal(tiers.get("p/a"), "low");
	assert.equal(tiers.get("p/b"), "medium");
	assert.equal(tiers.get("p/c"), "high");
	for (const alias of aliases) assert.equal(tiers.get(`${alias.provider}/${alias.id}`), "low");
});

test("decimal-equal price totals cannot invent an extra band or split equal-cost candidates", () => {
	const equalTotals: ModelCostMetadata[] = [
		{ provider: "p", id: "split-a", cost: { input: 0.1, output: 0.2 } },
		{ provider: "p", id: "split-b", cost: { input: 0.15, output: 0.15 } },
		priced("p", "middle", 2),
	];
	assert.equal(modelCostTiers(equalTotals).size, 0, "only two distinct decimal prices cannot establish cost bands");
	assert.deepEqual([...modelCostTiers([...equalTotals, priced("p", "high", 3)])], [
		["p/split-a", "low"], ["p/split-b", "low"], ["p/middle", "medium"], ["p/high", "high"],
	]);
});

test("provider bands remain independent and invariant under uniform price scaling", () => {
	const models = [priced("cheap", "a", 1), priced("cheap", "b", 2), priced("cheap", "c", 3),
		priced("expensive", "a", 100), priced("expensive", "b", 200), priced("expensive", "c", 300)];
	const tiers = modelCostTiers(models);
	assert.equal(tiers.get("cheap/c"), "high");
	assert.equal(tiers.get("expensive/a"), "low");
	const scaled = models.map((m) => ({ ...m, cost: { input: m.cost!.input * 7, output: m.cost!.output * 7 } }));
	assert.deepEqual(modelCostTiers(scaled), tiers);
});

test("unknown prices and providers with fewer than three distinct prices stay unknown", () => {
	const valid = [priced("p", "a", 1), priced("p", "b", 2), priced("p", "c", 3)];
	const unknown: ModelCostMetadata[] = [{ provider: "p", id: "missing" }];
	for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		unknown.push({ provider: "p", id: `input-${bad}`, cost: { input: bad, output: 2 } });
		unknown.push({ provider: "p", id: `output-${bad}`, cost: { input: 2, output: bad } });
	}
	unknown.push({ provider: "p", id: "overflow", cost: { input: Number.MAX_VALUE, output: Number.MAX_VALUE } });
	assert.deepEqual(modelCostTiers([...valid, ...unknown]), modelCostTiers(valid));
	assert.equal(modelCostTiers([priced("sparse", "a", 1), priced("sparse", "b", 2)]).size, 0);
	assert.equal(modelCostTiers([priced("one", "a", 1), priced("one", "alias", 1)]).size, 0);
});

test("an uncapped reference fixes candidate bands and clamps prices outside its range", () => {
	const reference = [priced("p", "a", 1), priced("p", "b", 2), priced("p", "c", 3)];
	const candidates = [priced("p", "below", 0.5), priced("p", "between", 1.5), priced("p", "above", 4), priced("other", "unknown", 2)];
	assert.deepEqual([...modelCostTiers(candidates, reference)], [["p/below", "low"], ["p/between", "medium"], ["p/above", "high"]]);
});

test("candidate details label relative cost and available host catalog metadata compactly", () => {
	assert.equal(modelCandidateDetails({
		provider: "p", id: "opaque", reasoning: true, contextWindow: 128_000, cost: { input: 1, output: 4 },
	}, "medium"), "[cost:medium; reasoning; ctx 128k; API $1/$4 per 1M in/out]");
	assert.equal(modelCandidateDetails({
		provider: "p", id: "opaque", reasoning: false, contextWindow: 1_500_000, cost: { input: 0.15, output: 1.25 },
	}), "[cost:unknown; ctx 1.5M; API $0.15/$1.25 per 1M in/out]");
});

test("candidate details omit missing, zero, negative, and nonfinite metadata", () => {
	assert.equal(modelCandidateDetails({ provider: "p", id: "opaque" }), "[cost:unknown]");
	for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(modelCandidateDetails({ provider: "p", id: "opaque", contextWindow }), "[cost:unknown]");
	}
	for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(modelCandidateDetails({ provider: "p", id: "opaque", cost: { input: bad, output: 4 } }), "[cost:unknown]");
		assert.equal(modelCandidateDetails({ provider: "p", id: "opaque", cost: { input: 1, output: bad } }), "[cost:unknown]");
	}
});

test("small positive catalog prices remain visible and are never rounded to free", () => {
	assert.equal(modelCandidateDetails({ provider: "p", id: "opaque", contextWindow: 512, cost: { input: 0.00001, output: 0.00004 } }, "low"),
		"[cost:low; ctx 512; API $0.00001/$0.00004 per 1M in/out]");
});

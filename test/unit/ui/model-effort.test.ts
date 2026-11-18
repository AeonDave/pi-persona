import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThinkingLevel } from "../../../src/core/types.ts";
import { effortText, modelEffortText } from "../../../src/ui/model-effort.ts";

test("effortText: full level names, off shown, unknown omitted, honest divergence", () => {
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) assert.equal(effortText(level), level);
	assert.equal(effortText(undefined), "", "unknown renders nothing, never a placeholder");
	assert.equal(effortText("xhigh", "high"), "xhigh→high");
	assert.equal(effortText("high", "high"), "high", "an equal observation is not a divergence");
	assert.equal(effortText("high", "off"), "high→off", "Pi clamping a level to off is shown, not hidden");
	assert.equal(effortText(undefined, "medium"), "medium", "an observed level with no known request is what ran");
	assert.equal(effortText("nonsense" as ThinkingLevel), "", "invalid input never throws");
	assert.equal(effortText("high", "nonsense" as ThinkingLevel), "high");
});

test("modelEffortText: one `model · effort` grammar; either side may be absent", () => {
	assert.equal(modelEffortText("haiku-5", "medium"), "haiku-5 · medium");
	assert.equal(modelEffortText("haiku-5", undefined), "haiku-5");
	assert.equal(modelEffortText(undefined, "low"), "low");
	assert.equal(modelEffortText("  ", undefined), "");
	assert.equal(modelEffortText("opus-5", "xhigh", "high"), "opus-5 · xhigh→high");
});

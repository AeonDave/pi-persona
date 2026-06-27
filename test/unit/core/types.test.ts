import { test } from "node:test";
import assert from "node:assert/strict";

import { asSystemPromptMode, isThinkingLevel } from "../../../src/core/types.ts";

test("isThinkingLevel recognises the six valid levels and rejects others", () => {
	for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.equal(isThinkingLevel(lvl), true, lvl);
	}
	assert.equal(isThinkingLevel("ultra"), false);
	assert.equal(isThinkingLevel(undefined), false);
	assert.equal(isThinkingLevel(5), false);
});

test("asSystemPromptMode normalises to append|replace with a fallback", () => {
	assert.equal(asSystemPromptMode("append", "append"), "append");
	assert.equal(asSystemPromptMode("replace", "append"), "replace");
	assert.equal(asSystemPromptMode("weird", "append"), "append");
	assert.equal(asSystemPromptMode(undefined, "replace"), "replace");
});

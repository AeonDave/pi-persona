import { test } from "node:test";
import assert from "node:assert/strict";

import { asSystemPromptMode, isThinkingLevel } from "../../../src/core/types.ts";

test("isThinkingLevel recognises every valid level (incl. max) and rejects others", () => {
	// Mirrors pi-ai's ThinkingLevel; `max` was added upstream in pi 0.80.6 and must be accepted so
	// a supervisor running at `max` propagates that level to its children instead of falling back.
	for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChildThinking, parseLegThinking, resolveLegThinking } from "../../../src/core/leg-thinking.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../../../src/core/types.ts";

test("child default prefers configured effort, then concrete supervisor, then high", () => {
	for (const level of THINKING_LEVELS) {
		assert.equal(defaultChildThinking(level, "low"), level);
		assert.equal(defaultChildThinking(undefined, level), level);
	}
	for (const unknown of [undefined, "adaptive", "", null, 7]) assert.equal(defaultChildThinking(undefined, unknown), "high");
	assert.equal(defaultChildThinking("unsupported", "low"), "unsupported", "configured values retain existing downstream validation");
});

test("one effort precedence: explicit spec > agent > configured/inherited child setting", () => {
	for (const thinking of THINKING_LEVELS) {
		assert.equal(parseLegThinking(thinking), thinking);
		assert.equal(resolveLegThinking({ thinking }, { thinking: "medium" }, "high"), thinking);
		assert.equal(resolveLegThinking({}, { thinking }, "high"), thinking);
		assert.equal(resolveLegThinking({}, {}, thinking), thinking);
	}
	assert.equal(resolveLegThinking({}, {}, undefined), undefined);
	assert.equal(resolveLegThinking({}, {}, "adaptive"), undefined);
});

test("invalid explicit effort cannot become inheritance, even if another selection wins", () => {
	for (const value of ["ultra", "HIGH", "", 0, null, false, ["high"], {}]) {
		const thinking = value as ThinkingLevel;
		assert.throws(() => parseLegThinking(value), /thinking.*off.*max/);
		assert.throws(() => resolveLegThinking({ thinking }, {}, "high"), /thinking/);
		assert.throws(() => resolveLegThinking({ thinking: "low" }, { thinking }, "high"), /agent.thinking/);
	}
});

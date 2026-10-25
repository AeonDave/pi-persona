import assert from "node:assert/strict";
import { test } from "node:test";
import { effortFullName, effortSigla, parseLegThinking, resolveLegThinking } from "../../../src/core/leg-thinking.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../../../src/core/types.ts";

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

test("effort display carries the FULL level name; off renders empty so absence is unambiguous", () => {
	assert.equal(effortFullName("off"), "");
	for (const thinking of THINKING_LEVELS) {
		if (thinking === "off") continue;
		assert.equal(effortFullName(thinking), thinking);
	}
	assert.equal(effortFullName("nonsense" as ThinkingLevel), "", "unknown input renders nothing, never throws");
});

test("effortSigla: the frozen compact convention for tree/overlay rows; off renders nothing", () => {
	assert.equal(effortSigla("minimal"), "mn");
	assert.equal(effortSigla("low"), "l");
	assert.equal(effortSigla("medium"), "m");
	assert.equal(effortSigla("high"), "h");
	assert.equal(effortSigla("xhigh"), "xh");
	assert.equal(effortSigla("max"), "mx");
	assert.equal(effortSigla("off"), "", "off renders nothing — absence means off");
	assert.equal(effortSigla("nonsense" as ThinkingLevel), "", "unknown input renders nothing, never throws");
});

test("invalid explicit effort cannot become inheritance, even if another selection wins", () => {
	for (const value of ["ultra", "HIGH", "", 0, null, false, ["high"], {}]) {
		const thinking = value as ThinkingLevel;
		assert.throws(() => parseLegThinking(value), /thinking.*off.*max/);
		assert.throws(() => resolveLegThinking({ thinking }, {}, "high"), /thinking/);
		assert.throws(() => resolveLegThinking({ thinking: "low" }, { thinking }, "high"), /agent.thinking/);
	}
});

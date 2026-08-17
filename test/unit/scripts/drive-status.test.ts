import assert from "node:assert/strict";
import test from "node:test";

import { effectiveDriveExitCode, terminalAssistantError } from "../../../scripts/drive-status.ts";

test("terminalAssistantError recognizes a provider/model terminal error", () => {
	assert.equal(
		terminalAssistantError({ stopReason: "error", errorMessage: "402 credits exhausted" }),
		"402 credits exhausted",
	);
	assert.equal(terminalAssistantError({ stopReason: "stop", errorMessage: "" }), undefined);
});

test("effectiveDriveExitCode cannot turn a model error or killed process green", () => {
	assert.equal(effectiveDriveExitCode(0, undefined), 0);
	assert.equal(effectiveDriveExitCode(0, "provider unavailable"), 1);
	assert.equal(effectiveDriveExitCode(null, undefined), 1);
	assert.equal(effectiveDriveExitCode(7, undefined), 7);
});

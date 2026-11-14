import { test } from "node:test";
import assert from "node:assert/strict";

import { EVIDENCE_GUIDANCE, shouldAppendEvidenceGuidance } from "../../../src/core/evidence.ts";

test("evidence guidance covers exit-code retention, provenance and hash comparison without overclaiming", () => {
	assert.match(EVIDENCE_GUIDANCE, /check process(?:'s|’s) own exit code/i);
	assert.match(EVIDENCE_GUIDANCE, /pipefail/i);
	assert.match(EVIDENCE_GUIDANCE, /separate logs/i);
	assert.match(EVIDENCE_GUIDANCE, /tail.*grep.*formatter/i);
	assert.match(EVIDENCE_GUIDANCE, /unverified, not pass/i);
	assert.match(EVIDENCE_GUIDANCE, /exact command\/API\/source observed/i);
	assert.match(EVIDENCE_GUIDANCE, /worker(?:'s|’s) report is a claim, not independent proof/i);
	assert.match(EVIDENCE_GUIDANCE, /computed\/present.*not.*verified\/matched/i);
	assert.match(EVIDENCE_GUIDANCE, /expected.*actual comparison/i);
	assert.match(EVIDENCE_GUIDANCE, /state.*limits/i);
	assert.match(EVIDENCE_GUIDANCE, /explicit project-documented platform allowances/i);
	assert.match(EVIDENCE_GUIDANCE, /skipped cases as untested, never passed/i);
	assert.match(EVIDENCE_GUIDANCE, /unexpected\/new skips or weakened checks/i);
});

test("only an internal, tool-less, all-tools-denied, spine-free worker omits general evidence guidance", () => {
	assert.equal(shouldAppendEvidenceGuidance({ source: "internal:maintenance", tools: [], excludeTools: ["*"], spine: false }), false);
	assert.equal(shouldAppendEvidenceGuidance({ source: "/agents/private.md", tools: [], excludeTools: ["*"], spine: false }), true);
	assert.equal(shouldAppendEvidenceGuidance({ source: "internal:maintenance", tools: [], excludeTools: ["*"], spine: true }), true);
	assert.equal(shouldAppendEvidenceGuidance({ source: "internal:maintenance", tools: ["read"], excludeTools: ["*"], spine: false }), true);
	assert.equal(shouldAppendEvidenceGuidance({ source: "internal:maintenance", tools: [], excludeTools: [], spine: false }), true);
});

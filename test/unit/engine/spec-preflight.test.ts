import { test } from "node:test";
import assert from "node:assert/strict";

import { installedHint, unknownAgentFailure, unknownContractFailure } from "../../../src/engine/spec-preflight.ts";

test("installedHint is empty when nothing is installed", () => {
	assert.equal(installedHint("agents", []), "");
});

test("installedHint lists names and caps the list at 12 with an ellipsis", () => {
	assert.equal(installedHint("contracts", ["default", "finding"]), " — installed contracts: default, finding");
	const many = Array.from({ length: 13 }, (_, i) => `c${i}`);
	const hint = installedHint("contracts", many);
	assert.match(hint, /c11, …$/);
	assert.equal(/c12/.test(hint), false);
});

test("unknownAgentFailure keeps the bare message without a registry and appends the hint with one", () => {
	const bare = unknownAgentFailure("nope", []);
	assert.equal(bare.ok, false);
	assert.equal(bare.failureKind, "unknown-agent");
	assert.equal(bare.error, "[nope] unknown agent (not found in registry)");
	assert.equal(bare.output, "");
	const hinted = unknownAgentFailure("nope", ["scout", "operator"]);
	assert.equal(hinted.error, "[nope] unknown agent (not found in registry) — installed agents: scout, operator");
});

test("unknownContractFailure names the installed contracts so the caller can self-correct", () => {
	const r = unknownContractFailure("operator", "Report con stacktrace", ["default", "finding"]);
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "contract");
	assert.equal(r.agent, "operator");
	assert.equal(r.error, '[operator] output contract "Report con stacktrace" not found — installed contracts: default, finding');
});

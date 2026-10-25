/** The frozen read_result admission rule (contract 4) — ONE shared helper, both engines. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { admitResultReadTool, referenceHandoffFailure } from "../../../src/engine/result-grant.ts";

test("admission matrix: absent allowlist grants by injection, deny rules stay wins", () => {
	// absent allowlist: session defaults + custom-tool injection, no literal admission needed
	assert.deepEqual(admitResultReadTool({ specTools: undefined, cfgTools: undefined, excludeTools: undefined, canUseBus: true }), { ok: true, tools: undefined });

	// nonempty allowlist naming read → grant, literal read_result appended
	assert.deepEqual(admitResultReadTool({ specTools: ["read"], cfgTools: undefined, excludeTools: undefined, canUseBus: true }), { ok: true, tools: ["read", "read_result"] });

	// nonempty allowlist naming read_result → grant, no duplicate literal
	assert.deepEqual(admitResultReadTool({ specTools: undefined, cfgTools: ["read_result", "grep"], excludeTools: undefined, canUseBus: true }), { ok: true, tools: ["read_result", "grep"] });

	// explicit [] denies
	const empty = admitResultReadTool({ specTools: [], cfgTools: ["read"], excludeTools: undefined, canUseBus: true });
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.match(empty.error, /allowlist is empty|read/);

	// unrelated nonempty allowlist denies (neither read nor read_result named)
	const unrelated = admitResultReadTool({ specTools: ["write", "grep"], cfgTools: undefined, excludeTools: undefined, canUseBus: true });
	assert.equal(unrelated.ok, false);

	// deny read → denies even though the allowlist names read
	assert.equal(admitResultReadTool({ specTools: ["read"], cfgTools: undefined, excludeTools: ["read"], canUseBus: true }).ok, false);

	// deny read_result → denies
	assert.equal(admitResultReadTool({ specTools: ["read"], cfgTools: undefined, excludeTools: ["read_result"], canUseBus: true }).ok, false);

	// wildcard deny covering both → denies
	assert.equal(admitResultReadTool({ specTools: ["read"], cfgTools: undefined, excludeTools: ["re*"], canUseBus: true }).ok, false);

	// a deny that matches neither tool does not deny
	assert.deepEqual(admitResultReadTool({ specTools: undefined, cfgTools: undefined, excludeTools: ["write"], canUseBus: true }), { ok: true, tools: undefined });

	// parent canUseBus false denies regardless of everything else
	const busOff = admitResultReadTool({ specTools: undefined, cfgTools: undefined, excludeTools: undefined, canUseBus: false });
	assert.equal(busOff.ok, false);
	if (!busOff.ok) assert.match(busOff.error, /bus/);
});

test("spec.tools overrides cfg.tools in the effective admission input", () => {
	// spec [] is an explicit deny even when the agent config allows tools
	assert.equal(admitResultReadTool({ specTools: [], cfgTools: ["read"], excludeTools: undefined, canUseBus: true }).ok, false);
	// spec ["read"] grants even when cfg has an unrelated allowlist
	assert.deepEqual(admitResultReadTool({ specTools: ["read"], cfgTools: ["write"], excludeTools: undefined, canUseBus: true }), { ok: true, tools: ["read", "read_result"] });
});

test("referenceHandoffFailure is a zero-usage contract failure", () => {
	const r = referenceHandoffFailure("worker", "archived results unavailable: result:x");
	assert.equal(r.agent, "worker");
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "contract");
	assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
	assert.match(r.error ?? "", /archived results unavailable/);
});

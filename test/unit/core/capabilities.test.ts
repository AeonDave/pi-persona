import { test } from "node:test";
import assert from "node:assert/strict";

import { canDelegateTo, canCallTool, resolveCapabilities } from "../../../src/core/capabilities.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 3, timeoutMs: 120_000, budgetTokens: 1_000_000 };
const TOOLS = ["read", "grep", "bash", "write", "delegate", "web_search"];
const AGENTS = ["scout", "researcher", "planner"];

function base(overrides: Record<string, unknown> = {}) {
	return {
		allToolNames: TOOLS,
		knownAgents: AGENTS,
		knownSkills: ["code-review", "deep-research"],
		permissions: {},
		limits: LIMITS,
		...overrides,
	};
}

test("no restrictions ⇒ all tools, can spawn, sees every agent", () => {
	const caps = resolveCapabilities(base());
	assert.equal(caps.tools.size, TOOLS.length);
	assert.equal(caps.canSpawn, true);
	assert.deepEqual([...caps.delegateTargets].sort(), [...AGENTS].sort());
	assert.equal(canCallTool(caps, "bash"), true);
});

test("tool allowlist still keeps `delegate` unless explicitly denied", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { allow: ["read"] } } }));
	assert.equal(canCallTool(caps, "read"), true);
	assert.equal(canCallTool(caps, "bash"), false);
	assert.equal(canCallTool(caps, "delegate"), true, "delegate is preserved under an allowlist");
	assert.equal(caps.canSpawn, true);
});

test("explicitly denying `delegate` removes it and disables spawning", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { deny: ["delegate"] } } }));
	assert.equal(canCallTool(caps, "delegate"), false);
	assert.equal(caps.canSpawn, false);
	assert.equal(caps.delegateTargets.size, 0, "cannot delegate when it cannot spawn");
});

test("delegate allowlist scopes the spawnable roster", () => {
	const caps = resolveCapabilities(base({ permissions: { delegate: { allow: ["scout"] } } }));
	assert.equal(canDelegateTo(caps, "scout"), true);
	assert.equal(canDelegateTo(caps, "planner"), false);
});

test("skills allowlist filters known skills", () => {
	const caps = resolveCapabilities(base({ permissions: { skills: { allow: ["code-*"] } } }));
	assert.equal(caps.skills.has("code-review"), true);
	assert.equal(caps.skills.has("deep-research"), false);
});

test("limits and transport flags are carried through", () => {
	const caps = resolveCapabilities(base({ canUseBus: true, canUseProcessTransport: false }));
	assert.deepEqual(caps.limits, LIMITS);
	assert.equal(caps.canUseBus, true);
	assert.equal(caps.canUseProcessTransport, false);
});

test("delegateDefaultAllow=false locks down delegation when no allow block is given", () => {
	const caps = resolveCapabilities(base({ delegateDefaultAllow: false }));
	assert.equal(caps.delegateTargets.size, 0);
});

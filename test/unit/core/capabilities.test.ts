import { test } from "node:test";
import assert from "node:assert/strict";

import { canCallTool, canDelegateTo, canFanOut, resolveCapabilities } from "../../../src/core/capabilities.ts";

const TOOLS = ["read", "grep", "bash", "write", "delegate", "web_search"];
const AGENTS = ["scout", "researcher", "planner"];

function base(overrides: Record<string, unknown> = {}) {
	return {
		allToolNames: TOOLS,
		knownAgents: AGENTS,
		permissions: {},
		...overrides,
	};
}

test("no restrictions ⇒ all tools, can fan out, sees every agent", () => {
	const caps = resolveCapabilities(base());
	assert.equal(caps.tools.size, TOOLS.length);
	assert.equal(canFanOut(caps), true);
	assert.deepEqual([...caps.delegateTargets].sort(), [...AGENTS].sort());
	assert.equal(canCallTool(caps, "bash"), true);
});

test("tool allowlist still keeps `delegate` unless explicitly denied", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { allow: ["read"] } } }));
	assert.equal(canCallTool(caps, "read"), true);
	assert.equal(canCallTool(caps, "bash"), false);
	assert.equal(canCallTool(caps, "delegate"), true, "delegate is preserved under an allowlist");
	assert.equal(canFanOut(caps), true);
});

test("explicitly denying `delegate` removes it and disables spawning", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { deny: ["delegate"] } } }));
	assert.equal(canCallTool(caps, "delegate"), false);
	assert.equal(canFanOut(caps), false);
	assert.equal(caps.delegateTargets.size, 0, "cannot delegate when it cannot spawn");
});

test("delegate allowlist scopes the spawnable roster", () => {
	const caps = resolveCapabilities(base({ permissions: { delegate: { allow: ["scout"] } } }));
	assert.equal(canDelegateTo(caps, "scout"), true);
	assert.equal(canDelegateTo(caps, "planner"), false);
});

test("delegateDefaultAllow=false locks down delegation when no allow block is given", () => {
	const caps = resolveCapabilities(base({ delegateDefaultAllow: false }));
	assert.equal(caps.delegateTargets.size, 0);
});

test("canUseBus is ON by default and survives a tools allowlist that omits intercom", () => {
	const caps = resolveCapabilities({
		allToolNames: ["read", "intercom", "delegate"],
		knownAgents: [],
		permissions: { tools: { allow: ["read"] } },
	});
	assert.equal(caps.canUseBus, true, "an allowlist restricts the SUPERVISOR tool set; it is not a bus denial");
});

test("canUseBus is OFF only when the persona explicitly denies `intercom`", () => {
	const caps = resolveCapabilities({
		allToolNames: ["read", "intercom", "delegate"],
		knownAgents: [],
		permissions: { tools: { deny: ["intercom"] } },
	});
	assert.equal(caps.canUseBus, false);
});

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

test("exocom tools follow canUseBus, not the general allowlist (like delegate)", () => {
	// A restrictive allowlist that omits the exocom tools must NOT lock a bus-holding persona out of
	// them — else a persona with a live exocom pool can't actually message its peers.
	const caps = resolveCapabilities(base({ permissions: { tools: { allow: ["read"] } } }));
	assert.equal(canCallTool(caps, "read"), true);
	assert.equal(canCallTool(caps, "bash"), false, "the allowlist still restricts ordinary tools");
	assert.equal(canCallTool(caps, "exocom_send"), true, "exocom_send is granted via canUseBus");
	assert.equal(canCallTool(caps, "exocom_list"), true);
	assert.equal(canCallTool(caps, "exocom_name"), true);
});

test("denying the bus (intercom) also denies the exocom tools", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { deny: ["intercom"] } } }));
	assert.equal(caps.canUseBus, false);
	assert.equal(canCallTool(caps, "exocom_send"), false, "no bus ⇒ no external-bus tools either");
});

test("the exocom grant does not inflate the resolved tool set (canUseBus-gated at call time)", () => {
	// Granting is done in canCallTool, NOT baked into caps.tools — so a no-restriction persona still
	// resolves to exactly its real tools (the exocom tools are only ever registered when active).
	const caps = resolveCapabilities(base());
	assert.equal(caps.tools.has("exocom_send"), false, "not baked into the tool set");
	assert.equal(canCallTool(caps, "exocom_send"), true, "but callable via canUseBus");
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

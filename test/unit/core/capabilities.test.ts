import { test } from "node:test";
import assert from "node:assert/strict";

import { canCallTool, canDelegateTo, canFanOut, EXOCOM_TOOL_NAMES, resolveCapabilities } from "../../../src/core/capabilities.ts";

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
	for (const tool of EXOCOM_TOOL_NAMES) assert.equal(canCallTool(caps, tool), true, `${tool} is granted via canUseBus`);
});

test("an explicit per-tool deny beats the exocom canUseBus fast-path (deny-wins, I4)", () => {
	// Denying ONE exocom tool (not the whole bus) must stick: the fast-path grants via
	// canUseBus, but deny-wins is the I4 rule and a targeted denial is more specific.
	const caps = resolveCapabilities(base({ permissions: { tools: { deny: ["exocom_send"] } } }));
	assert.equal(caps.canUseBus, true, "the bus itself is not denied");
	assert.equal(canCallTool(caps, "exocom_send"), false, "explicitly denied");
	assert.equal(canCallTool(caps, "exocom_list"), true, "siblings still follow canUseBus");
});

test("denying the bus (intercom) also denies the exocom tools", () => {
	const caps = resolveCapabilities(base({ permissions: { tools: { deny: ["intercom"] } } }));
	assert.equal(caps.canUseBus, false);
	for (const tool of EXOCOM_TOOL_NAMES) assert.equal(canCallTool(caps, tool), false, `no bus ⇒ ${tool} is denied`);
});

test("the exocom grant does not inflate the resolved tool set (canUseBus-gated at call time)", () => {
	// Granting is done in canCallTool, NOT baked into caps.tools — so a no-restriction persona still
	// resolves to exactly its real tools (the exocom tools are only ever registered when active).
	const caps = resolveCapabilities(base());
	assert.equal(caps.tools.has("exocom_send"), false, "not baked into the tool set");
	assert.equal(canCallTool(caps, "exocom_send"), true, "but callable via canUseBus");
});

test("a tool registered AFTER activation (not in the snapshot) is gated by the persona's RULE, not the snapshot", () => {
	// The activation-time `tools` snapshot (allToolNames) can't include a tool that registers later —
	// an MCP server connects async and re-registers ALL its tools on every reconnect. The gate must
	// use the persona's allow/deny by name, or an unrestricted persona is wrongly told it "may not
	// use" an MCP tool it used a moment ago (regression the snapshot-only check caused).
	const open = resolveCapabilities(base()); // unrestricted; allToolNames has no mcpwn tool
	assert.equal(open.tools.has("mcpwn_execute_command"), false, "genuinely not in the activation snapshot");
	assert.equal(canCallTool(open, "mcpwn_execute_command"), true, "unrestricted persona ⇒ callable anyway");
	// A restrictive allowlist that never named it still blocks it (timing doesn't loosen the allowlist).
	const allow = resolveCapabilities(base({ permissions: { tools: { allow: ["read"] } } }));
	assert.equal(canCallTool(allow, "mcpwn_execute_command"), false, "allowlist omitting it still blocks");
	// An explicit deny wins for a late tool too.
	const deny = resolveCapabilities(base({ permissions: { tools: { deny: ["mcpwn_execute_command"] } } }));
	assert.equal(canCallTool(deny, "mcpwn_execute_command"), false, "explicit deny wins even for a late tool");
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

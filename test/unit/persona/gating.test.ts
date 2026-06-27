import { test } from "node:test";
import assert from "node:assert/strict";

import { type CapabilityPermissions, resolveCapabilities } from "../../../src/core/capabilities.ts";
import { extractDelegateTargets, gateToolCall } from "../../../src/persona/gating.ts";
import { type Persona, parsePersona } from "../../../src/persona/persona.ts";

const ALL_TOOLS = ["read", "write", "grep", "delegate", "anything"];
const KNOWN = ["scout", "ghost", "x", "y"];

const p = (fm: string): Persona => {
	const persona = parsePersona(`---\n${fm}\n---\nbody`, "/s");
	if (!persona) throw new Error("bad fixture");
	return persona;
};

const capsFor = (persona: Persona, delegateDefaultAllow = true) => {
	const permissions: CapabilityPermissions = {};
	if (persona.tools) permissions.tools = persona.tools;
	if (persona.delegate) permissions.delegate = persona.delegate;
	return resolveCapabilities({ allToolNames: ALL_TOOLS, knownAgents: KNOWN, permissions, delegateDefaultAllow });
};

test("extractDelegateTargets reads single agent and tasks[].agent from tool input", () => {
	assert.deepEqual(extractDelegateTargets({ agent: "scout" }), ["scout"]);
	assert.deepEqual(extractDelegateTargets({ tasks: [{ agent: "a" }, { agent: "b" }] }), ["a", "b"]);
	assert.deepEqual(extractDelegateTargets({ agent: "x", tasks: [{ agent: "y" }] }), ["x", "y"]);
	assert.deepEqual(extractDelegateTargets({}), []);
	assert.deepEqual(extractDelegateTargets(null), []);
});

test("gateToolCall blocks tools outside the persona's tool allowlist", () => {
	const caps = capsFor(p("name: r\npersona: true\ntools:\n  allow: [read, delegate]"));
	assert.equal(gateToolCall(caps, "R", "read", {}), undefined);
	assert.equal(gateToolCall(caps, "R", "write", {})?.block, true);
});

test("gateToolCall blocks delegation to agents outside the delegate allowlist", () => {
	const caps = capsFor(p("name: r\npersona: true\ndelegate:\n  allow: [scout]"));
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "scout" }), undefined);
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "ghost" })?.block, true);
});

test("gateToolCall allows everything when the persona declares no restrictions", () => {
	const caps = capsFor(p("name: r\npersona: true"));
	assert.equal(gateToolCall(caps, "R", "anything", { agent: "x" }), undefined);
});

test("gateToolCall honours delegateDefaultAllow=false (lockdown) for an absent delegate block", () => {
	const caps = capsFor(p("name: r\npersona: true"), false);
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "x" })?.block, true);
});

test("gateToolCall blocks a delegate that grants a sub-agent tools beyond the persona's (I4 escalation)", () => {
	const caps = capsFor(p("name: r\npersona: true\ntools:\n  allow: [read]"));
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "scout", tools: ["write"] })?.block, true);
	assert.equal(
		gateToolCall(caps, "R", "delegate", { tasks: [{ agent: "scout", tools: ["grep"] }] })?.block,
		true,
		"also checks tasks[].tools",
	);
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "scout", tools: ["read"] }), undefined, "an allowed tool is fine");
});

test("a tools-restricted persona still keeps delegate (delegation is preserved unless explicitly denied)", () => {
	const caps = capsFor(p("name: r\npersona: true\ntools:\n  allow: [read]"));
	assert.equal(gateToolCall(caps, "R", "delegate", { agent: "scout" }), undefined, "delegate survives a tools allowlist");
	assert.equal(gateToolCall(caps, "R", "write", {})?.block, true, "but other unlisted tools are still blocked");
});

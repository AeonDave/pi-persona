import { test } from "node:test";
import assert from "node:assert/strict";

import { extractDelegateTargets, gateToolCall } from "../../../src/persona/gating.ts";
import { parsePersona } from "../../../src/persona/persona.ts";

const p = (fm: string) => {
	const persona = parsePersona(`---\n${fm}\n---\nbody`, "/s");
	if (!persona) throw new Error("bad fixture");
	return persona;
};

test("extractDelegateTargets reads single agent and tasks[].agent from tool input", () => {
	assert.deepEqual(extractDelegateTargets({ agent: "scout" }), ["scout"]);
	assert.deepEqual(extractDelegateTargets({ tasks: [{ agent: "a" }, { agent: "b" }] }), ["a", "b"]);
	assert.deepEqual(extractDelegateTargets({ agent: "x", tasks: [{ agent: "y" }] }), ["x", "y"]);
	assert.deepEqual(extractDelegateTargets({}), []);
	assert.deepEqual(extractDelegateTargets(null), []);
});

test("gateToolCall blocks tools outside the persona's tool allowlist", () => {
	const persona = p("name: r\npersona: true\ntools:\n  allow: [read, delegate]");
	assert.equal(gateToolCall(persona, "read", {}, true), undefined);
	assert.equal(gateToolCall(persona, "write", {}, true)?.block, true);
});

test("gateToolCall blocks delegation to agents outside the delegate allowlist", () => {
	const persona = p("name: r\npersona: true\ndelegate:\n  allow: [scout]");
	assert.equal(gateToolCall(persona, "delegate", { agent: "scout" }, true), undefined);
	assert.equal(gateToolCall(persona, "delegate", { agent: "ghost" }, true)?.block, true);
});

test("gateToolCall allows everything when the persona declares no restrictions", () => {
	const persona = p("name: r\npersona: true");
	assert.equal(gateToolCall(persona, "anything", { agent: "x" }, true), undefined);
});

test("gateToolCall honours delegateDefaultAllow=false (lockdown) for an absent delegate block", () => {
	const persona = p("name: r\npersona: true");
	assert.equal(gateToolCall(persona, "delegate", { agent: "x" }, false)?.block, true);
});

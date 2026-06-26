import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../src/agents/agent.ts";
import { DEFAULT_CONTRACT } from "../../src/core/contract.ts";
import { makeEngine } from "../../src/engine/adapter.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const SCOUT: AgentConfig = {
	name: "scout",
	systemPrompt: "You are scout.",
	systemPromptMode: "replace",
	source: "x",
	model: "m",
	tools: ["read"],
};

function engine() {
	return makeEngine({
		resolveAgent: (n) => (n === "scout" ? SCOUT : undefined),
		contracts: (n) => (n === "default" ? DEFAULT_CONTRACT : undefined),
		childOptions: { resolveInvocation: resolveFake },
	});
}

test("makeEngine runs a named agent and returns its output", async () => {
	const r = await engine().run({ agent: "scout", task: "explore" });
	assert.equal(r.ok, true);
	assert.match(r.output, /echo: Task: explore/);
	assert.equal(r.usage.input, 5);
});

test("makeEngine prepends a skill-load directive when skills are requested (dynamic sub-agent)", async () => {
	const r = await engine().run({ agent: "scout", task: "explore", skills: ["python-patterns", "python-testing"] });
	assert.equal(r.ok, true);
	assert.match(r.output, /Load these skills/);
	assert.match(r.output, /python-patterns/);
});

test("makeEngine fails cleanly for an unknown agent", async () => {
	const r = await engine().run({ agent: "ghost", task: "x" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /unknown agent/);
});

test("makeEngine validates structured output against the pinned contract", async () => {
	const r = await engine().run({ agent: "scout", task: "do [json]", outputContract: "default" });
	assert.equal(r.ok, true);
	assert.equal(r.structured?.result, "done");
	assert.equal(r.structured?.stance, "approve");
});

test("makeEngine marks a contract failure when output is not valid JSON", async () => {
	const r = await engine().run({ agent: "scout", task: "plain text", outputContract: "default" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /contract/);
});

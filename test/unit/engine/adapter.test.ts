import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { DEFAULT_CONTRACT } from "../../../src/core/contract.ts";
import { makeEngine } from "../../../src/engine/adapter.ts";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const agents: Record<string, AgentConfig> = {
	a: { name: "a", systemPrompt: "You are a.", systemPromptMode: "replace", source: "x" },
};
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];
const contracts = (n: string) => (n === "default" ? DEFAULT_CONTRACT : undefined);

test("child adapter appends the contract format to the task (and only when one is requested)", async () => {
	// Mirrors the inproc test: the SAME pinned def instructs the member and validates its
	// output on the child engine too — engine parity for the contract-instruction seam.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "decide", outputContract: "default" });
	// fake-pi echoes the full stdin task back, so the child's OUTPUT shows what it was told.
	assert.match(r.output, /--- output contract \(default\) ---/, "task carries the contract block");
	assert.match(r.output, /- result \(string, required\)/, "field lines derived from the def");
	assert.equal(r.ok, false, "the echoed prose still fails validation");
	assert.equal(r.failureKind, "contract");
});

test("child adapter leaves the task untouched when no contract is requested", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "decide" });
	assert.equal(r.ok, true);
	assert.ok(!r.output.includes("output contract"), "no contract requested → no block injected");
});

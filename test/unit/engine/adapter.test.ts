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

test("child adapter names an mcp:true leg that fails with no output (MCP-init diagnosis, not an opaque timeout)", async () => {
	// [sleep] never emits → the startup deadline fires with empty output. An mcp:true leg
	// that dies mute is almost always the MCP adapter failing to init in the headless child;
	// the error must say so instead of a bare timeout the operator can't act on.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, startupTimeoutMs: 120, killGraceMs: 150 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]", mcp: true });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "timeout");
	assert.match(r.error ?? "", /mcp:true leg never completed a turn/);
	assert.match(r.error ?? "", /MCP adapter likely hung initializing/);
	assert.match(r.error ?? "", /\/mcp auth/, "names the concrete pre-auth remedy");
	assert.match(r.error ?? "", /PI_PERSONA_AGENT_STARTUP_MS/, "names the tuning knob");
});

test("child adapter does NOT add the MCP hint when the leg is not mcp:true", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, startupTimeoutMs: 120, killGraceMs: 150 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]" });
	assert.equal(r.ok, false);
	assert.doesNotMatch(r.error ?? "", /mcp:true leg/);
});

test("child adapter leaves the task untouched when no contract is requested", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "decide" });
	assert.equal(r.ok, true);
	assert.ok(!r.output.includes("output contract"), "no contract requested → no block injected");
});

test("child adapter reports an unknown agent with the bare message when listAgents is absent", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "nope", task: "t" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "unknown-agent", "not a provider failure — must not trigger fallback");
	assert.equal(r.error, "[nope] unknown agent (not found in registry)", "no listAgents → message byte-identical to today's");
});

test("child adapter's unknown-agent error names the installed agents when listAgents is wired", async () => {
	const engine = makeEngine({
		resolveAgent,
		contracts,
		childOptions: { resolveInvocation: resolveFake },
		listAgents: () => ["scout", "operator"],
	});
	const r = await engine.run({ agent: "nope", task: "t" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "unknown-agent", "the hint must not change the failure kind (fallback keys on it)");
	assert.match(r.error ?? "", /— installed agents: scout, operator/);
});

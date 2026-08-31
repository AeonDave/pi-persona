import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { DEFAULT_CONTRACT } from "../../../src/core/contract.ts";
import { makeEngine } from "../../../src/engine/adapter.ts";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const agents: Record<string, AgentConfig> = {
	a: { name: "a", systemPrompt: "You are a.", source: "x" },
};
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];
const contracts = (n: string) => (n === "default" ? DEFAULT_CONTRACT : undefined);

test("child adapter propagates each authoritative tool lifecycle event once without args or output", async () => {
	const events: unknown[] = [];
	const emitScript = `
		const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
		emit({type:"tool_execution_start", toolCallId:"call-1", toolName:"read", args:{path:"secret.txt"}});
		emit({type:"tool_execution_start", toolCallId:"call-1", toolName:"read", args:{path:"secret.txt"}});
		emit({type:"tool_execution_end", toolCallId:"call-1", toolName:"read", result:{content:"sensitive"}, isError:false});
		emit({type:"tool_execution_end", toolCallId:"call-1", toolName:"read", result:{content:"sensitive"}, isError:false});
		emit({type:"message_end", message:{role:"assistant", content:[{type:"text", text:"done"}], stopReason:"end"}});
	`;
	const engine = makeEngine({
		resolveAgent,
		childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: ["-e", emitScript, "--", ...args] }) },
	});
	const result = await engine.run({ agent: "a", task: "inspect" }, (progress) => {
		if (progress.toolEvent) events.push(progress.toolEvent);
	});
	assert.equal(result.ok, true);
	assert.deepEqual(events, [
		{ phase: "start", callId: "call-1", name: "read" },
		{ phase: "end", callId: "call-1", name: "read", failed: false },
	]);
	assert.equal(JSON.stringify(events).includes("secret.txt"), false, "tool args are not propagated");
	assert.equal(JSON.stringify(events).includes("sensitive"), false, "tool output is not propagated");
});

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

test("child adapter leads the sub-agent prompt with the spine, and honours `spine: false`", async () => {
	// The child engine hands the composed prompt over as a temp file (`--append-system-prompt`),
	// written before the spawn and deleted after it — so read it from inside the invocation seam.
	let composed: string | undefined;
	const capture = (args: string[]) => {
		const at = args.indexOf("--append-system-prompt");
		composed = at >= 0 ? readFileSync(args[at + 1] as string, "utf8") : undefined;
		return resolveFake(args);
	};

	await makeEngine({ resolveAgent, spine: "SPINE", childOptions: { resolveInvocation: capture } }).run({ agent: "a", task: "t", role: "ROLE" });
	assert.equal(composed, "SPINE\n\nYou are a.\n\nROLE", "the shared layer leads, then the agent, then the role");

	await makeEngine({ resolveAgent, childOptions: { resolveInvocation: capture } }).run({ agent: "a", task: "t", role: "ROLE" });
	assert.equal(composed, "You are a.\n\nROLE", "no spine ⇒ byte-identical to the pre-spine join");

	const optedOut = (n: string): AgentConfig | undefined => (n === "q" ? { name: "q", systemPrompt: "You are q.", spine: false, source: "x" } : undefined);
	await makeEngine({ resolveAgent: optedOut, spine: "SPINE", childOptions: { resolveInvocation: capture } }).run({ agent: "q", task: "t" });
	assert.equal(composed, "You are q.", "`spine: false` in the agent's frontmatter opts the leg out");
});

test("child adapter leaves the task untouched when no contract is requested", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "decide" });
	assert.equal(r.ok, true);
	assert.ok(!r.output.includes("output contract"), "no contract requested → no block injected");
});

test("child adapter fails closed when a requested contract is missing", async () => {
	let spawned = false;
	const engine = makeEngine({
		resolveAgent,
		contracts: () => undefined,
		childOptions: {
			resolveInvocation: (args) => {
				spawned = true;
				return resolveFake(args);
			},
		},
	});
	const r = await engine.run({ agent: "a", task: "decide", outputContract: "missing" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "contract");
	assert.match(r.error ?? "", /output contract [\"']missing[\"'] not found/);
	assert.equal(spawned, false, "a missing contract must not run an unconstrained agent");
});

test("child adapter carries an agent tools deny block to the spawned pi process", async () => {
	const seen: string[] = [];
	const restricted = (name: string): AgentConfig | undefined =>
		name === "research"
			? { name, model: "stub/m", excludeTools: ["edit"], systemPrompt: "research", source: "x" }
			: undefined;
	const capture = (args: string[]) => {
		seen.push(...args);
		return resolveFake(args);
	};
	const result = await makeEngine({ resolveAgent: restricted, childOptions: { resolveInvocation: capture } }).run({ agent: "research", task: "inspect" });
	assert.equal(result.ok, true);
	assert.ok(seen.includes("--exclude-tools") && seen.includes("edit"));
});

test("child adapter's spec.timeoutMs overrides the engine-level idle timeout for just that leg (NP2)", async () => {
	// deps-level idle timeout is long (would never fire in this window); the per-leg override is short.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, timeoutMs: 5_000, killGraceMs: 50 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]", timeoutMs: 60 });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "timeout");
	assert.match(r.error ?? "", /timed out/);
});

test("child adapter ignores a non-positive spec.timeoutMs override (falls back to the engine-level default)", async () => {
	// deps-level idle timeout is short; the per-leg override is junk (≤0) and must be ignored.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, timeoutMs: 60, killGraceMs: 50 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]", timeoutMs: -5 });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "timeout", "the deps-level default watchdog still fires");
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

test("child adapter keeps the cause of death when a contract-bearing leg dies before producing output", async () => {
	// The leg never starts → the startup deadline fires with empty output. Validating that
	// emptiness must not rename the failure "invalid JSON": the operator would coach the
	// member on formatting instead of addressing the hang.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, startupTimeoutMs: 120, killGraceMs: 150 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]", outputContract: "default" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "timeout");
	assert.match(r.error ?? "", /never started/, "the cause of death survives contract validation");
	assert.doesNotMatch(r.error ?? "", /contract default failed/);
});

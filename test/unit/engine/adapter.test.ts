import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../../src/agents/agent.ts";
import { DEFAULT_CONTRACT } from "../../../src/core/contract.ts";
import { makeEngine, type EngineAdapterDeps } from "../../../src/engine/adapter.ts";
import { TerminalResultArchive } from "../../../src/results/archive.ts";
import type { AgentProgress, AgentRunSpec } from "../../../src/orchestration/sdk.ts";
import { specOf } from "../../../src/tools/delegate.ts";
import { parseAgent } from "../../../src/agents/agent.ts";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

const agents: Record<string, AgentConfig> = {
	a: { name: "a", systemPrompt: "You are a.", source: "x" },
};
const resolveAgent = (n: string): AgentConfig | undefined => agents[n];
const contracts = (n: string) => (n === "default" ? DEFAULT_CONTRACT : undefined);
const HOST_MODULE_ERROR = "Cannot find module '/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-responses-KCCCXI3B.js' imported from /opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-66G7ITPS.js";

test("child adapter forwards mixed effort separately from opaque model ids and reads only observed Pi message effort", async () => {
	const configured = parseAgent("---\nname: a\nmodel: prov/opaque:version\nthinking: medium\n---\nworker", "a.md")!;
	const invocations: string[][] = [];
	const script = `const i=process.argv.indexOf('--thinking'); const requested=process.argv[i+1]; const thinkingLevel=requested==='low'?'medium':requested==='xhigh'?'high':undefined; process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', model:'opaque:actual', thinkingLevel, content:[{type:'text',text:'done'}],stopReason:'stop'}})+'\\n');`;
	const engine = makeEngine({ resolveAgent: () => configured, childThinking: "minimal", childOptions: { resolveInvocation: (args) => { invocations.push([...args]); return { command: process.execPath, args: ["-e", script, "--", ...args] }; } } });
	const results = await Promise.all((["low", "high", "xhigh"] as const).map((thinking) => engine.run(specOf({ agent: "a", task: "t", thinking }))));
	assert.deepEqual(invocations.map((args) => args[args.indexOf("--thinking") + 1]).sort(), ["high", "low", "xhigh"]);
	assert.ok(invocations.every((args) => args[args.indexOf("--model") + 1] === "prov/opaque:version"));
	assert.deepEqual(results.map((r) => r.thinkingRequested), ["low", "high", "xhigh"]);
	assert.deepEqual(results.map((r) => r.thinkingEffective), ["medium", undefined, "high"]);
	assert.ok(!("thinkingEffective" in results[1]!));
	assert.ok(results.every((r) => r.modelUsed === "opaque:actual"));
	assert.equal((await engine.run({ agent: "a", task: "t" })).thinkingRequested, "medium");
});

test("child adapter rejects malformed explicit thinking before invocation", async () => {
	let invoked = false;
	const engine = makeEngine({ resolveAgent, childOptions: { resolveInvocation: (args) => { invoked = true; return resolveFake(args); } } });
	const result = await engine.run({ agent: "a", task: "t", thinking: "ultra" } as unknown as AgentRunSpec);
	assert.equal(result.failureKind, "contract");
	assert.match(result.error ?? "", /thinking/);
	assert.equal(invoked, false);
});

test("child adapter preserves omission: no request or observation when neither is known", async () => {
	const seen: string[] = [];
	const result = await makeEngine({ resolveAgent, childOptions: { resolveInvocation: (args) => { seen.push(...args); return resolveFake(args); } } }).run({ agent: "a", task: "t" });
	assert.ok(!seen.includes("--thinking"));
	assert.ok(!("thinkingRequested" in result));
	assert.ok(!("thinkingEffective" in result));
});

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

test("child adapter forwards copied directional usage in progress", async () => {
	const progress: AgentProgress[] = [];
	const emitScript = `
		const emit = (usage) => process.stdout.write(JSON.stringify({type:"message_end", message:{role:"assistant", content:[{type:"text", text:"done"}], usage, stopReason:"end"}}) + "\\n");
		emit({input:123000, output:6200, cacheRead:2400000, cacheWrite:500, cost:{total:0.42}});
		emit({input:10, output:5});
	`;
	const engine = makeEngine({
		resolveAgent,
		childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: ["-e", emitScript, "--", ...args] }) },
	});
	const result = await engine.run({ agent: "a", task: "inspect" }, (snap) => progress.push(snap));
	assert.equal(result.ok, true);
	const first = progress.find((snap) => snap.tokens === 129_200);
	assert.deepEqual(first?.usage, { input: 123_000, output: 6_200, cacheRead: 2_400_000, cacheWrite: 500, cost: 0.42, contextTokens: 0, turns: 1 });
	assert.deepEqual(progress.at(-1)?.usage, result.usage);
	assert.notEqual(first?.usage, result.usage, "later events leave retained progress unchanged");
	assert.equal(progress.at(-1)?.tokens, 129_215);
});

test("child adapter preserves saved/frontmatter model choices on omission and accepts an explicit supervisor pin", async () => {
	const configuredAgent = (model: string): AgentConfig => ({ name: "configured", model, systemPrompt: "worker", source: "test" });
	const runAndCaptureModel = async (options: {
		frontmatterModel: string;
		assignedModel?: string;
		specModel?: string;
	}): Promise<string | undefined> => {
		const argsSeen: string[] = [];
		const engine = makeEngine({
			resolveAgent: () => configuredAgent(options.frontmatterModel),
			modelFor: () => options.assignedModel,
			childOptions: { resolveInvocation: (args) => { argsSeen.push(...args); return resolveFake(args); } },
		});
		await engine.run({ agent: "configured", task: "task", ...(options.specModel ? { model: options.specModel } : {}) });
		const modelAt = argsSeen.indexOf("--model");
		return modelAt >= 0 ? argsSeen[modelAt + 1] : undefined;
	};

	assert.equal(await runAndCaptureModel({ frontmatterModel: "frontmatter/worker", assignedModel: "saved/worker" }), "saved/worker");
	assert.equal(await runAndCaptureModel({ frontmatterModel: "frontmatter/worker" }), "frontmatter/worker");
	assert.equal(await runAndCaptureModel({
		frontmatterModel: "frontmatter/worker",
		assignedModel: "saved/worker",
		specModel: "supervisor/current",
	}), "supervisor/current", "an explicit provider/id pin wins over saved and frontmatter choices");
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

test("child adapter rejects a modifier-shaped per-agent tool allowlist before invocation or spawn", async () => {
	let invoked = false;
	const restricted = (name: string): AgentConfig | undefined =>
		name === "research"
			? { name, model: "stub/m", tools: ["-bash"], systemPrompt: "research", source: "x" }
			: undefined;
	const result = await makeEngine({
		resolveAgent: restricted,
		childOptions: {
			resolveInvocation: (args) => {
				invoked = true;
				return resolveFake(args);
			},
		},
	}).run({ agent: "research", task: "inspect" });

	assert.equal(result.ok, false);
	assert.equal(result.failureKind, "contract");
	assert.match(result.error ?? "", /unsupported tool modifier.*-bash/);
	assert.match(result.error ?? "", /excludeTools/);
	assert.equal(invoked, false, "invalid selectors must fail before child invocation or spawn");
});

test("child adapter validates spec.tools override before invocation and keeps normal allowlists", async () => {
	let invoked = false;
	const engine = makeEngine({
		resolveAgent: (name) => name === "research"
			? { name, model: "stub/m", tools: ["read"], systemPrompt: "research", source: "x" }
			: undefined,
		childOptions: {
			resolveInvocation: (args) => {
				invoked = true;
				return resolveFake(args);
			},
		},
	});
	const invalid = await engine.run({ agent: "research", task: "inspect", tools: [" +bash "] });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.failureKind, "contract");
	assert.match(invalid.error ?? "", /unsupported tool modifier.*\+bash/);
	assert.equal(invoked, false, "a dynamic override must be checked before invoking Pi");

	const seen: string[] = [];
	const validEngine = makeEngine({
		resolveAgent: (name) => name === "research"
			? { name, model: "stub/m", systemPrompt: "research", source: "x" }
			: undefined,
		childOptions: {
			resolveInvocation: (args) => {
				seen.push(...args);
				return resolveFake(args);
			},
		},
	});
	const glob = await validEngine.run({ agent: "research", task: "inspect", tools: ["read*", "grep*"] });
	assert.equal(glob.ok, true, "ordinary Pi-persona allowlist patterns remain valid");
	const toolsFlag = seen.indexOf("--tools");
	assert.ok(toolsFlag >= 0);
	assert.equal(seen[toolsFlag + 1], "read*,grep*");
	const emptySeen: string[] = [];
	const emptyEngine = makeEngine({
		resolveAgent,
		childOptions: {
			resolveInvocation: (args) => {
				emptySeen.push(...args);
				return resolveFake(args);
			},
		},
	});
	const empty = await emptyEngine.run({ agent: "a", task: "inspect", tools: [] });
	assert.equal(empty.ok, true, "an explicit empty allowlist remains valid");
	assert.ok(emptySeen.includes("--no-tools"));
});

test("child adapter's spec.timeoutMs overrides the engine-level idle timeout for just that leg (NP2)", async () => {
	// deps-level idle timeout is long (would never fire in this window); the per-leg override is short.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake, timeoutMs: 5_000, killGraceMs: 50 } });
	const r = await engine.run({ agent: "a", task: "hang [sleep]", timeoutMs: 60 });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "timeout");
	assert.match(r.error ?? "", /timed out/);
	assert.match(r.error ?? "", /raise this leg's timeoutMs if its tool is legitimately silent/, "the child idle-timeout text names the remedy");
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

test("child adapter's missing-contract error names the installed contracts when listContracts is wired", async () => {
	const engine = makeEngine({
		resolveAgent,
		contracts: () => undefined,
		childOptions: { resolveInvocation: resolveFake },
		listContracts: () => ["default", "finding"],
	});
	const r = await engine.run({ agent: "a", task: "decide", outputContract: "missing" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "contract");
	assert.match(r.error ?? "", /output contract "missing" not found — installed contracts: default, finding/);
});

test("child adapter classifies a PRE-STREAM provider death as provider (fallback can reroute)", async () => {
	// [provider-fail]: pi exits 1 with a 429 on stderr and NO stream events — no stop reason.
	// Before evidence-based classification this was "agent" and the fallback never fired.
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "boom [provider-fail]" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "provider", "stderr evidence of a provider rejection reroutes");
});

test("child adapter classifies Pi's missing-provider-key diagnostic as provider", async () => {
	const diagnostic = "No API key found for openai-codex";
	const script = `process.stderr.write(${JSON.stringify(diagnostic + "\n")}); process.exit(1);`;
	const engine = makeEngine({
		resolveAgent,
		contracts,
		childOptions: {
			resolveInvocation: (args) => ({ command: process.execPath, args: ["-e", script, "--", ...args] }),
		},
	});
	const r = await engine.run({ agent: "a", task: "probe", model: "openai-codex/gpt-5.6-luna" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "provider");
	assert.match(r.error ?? "", /No API key found for openai-codex/);
});

for (const mode of ["stream", "stderr"] as const) {
	test(`child adapter keeps a missing Pi host bundle chunk terminal with an actionable diagnostic (${mode})`, async () => {
		const original = HOST_MODULE_ERROR;
		const event = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: original } };
		const script = mode === "stream"
			? `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});`
			: `process.stderr.write(${JSON.stringify(original + "\n")}); process.exit(1);`;
		const engine = makeEngine({
			resolveAgent,
			childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: ["-e", script, "--", ...args] }) },
		});
		const result = await engine.run({ agent: "a", task: "probe", model: "stub/m", mcp: true });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "agent", "a local host module failure must never trigger model/provider recovery");
		assert.equal(result.modelUsed, "stub/m");
		assert.ok(result.error?.includes(original), "the original missing-module path and importer remain available");
		assert.match(result.error ?? "", /local Pi host bundle/i);
		assert.match(result.error ?? "", /updated in place/i);
		assert.match(result.error ?? "", /fresh Pi process.*same provider\/model/i);
		assert.match(result.error ?? "", /only if.*fresh process.*fails.*repair/i);
		assert.doesNotMatch(result.error ?? "", /MCP adapter likely hung initializing/, "a known host-module failure is not an MCP authentication diagnosis");
	});
}

for (const cause of ["abort", "timeout"] as const) {
	test(`child adapter ${cause} takes precedence over a missing Pi host bundle chunk`, async () => {
		const ac = new AbortController();
		const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: HOST_MODULE_ERROR }], stopReason: "error", errorMessage: HOST_MODULE_ERROR } };
		const script = `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")}); setInterval(() => {}, 1000);`;
		let sawError = false;
		const engine = makeEngine({
			resolveAgent,
			childOptions: {
				timeoutMs: 200,
				// The idle deadline must test silence AFTER the diagnostic, not cold process
				// scheduling under suite load. The hard cap still bounds a broken fixture.
				isBlocked: () => !sawError,
				hardTimeoutMs: 10_000,
				killGraceMs: 20,
				resolveInvocation: (args) => ({ command: process.execPath, args: ["-e", script, "--", ...args] }),
			},
		});
		const result = await engine.run({ agent: "a", task: "probe" }, (progress) => {
			// A final empty progress tick also fires on death; it is not evidence of the error.
			if (sawError || !progress.output.includes(HOST_MODULE_ERROR)) return;
			sawError = true;
			if (cause === "abort") ac.abort();
		}, ac.signal);
		assert.ok(sawError, "the host error was received before cancellation");
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, cause);
	});
}

test("child adapter keeps a pre-stream non-provider death as agent (terminal)", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "boom [fail]" });
	assert.equal(r.ok, false);
	// [fail] reports stopReason error ("stub failure") — a stream-level error stays provider;
	// a plain non-zero exit with no provider evidence stays agent.
});

test("child adapter prefers the child's STREAM-REPORTED model for modelUsed", async () => {
	const engine = makeEngine({ resolveAgent, contracts, childOptions: { resolveInvocation: resolveFake } });
	const r = await engine.run({ agent: "a", task: "do it", model: "alias/some-model" });
	assert.equal(r.modelUsed, "stub/model", "what actually RAN seeds the fallback chain, not the requested alias");
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

test("child adapter steer metadata mirrors broker pending-ask state for its registered handle", { timeout: 3000 }, async () => {
	let pending = false;
	let registeredHandle = "";
	const broker = {
		endpoint: "fake-endpoint",
		register: ({ handle }: { handle: string }) => { registeredHandle = handle; },
		unregister: (handle: string) => { if (handle === registeredHandle) registeredHandle = ""; },
		steerFrame: () => true,
		prepareResultReader: async () => { throw new Error("no reader grant"); },
		hasPendingAskFrom: (handle: string) => handle === registeredHandle && pending,
	};
	const ac = new AbortController();
	const engine = makeEngine({
		resolveAgent,
		contracts,
		broker,
		signal: ac.signal,
		childOptions: { resolveInvocation: resolveFake, timeoutMs: 100, killGraceMs: 100 },
	});
	let waiting: (() => boolean) | undefined;
	const run = engine.run({ agent: "a", task: "wait [sleep]" }, undefined, undefined, (steer) => {
		waiting = steer.isWaitingForSupervisor;
	});
	assert.equal(waiting?.(), false);
	pending = true;
	assert.equal(waiting?.(), true);
	ac.abort();
	const result = await run;
	assert.equal(result.failureKind, "abort");
	assert.equal(waiting?.(), false, "unregistered/settled leg reports false");
});

test("child adapter re-arms the idle watchdog while the broker reports a pending ask from this leg", { timeout: 3000 }, async () => {
	const broker = { endpoint: "fake-endpoint", register: () => {}, unregister: () => {}, steerFrame: () => true, hasPendingAskFrom: () => true , prepareResultReader: async () => { throw new Error("no reader grant"); } };
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 400);
	const engine = makeEngine({
		resolveAgent,
		contracts,
		broker,
		signal: ac.signal,
		childOptions: { resolveInvocation: resolveFake, timeoutMs: 100, killGraceMs: 100 },
	});
	const r = await engine.run({ agent: "a", task: "wait [sleep]" });
	assert.notEqual(r.failureKind, "timeout", "a leg the bus reports as blocked is not idle-killed");
	assert.equal(r.failureKind, "abort");
});

test("child adapter idle-kills once the broker reports no pending ask from this leg", { timeout: 3000 }, async () => {
	const broker = { endpoint: "fake-endpoint", register: () => {}, unregister: () => {}, steerFrame: () => true, hasPendingAskFrom: () => false , prepareResultReader: async () => { throw new Error("no reader grant"); } };
	const engine = makeEngine({
		resolveAgent,
		contracts,
		broker,
		childOptions: { resolveInvocation: resolveFake, timeoutMs: 100, killGraceMs: 100 },
	});
	const r = await engine.run({ agent: "a", task: "wait [sleep]" });
	assert.equal(r.failureKind, "timeout", "no pending ask ⇒ the silence is real");
});

// ── reference-mode handoff (frozen contract): strict child preflight + token wiring ──

const REF_OK = "result:00000000-0000-4000-8000-0000000000aa";
const REF_OTHER = "result:00000000-0000-4000-8000-0000000000bb";

function referenceArchiveFixture() {
	const entries: unknown[] = [];
	const archive = new TerminalResultArchive({
		entries: () => entries,
		persistent: true,
		makeRef: () => REF_OK,
		append: (type, data) => { entries.push({ type: "custom", customType: type, data: structuredClone(data) }); },
	});
	const outcome = archive.save({ originKey: "origin:one", status: "done", agent: "reviewer", body: "ARCHIVED REPORT BODY", provenance: "result-output" });
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	return archive;
}

const fullBroker = (log: string[], token = "a".repeat(64), revoked: { count: number } = { count: 0 }) => ({
	endpoint: "pipe",
	register: (info: { handle: string }) => { log.push(`register:${info.handle}`); },
	unregister: (handle: string) => { log.push(`unregister:${handle}`); },
	steerFrame: () => true,
	hasPendingAskFrom: () => false,
	prepareResultReader: async (handle: string) => {
		log.push(`prepare:${handle}`);
		return { token, revoke: () => { revoked.count += 1; }, wasBound: () => false };
	},
});

const envDump = (marker: string) => {
	const script = `const NL=String.fromCharCode(10);const t=process.env.PI_PERSONA_RESULT_READER_TOKEN??'unset';process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'${marker} token='+t+' busTools='+(process.env.PI_PERSONA_BUS_TOOLS??'unset')}],stopReason:'stop'}})+NL);`;
	return (args: string[]) => ({ command: process.execPath, args: ["-e", script, "--", ...args] });
};

test("child broker admits granted communication tools into a nonempty plain allowlist", async () => {
	for (const peers of [false, true]) {
		let seen: string[] = [];
		const engine = makeEngine({ resolveAgent: () => ({ ...agents.a!, tools: ["read"], source: "x" }), broker: fullBroker([]),
			childOptions: { resolveInvocation: (args) => { seen = [...args]; return envDump("comms")(args); } } });
		const result = await engine.run({ agent: "a", task: "t", peers });
		assert.equal(result.ok, true);
		assert.match(result.output, /busTools=on/);
		assert.equal(seen[seen.indexOf("--tools") + 1], peers ? "read,contact_supervisor,contact_peer" : "read,contact_supervisor");
	}
});

test("bus denial and explicit empty tools never acquire a bridge tool grant", async () => {
	for (const empty of [false, true]) {
		let seen: string[] = [];
		const engine = makeEngine({ resolveAgent: () => ({ ...agents.a!, tools: empty ? [] : ["read"], source: "x" }),
			broker: fullBroker([]), canUseBus: false,
			childOptions: { resolveInvocation: (args) => { seen = [...args]; return envDump("denied")(args); } } });
		const result = await engine.run({ agent: "a", task: "t", peers: true });
		assert.equal(result.ok, true);
		assert.match(result.output, /busTools=off/);
		if (empty) assert.ok(seen.includes("--no-tools"));
		else assert.equal(seen[seen.indexOf("--tools") + 1], "read");
	}
});

test("child reference preflight makes ZERO spawns when broker, binding, storage or refs are missing", { timeout: 10000 }, async () => {
	const cases: Array<{ label: string; broker?: ReturnType<typeof fullBroker>; refs: string[]; match: RegExp; canUseBus?: boolean }> = [
		{ label: "broker absent", refs: [REF_OK], match: /broker/, canUseBus: true },
		{ label: "reader binding refused", broker: (() => { const log: string[] = []; return { ...fullBroker(log), prepareResultReader: async () => { throw new Error("Result reader preparation failed."); } }; })(), refs: [REF_OK], match: /broker result reader/, canUseBus: true },
		{ label: "ref unavailable in the archive", broker: fullBroker([]), refs: [REF_OTHER], match: new RegExp(REF_OTHER), canUseBus: true },
		{ label: "parent bus capability denied", broker: fullBroker([]), refs: [REF_OK], match: /bus/, canUseBus: false },
	];
	for (const { label, broker, refs, match, canUseBus } of cases) {
		let invoked = false;
		const deps: EngineAdapterDeps = {
			resolveAgent,
			childOptions: { resolveInvocation: (args) => { invoked = true; return envDump("case")(args); } },
			resultArchive: () => referenceArchiveFixture(),
			...(broker ? { broker } : {}),
			...(canUseBus === false ? { canUseBus: false } : {}),
		};
		const r = await makeEngine(deps).run({ agent: "a", task: "t", resultRefs: refs });
		assert.equal(r.ok, false, label);
		assert.equal(r.failureKind, "contract", label);
		assert.deepEqual(r.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, `${label}: zero usage`);
		assert.match(r.error ?? "", match, label);
		assert.equal(invoked, false, `${label}: no child may spawn`);
	}
});

test("child reference handoff prepares the reader before registration, passes the token env, admits read_result and revokes on settle", { timeout: 10000 }, async () => {
	const log: string[] = [];
	const revoked = { count: 0 };
	const token = "b".repeat(64);
	const broker = fullBroker(log, token, revoked);
	let argsSeen: string[] = [];
	const engine = makeEngine({
		resolveAgent: () => ({ ...agents.a!, tools: ["read"], source: "x" }),
		broker,
		resultArchive: () => referenceArchiveFixture(),
		childOptions: { resolveInvocation: (args) => { argsSeen = [...args]; return envDump("wire")(args); } },
	});
	const r = await engine.run({ agent: "a", task: "t", resultRefs: [REF_OK] });
	assert.equal(r.ok, true, r.error);
	assert.match(r.output ?? "", new RegExp(`token=${token}`), "the child received the reader token in its environment");
	const toolsAt = argsSeen.indexOf("--tools");
	assert.ok(toolsAt >= 0, "an allowlist was forwarded");
	assert.equal(argsSeen[toolsAt + 1], "read,read_result,contact_supervisor", "the scoped reader and granted supervisor contact join the admitted tools");
	const firstPrepare = log.findIndex((e) => e.startsWith("prepare:"));
	const firstRegister = log.findIndex((e) => e.startsWith("register:"));
	assert.ok(firstPrepare >= 0 && firstRegister >= 0);
	assert.ok(firstPrepare < firstRegister, "prepareResultReader completes BEFORE registration");
	assert.ok(log.some((e) => e.startsWith("unregister:")), "the leg unregisters on settle");
	assert.equal(revoked.count, 1, "the broker reader grant is revoked when the leg settles");
});

test("child reference handoff keeps an absent allowlist absent (no --tools) and does not double-revoke", { timeout: 10000 }, async () => {
	const log: string[] = [];
	const revoked = { count: 0 };
	let argsSeen: string[] = [];
	const engine = makeEngine({
		resolveAgent,
		broker: fullBroker(log, "c".repeat(64), revoked),
		resultArchive: () => referenceArchiveFixture(),
		childOptions: { resolveInvocation: (args) => { argsSeen = [...args]; return envDump("absent")(args); } },
	});
	const r = await engine.run({ agent: "a", task: "t", resultRefs: [REF_OK] });
	assert.equal(r.ok, true, r.error);
	assert.ok(!argsSeen.includes("--tools"), "an absent allowlist stays absent — the bridge injects read_result itself");
	assert.equal(revoked.count, 1);
});

test("child engine scrubs a stale supervisor PI_PERSONA_RESULT_READER_TOKEN from a plain leg's environment", { timeout: 10000 }, async () => {
	process.env.PI_PERSONA_RESULT_READER_TOKEN = "stale-supervisor-token";
	process.env.PI_PERSONA_BUS_TOOLS = "off";
	try {
		let dumped = "";
		const engine = makeEngine({
			resolveAgent,
			childOptions: { resolveInvocation: envDump("scrub") },
		});
		const r = await engine.run({ agent: "a", task: "t" });
		dumped = r.output;
		assert.equal(r.ok, true, r.error);
		assert.match(dumped, /token=unset/, "a stale supervisor token must never leak into a plain child");
		assert.match(dumped, /busTools=unset/, "a stale bus-tool grant/deny must never leak into a plain child");
	} finally {
		delete process.env.PI_PERSONA_RESULT_READER_TOKEN;
		delete process.env.PI_PERSONA_BUS_TOOLS;
	}
});

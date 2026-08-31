import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { runChildAgent } from "../../src/engine/child.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

function resolveJsonBurst(events: unknown[]): () => { command: string; args: string[] } {
	const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	const script = `process.stdout.write(${JSON.stringify(payload)})`;
	return () => ({ command: process.execPath, args: ["-e", script] });
}

test("runChildAgent spawns a child, parses output + usage, and reports success", async () => {
	const r = await runChildAgent({ task: "do the thing" }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, true);
	assert.equal(r.exitCode, 0);
	assert.match(r.output, /echo: Task: do the thing/);
	assert.equal(r.usage.input, 5);
	assert.equal(r.usage.output, 3);
	assert.equal(r.usage.turns, 1);
	assert.equal(r.model, "stub/model");
	assert.equal(r.stopReason, "end");
	assert.equal(r.aborted, false);
});

test("runChildAgent passes model/tool allow+deny flags through to the child", async () => {
	const seen: string[] = [];
	const r = await runChildAgent({ task: "x", model: "prov/m", tools: ["read", "grep", "edit"], excludeTools: ["edit"] }, undefined, {
		resolveInvocation: (args) => {
			seen.push(...args);
			return resolveFake(args);
		},
	});
	assert.equal(r.ok, true);
	assert.ok(seen.includes("--model") && seen.includes("prov/m"));
	assert.ok(seen.includes("--tools") && seen.includes("read,grep,edit"));
	assert.ok(seen.includes("--exclude-tools") && seen.includes("edit"));
	assert.ok(seen.includes("--no-session"));
});

test("runChildAgent turns an explicit empty tool allowlist into --no-tools", async () => {
	const seen: string[] = [];
	const r = await runChildAgent({ task: "x", tools: [] }, undefined, {
		resolveInvocation: (args) => {
			seen.push(...args);
			return resolveFake(args);
		},
	});
	assert.equal(r.ok, true);
	assert.ok(seen.includes("--no-tools"), "[] is deny-all, not an absent/default tool grant");
	assert.equal(seen.includes("--tools"), false);
});

test("runChildAgent disables pi-persona in the spawned child (prevents fork-bomb recursion)", async () => {
	const r = await runChildAgent({ task: "check [env]" }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, true);
	assert.match(r.output, /PI_PERSONA_DISABLE=1/);
	assert.match(r.output, /PI_PERSONA_CHILD=1/);
	assert.match(r.output, /PI_PERSONA_LEG=1/, "the dedicated worker-leg marker is exported to the child");
});

test("runChildAgent reports live progress via onProgress", async () => {
	const snaps: Array<{ output: string; turns: number; tokens: number }> = [];
	const r = await runChildAgent({ task: "do it" }, undefined, {
		resolveInvocation: resolveFake,
		onProgress: (s) => snaps.push(s),
	});
	assert.equal(r.ok, true);
	assert.ok(snaps.length >= 1, "onProgress called at least once");
	assert.match(snaps[snaps.length - 1]!.output, /echo: Task: do it/);
});

test("runChildAgent coalesces one non-tool stdout chunk to one live update plus the final settle", async () => {
	const events = Array.from({ length: 32 }, (_, i) => ({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: `partial-${i}` }] },
	}));
	const snaps: unknown[] = [];
	const result = await runChildAgent({ task: "burst" }, undefined, {
		resolveInvocation: resolveJsonBurst(events),
		onProgress: (snap) => snaps.push(snap),
	});

	assert.equal(result.ok, true);
	assert.equal(snaps.length, 2, "the 32 parsed lines share one chunk update; finish adds one terminal snapshot");
});

test("runChildAgent emits each lifecycle tool transition exactly once without per-line noise", async () => {
	const events = [
		{ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "secret" } },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "secret" } },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { output: "secret" }, isError: false },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { output: "secret" }, isError: false },
	];
	const snaps: Array<{ toolEvent?: unknown }> = [];
	const result = await runChildAgent({ task: "tool burst" }, undefined, {
		resolveInvocation: resolveJsonBurst(events),
		onProgress: (snap) => snaps.push(snap),
	});

	assert.equal(result.ok, true);
	assert.deepEqual(snaps.flatMap((snap) => snap.toolEvent ? [snap.toolEvent] : []), [
		{ phase: "start", callId: "call-1", name: "read" },
		{ phase: "end", callId: "call-1", name: "read", failed: false },
	]);
	assert.equal(snaps.length, 4, "two lifecycle transitions + one coalesced chunk update + final settle");
});

test("runChildAgent surfaces an error stop reason as a failure", async () => {
	const r = await runChildAgent({ task: "boom [fail]" }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, false);
	assert.equal(r.stopReason, "error");
	assert.equal(r.errorMessage, "stub failure");
});

test("runChildAgent kills a hung child after timeoutMs and reports the timeout (timedOut, not aborted)", async () => {
	const r = await runChildAgent({ task: "hang [sleep]" }, undefined, {
		resolveInvocation: resolveFake,
		killGraceMs: 200,
		timeoutMs: 150,
	});
	assert.equal(r.timedOut, true, "timeout is reported via timedOut");
	assert.equal(r.aborted, false, "a timeout is NOT an abort");
	assert.equal(r.ok, false);
	assert.match(r.errorMessage ?? "", /timed out/);
});

test(
	"runChildAgent escalates to a force tree-kill when the child ignores SIGTERM",
	{ skip: process.platform === "win32" },
	async () => {
		const killed: number[] = [];
		const r = await runChildAgent({ task: "stubborn [ignore-term]" }, undefined, {
			resolveInvocation: resolveFake,
			timeoutMs: 120,
			killGraceMs: 120,
			killProcessTree: (pid) => {
				killed.push(pid);
				process.kill(pid, "SIGKILL"); // SIGKILL can't be caught → child actually dies
			},
		});
		assert.equal(killed.length, 1, "escalation fired exactly once via the kill seam");
		assert.equal(r.timedOut, true);
		assert.equal(r.aborted, false);
		assert.equal(r.ok, false);
	},
);

test("runChildAgent startup-deadline kills a child that makes NO progress within startupTimeoutMs", async () => {
	// [sleep] emits nothing (a stalled init: e.g. a headless mcp:true leg whose MCP adapter hangs).
	// The idle window is long here, so ONLY the startup deadline can settle it.
	const r = await runChildAgent({ task: "hang [sleep]" }, undefined, {
		resolveInvocation: resolveFake,
		killGraceMs: 200,
		startupTimeoutMs: 150,
		timeoutMs: 5_000, // idle window long → proves the STARTUP deadline (not idle) fired
	});
	assert.equal(r.timedOut, true, "a startup-deadline kill is timeout-class");
	assert.equal(r.aborted, false, "a startup deadline is NOT an abort");
	assert.equal(r.ok, false);
	assert.match(r.errorMessage ?? "", /startup window/);
	// The deadline cannot tell a stalled init from a first provider response slower than the
	// window (a queued or rate-limited provider, a cold local model), and only the assistant's
	// own progress disarms it — so the message must offer both readings and name the knob
	// instead of asserting a leg that may well have started never did.
	assert.match(r.errorMessage ?? "", /provider/, "names the slow-first-response reading too");
	assert.match(r.errorMessage ?? "", /PI_PERSONA_AGENT_STARTUP_MS/, "names the knob that raises or disables it");
});

test("runChildAgent startup-deadline still fires when pi echoes the delivered prompt and then stalls", async () => {
	// The echoed USER prompt is pi-persona's own task coming back — not child progress. If it
	// counted, the deadline would be disarmed at prompt delivery and a first-provider-request
	// hang could only be caught by the far longer idle window.
	const r = await runChildAgent({ task: "stall [echo-then-hang]" }, undefined, {
		resolveInvocation: resolveFake,
		killGraceMs: 200,
		startupTimeoutMs: 150,
		timeoutMs: 5_000, // idle window long → proves the STARTUP deadline (not idle) fired
	});
	assert.equal(r.timedOut, true);
	assert.equal(r.ok, false);
	assert.match(r.errorMessage ?? "", /startup window/);
	assert.equal(r.output, "", "the echoed prompt is never salvaged as the leg's output");
});

test(
	"runChildAgent reports a child killed by an external signal as a failure, not a clean success",
	{ skip: process.platform === "win32" },
	async () => {
		// code=null on a signal death must not become exit 0: none of the engine's own kill
		// flags are set, so a bare `code ?? 0` would hand the supervisor truncated mid-run
		// output as a valid result.
		const r = await runChildAgent({ task: "die [self-signal]" }, undefined, { resolveInvocation: resolveFake });
		assert.equal(r.ok, false, "an externally killed child is not a success");
		assert.notEqual(r.exitCode, 0);
		assert.equal(r.aborted, false, "the engine did not initiate this kill");
		assert.equal(r.timedOut, false);
		assert.match(r.errorMessage ?? "", /SIGKILL/);
	},
);

test("runChildAgent startup-deadline does NOT fire once the child makes progress", async () => {
	// A normal child completes a turn (progress) almost immediately, cancelling the deadline.
	const r = await runChildAgent({ task: "do the thing" }, undefined, {
		resolveInvocation: resolveFake,
		startupTimeoutMs: 2_000,
	});
	assert.equal(r.ok, true);
	assert.equal(r.timedOut, false, "progress cancels the startup deadline");
});

test("runChildAgent caps retained stderr and marks it truncated", async () => {
	const r = await runChildAgent({ task: "loud [spew-stderr]" }, undefined, {
		resolveInvocation: resolveFake,
		maxStderrBytes: 1000,
	});
	assert.equal(r.ok, true, "a normal exit is still a success despite noisy stderr");
	assert.ok(r.stderr.length <= 1000 + 32, "stderr is bounded near the cap");
	assert.match(r.stderr, /\[stderr truncated\]/);
});

test("runChildAgent hard-caps an actively-emitting child the idle window would never catch", async () => {
	// [drip] emits every 150ms, (re)arming the idle clock forever — so a long idle timeoutMs
	// never fires. Only the total-lifetime hard cap can stop a busy-but-non-converging child.
	const r = await runChildAgent({ task: "busy [drip]" }, undefined, {
		resolveInvocation: resolveFake,
		killGraceMs: 200,
		timeoutMs: 5_000, // idle window: long → does NOT fire here
		hardTimeoutMs: 250, // total lifetime cap → fires despite the drip
	});
	assert.equal(r.timedOut, true, "the hard cap is reported as a timeout-class death");
	assert.equal(r.aborted, false, "a hard cap is NOT an external abort");
	assert.equal(r.ok, false);
	assert.match(r.errorMessage ?? "", /hard cap/);
});

test("the timeout is idle-based — a child that keeps emitting is NOT killed (total runtime > the window)", async () => {
	// Window vs fixture: [drip] emits at 0ms then every 150ms until ~600ms — each gap
	// (150ms) sits well under the 500ms window while the total run exceeds it. The
	// slack absorbs node.exe boot latency under parallel-suite load (flaked at 100ms).
	const r = await runChildAgent({ task: "busy [drip]" }, undefined, { resolveInvocation: resolveFake, timeoutMs: 500 });
	assert.equal(r.timedOut, false, "output (re)arms the idle clock, so an active child survives");
	assert.equal(r.ok, true);
});

test("runChildAgent delivers a HUGE task intact over stdin (beyond any argv length cap)", async () => {
	// Flow phases embed upstream outputs in the task — far beyond Windows' ~32 KiB
	// command-line limit. The stdin path must carry it byte-for-byte.
	const big = `count me [len] ${"x".repeat(200_000)}`;
	const r = await runChildAgent({ task: big }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, true);
	assert.equal(r.output, `len: ${`Task: ${big}`.length}`, "the child received the full task");
});

test("runChildAgent surfaces a spawn failure (ENOENT) in errorMessage instead of swallowing it", async () => {
	const r = await runChildAgent({ task: "x" }, undefined, {
		resolveInvocation: () => ({ command: "definitely-not-a-real-binary-xyz", args: [] }),
	});
	assert.equal(r.ok, false);
	assert.equal(r.exitCode, 1);
	assert.match(r.errorMessage ?? "", /failed to spawn pi:/);
});

test("runChildAgent aborts a running child via the AbortSignal", async () => {
	const ac = new AbortController();
	const p = runChildAgent({ task: "wait [sleep]" }, ac.signal, { resolveInvocation: resolveFake, killGraceMs: 200 });
	setTimeout(() => ac.abort(), 100);
	const r = await p;
	assert.equal(r.aborted, true);
	assert.equal(r.ok, false);
});

test("runChildAgent closes every still-running tool when the child is killed mid-tool", async () => {
	// A killed child never emits the tool_execution_end for whatever it was running, so without a
	// synthetic close the consumer shows that tool "running" forever.
	const payload = [
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "secret" } },
		{ type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { cmd: "build" } },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { output: "secret" }, isError: false },
	].map((event) => `${JSON.stringify(event)}\n`).join("");
	// Emit the burst, then hang: only the idle watchdog can settle this child.
	const script = `process.stdout.write(${JSON.stringify(payload)});setInterval(() => {}, 1000)`;
	const snaps: Array<{ toolEvent?: unknown }> = [];
	const r = await runChildAgent({ task: "hang mid-tool" }, undefined, {
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", script] }),
		killGraceMs: 200,
		timeoutMs: 250,
		onProgress: (snap) => snaps.push(snap),
	});

	assert.equal(r.timedOut, true);
	assert.deepEqual(snaps.flatMap((snap) => snap.toolEvent ? [snap.toolEvent] : []), [
		{ phase: "start", callId: "call-1", name: "read" },
		{ phase: "start", callId: "call-2", name: "bash" },
		{ phase: "end", callId: "call-1", name: "read", failed: false },
		{ phase: "end", callId: "call-2", name: "bash", failed: true },
	], "the call that really ended keeps its own outcome; only the abandoned one is synthesised as failed");
});

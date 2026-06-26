import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { runChildAgent } from "../../src/engine/child.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });

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

test("runChildAgent passes model/tools flags through to the child", async () => {
	const seen: string[] = [];
	const r = await runChildAgent({ task: "x", model: "prov/m", tools: ["read", "grep"] }, undefined, {
		resolveInvocation: (args) => {
			seen.push(...args);
			return resolveFake(args);
		},
	});
	assert.equal(r.ok, true);
	assert.ok(seen.includes("--model") && seen.includes("prov/m"));
	assert.ok(seen.includes("--tools") && seen.includes("read,grep"));
	assert.ok(seen.includes("--no-session"));
});

test("runChildAgent disables pi-persona in the spawned child (prevents fork-bomb recursion)", async () => {
	const r = await runChildAgent({ task: "check [env]" }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, true);
	assert.match(r.output, /PI_PERSONA_DISABLE=1/);
	assert.match(r.output, /PI_PERSONA_CHILD=1/);
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

test("runChildAgent surfaces an error stop reason as a failure", async () => {
	const r = await runChildAgent({ task: "boom [fail]" }, undefined, { resolveInvocation: resolveFake });
	assert.equal(r.ok, false);
	assert.equal(r.stopReason, "error");
	assert.equal(r.errorMessage, "stub failure");
});

test("runChildAgent kills a hung child after timeoutMs and reports the timeout", async () => {
	const r = await runChildAgent({ task: "hang [sleep]" }, undefined, {
		resolveInvocation: resolveFake,
		killGraceMs: 200,
		timeoutMs: 150,
	});
	assert.equal(r.aborted, true);
	assert.equal(r.ok, false);
	assert.match(r.errorMessage ?? "", /timed out/);
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

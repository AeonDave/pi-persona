import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMonitorTool } from "../../../src/tools/monitor.ts";

function harness(allowed = true) {
	let tool: any;
	const started: any[] = [];
	const cancelled: string[] = [];
	registerMonitorTool({ registerTool: (t: unknown) => { tool = t; } } as unknown as ExtensionAPI, {
		lastCtx: undefined,
		canRun: () => allowed,
		monitors: {
			arm(spec: any) { started.push(spec); return { ok: true as const, entry: { ...spec, id: "monitor-1", startedAtEpochMs: 0, expiresAtEpochMs: 60_000 } }; },
			list: () => [],
			cancel: (id: string) => { cancelled.push(id); return true; },
		},
	});
	const run = (params: unknown, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, { cwd: "D:/project" });
	return { run, started, cancelled };
}

test("monitor requires execution permission before starting a background process", async () => {
	const h = harness(false);
	const result = await h.run({ action: "arm", command: "node", args: ["watch.mjs"], label: "build", mode: "exit" });
	assert.equal(result.details.ok, false);
	assert.equal(h.started.length, 0);
	assert.match(result.content[0].text, /bash/);
});

test("monitor launches an explicit executable and argv in the current workspace", async () => {
	const h = harness();
	const result = await h.run({ action: "arm", command: "node", args: ["watch a file.mjs"], label: "watch", mode: "output" });
	assert.equal(result.details.ok, true);
	assert.equal(h.started[0].cwd, "D:/project");
	assert.deepEqual(h.started[0].args, ["watch a file.mjs"]);
	assert.match(result.content[0].text, /session.*open/i);
});

test("monitor does not arm on an already aborted tool call", async () => {
	const h = harness();
	const result = await h.run({ action: "arm", command: "node", label: "watch", mode: "output" }, AbortSignal.abort());
	assert.equal(result.details.ok, false);
	assert.equal(h.started.length, 0);
});

test("monitor validates action arguments instead of launching malformed requests", async () => {
	const h = harness();
	for (const params of [
		{ action: "unexpected", command: "node" },
		{ action: "arm", command: "node", label: "watch" },
		{ action: "arm", command: "node", label: "watch", mode: "exit", timeoutSeconds: Number.NaN },
		{ action: "arm", command: "node", label: "watch", mode: "exit", args: [2] },
		{ action: "cancel" },
	]) assert.equal((await h.run(params)).details.ok, false);
	assert.equal(h.started.length, 0);
});

test("monitor cancellation remains available when command execution is denied", async () => {
	const h = harness(false);
	assert.equal((await h.run({ action: "cancel", id: "monitor-1" })).details.ok, true);
	assert.deepEqual(h.cancelled, ["monitor-1"]);
});

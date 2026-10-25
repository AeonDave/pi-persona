import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMonitorTool } from "../../../src/tools/monitor.ts";

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function harness(allowed = true, archive?: any) {
	let tool: any;
	const started: any[] = [];
	const cancelled: string[] = [];
	registerMonitorTool({ registerTool: (t: unknown) => { tool = t; } } as unknown as ExtensionAPI, {
		lastCtx: undefined,
		canRun: () => allowed,
		...(archive ? { archive } : {}),
		monitors: {
			arm(spec: any) { started.push(spec); return { ok: true as const, entry: { ...spec, id: "monitor-1", startedAtEpochMs: 0, expiresAtEpochMs: 60_000 } }; },
			list: () => [],
			cancel: (id: string) => { cancelled.push(id); return true; },
		},
	});
	const run = (params: unknown, signal?: AbortSignal, hasUI?: boolean) => tool.execute("call", params, signal, undefined, { cwd: "D:/project", ...(hasUI === undefined ? {} : { hasUI }) });
	return { run, started, cancelled, tool };
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

test("monitor says the truth in a headless run instead of inviting the model to end its turn", async () => {
	const h = harness();
	const headless = await h.run({ action: "arm", command: "node", label: "watch", mode: "exit" }, undefined, false);
	assert.equal(headless.details.ok, true);
	assert.match(headless.content[0].text, /Headless pi -p: the process exits when this turn settles/);
	assert.doesNotMatch(headless.content[0].text, /wakes you by itself/);
	const ui = await h.run({ action: "arm", command: "node", label: "watch", mode: "exit" }, undefined, true);
	assert.match(ui.content[0].text, /end your turn; it wakes you by itself/);
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

test("monitor schema documents the aggregate argv bound", () => {
	const { tool } = harness();
	const args = (tool.parameters as any).properties.args;
	assert.match(String(args.description), /24[,_ ]?000/);
	assert.match(String(tool.description), /24[,_ ]?000/);
});

test("monitor retrieves retained logs without starting work or requiring bash execution", async () => {
	const record = {
		version: 1, entry: { id: "monitor-old-1", label: "build", mode: "exit" },
		outcome: "exit", text: "process exited with exit code 1", stdout: "built\n", stderr: "untrusted diagnostic\n", truncated: true,
	};
	const h = harness(false, { result: (id: string) => id === record.entry.id ? record : undefined, list: () => [record] });
	const result = await h.run({ action: "result", id: record.entry.id });
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /exit code 1/);
	assert.match(result.content[0].text, /untrusted/);
	assert.match(result.content[0].text, /truncat|bounded/i);
	assert.match(result.content[0].text, /stdout[\s\S]*built[\s\S]*stderr/);
	assert.equal(h.started.length, 0);
	const list = await h.run({ action: "result" });
	assert.match(list.content[0].text, /monitor-old-1/);
	assert.equal((await h.run({ action: "result", id: "missing" })).details.ok, false);
});

test("monitor result reports unavailable storage and bounds displayed logs", async () => {
	assert.match((await harness().run({ action: "result", id: "old" })).content[0].text, /unavailable/i);
	const record = {
		entry: { id: "monitor-1", label: "build" }, outcome: "cancelled", text: "cancelled",
		stdout: "x".repeat(100_000), stderr: "\u001b[31mred\u001b[0m", truncated: false, storageWarning: "session log quota reached",
	};
	const h = harness(true, { result: () => record, list: () => [record] });
	const result = await h.run({ action: "result", id: "monitor-1" });
	assert.ok(result.content[0].text.length < 12_000);
	assert.doesNotMatch(result.content[0].text, /\u001b/);
	assert.match(result.content[0].text, /quota/);
	const full = await h.run({ action: "result", id: "monitor-1", full: true });
	assert.ok(full.content[0].text.length > result.content[0].text.length);
	assert.ok(full.content[0].text.length < 20_000, "even full reads remain bounded");
});

test("recovered monitor log reads neutralize bidi, escapes and Unicode separators without changing retained bytes", async () => {
	const bidi = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
	const hostile = `**literal** ${bidi}safe.exe\u001b[2J\u001b]0;spoofed title\u0007\u2028line\u2029end\r\nnext`;
	const record = {
		entry: { id: "monitor-1", label: "build" }, outcome: "exit", text: `process exited with exit code 0\n${hostile}`,
		stdout: hostile, stderr: hostile, truncated: false,
	};
	const h = harness(false, { result: () => record, list: () => [record] });
	const before = JSON.stringify(record);
	for (const full of [false, true]) {
		const result = await h.run({ action: "result", id: "monitor-1", full });
		const rendered = result.content[0].text;
		assert.doesNotMatch(rendered, /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\u001b\u0007]/);
		assert.ok(rendered.includes("> **literal** safe.exe line end\n> next"), rendered);
		assert.match(rendered, /Sub-agent output \(untrusted data\):/);
		assert.doesNotMatch(rendered, /spoofed title/);
		assert.equal(JSON.stringify(record), before, "normal/full reads leave archived raw captures untouched");
	}
	assert.equal(h.started.length, 0);
});

test("monitor description makes session-wide archive visibility explicit", () => {
	assert.match(String(harness().tool.description), /whole session tree.*sibling conversation branches/i);
	assert.match(String(harness().tool.description), /branch navigation does not hide captures/i);
});

test("monitor description is a wake source, not a wait", () => {
	assert.match(String(harness().tool.description), /not a wait.*`timer`.*sub-agents and Exocom wake you/i);
});

function renderHarness() {
	let tool: any;
	registerMonitorTool({ registerTool: (t: unknown) => { tool = t; } } as unknown as ExtensionAPI, {
		lastCtx: undefined,
		canRun: () => true,
		monitors: {
			arm(spec: any) { return { ok: true as const, entry: { ...spec, id: "monitor-1", startedAtEpochMs: Date.now(), expiresAtEpochMs: Date.now() + 90_000 } }; },
			list: () => [],
			cancel: () => true,
		},
	});
	return tool;
}

const armResult = async (tool: any) => tool.execute("call", { action: "arm", command: "node", label: "build finished", mode: "output" }, undefined, undefined, { cwd: "D:/project" });

test("monitor arm result card collapses to label, mode and a relative deadline — no advice paragraph, no ISO", async () => {
	const tool = renderHarness();
	const result = await armResult(tool);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.id, "monitor-1");
	assert.equal(result.details.label, "build finished");
	assert.equal(result.details.mode, "output");
	const before = JSON.stringify(result);
	const raw = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(200).join("\n");
	const collapsed = stripVTControlCharacters(raw);
	assert.match(collapsed, /armed build finished · output/);
	assert.match(collapsed, /deadline in /);
	assert.doesNotMatch(collapsed, /wakes on relevant stdout lines|wakes you by itself|sleep, poll/);
	assert.doesNotMatch(collapsed, /\d{4}-\d{2}-\d{2}T/);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
});

test("monitor arm card expands to the complete literal receipt", async () => {
	const tool = renderHarness();
	const result = await armResult(tool);
	const before = JSON.stringify(result);
	const expanded = stripVTControlCharacters(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(400).join("\n"));
	assert.match(expanded, /Armed monitor-1 \(build finished\)/);
	assert.match(expanded, /Deadline \d{4}-\d{2}-\d{2}T/);
	assert.match(expanded, /wakes you by itself/);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
});

test("monitor failed arms and non-arm actions render through the shared literal renderer", async () => {
	const tool = renderHarness();
	const failed = await tool.execute("call", { action: "arm", command: "node", label: "watch", mode: "nonsense" }, undefined, undefined, { cwd: "D:/project" });
	assert.equal(failed.details.ok, false);
	assert.equal(failed.details.label, undefined, "bounded card fields are added to arm success only");
	assert.equal(failed.details.mode, undefined);
	const raw = tool.renderResult(failed, { expanded: false }, plainTheme, { isError: true }).render(200).join("\n");
	const collapsed = stripVTControlCharacters(raw);
	assert.match(collapsed, /^failed/);
	assert.match(collapsed, /output or exit/);
	assert.doesNotMatch(collapsed, /armed /);
	assert.ok(collapsed.split("\n").length <= 6, "failed arm stays a bounded collapsed card");
	const expandedFailure = stripVTControlCharacters(tool.renderResult(failed, { expanded: true }, plainTheme, { isError: true }).render(400).join("\n"));
	assert.match(expandedFailure, /output or exit/);
	const cancel = await tool.execute("call", { action: "cancel", id: "monitor-1" }, undefined, undefined, { cwd: "D:/project" });
	const cancelCard = stripVTControlCharacters(tool.renderResult(cancel, { expanded: false }, plainTheme, { isError: false }).render(200).join("\n"));
	assert.match(cancelCard, /Cancelled monitor-1/);
	assert.doesNotMatch(cancelCard, /armed /);
	const before = JSON.stringify(cancel);
	tool.renderResult(cancel, { expanded: true }, plainTheme, { isError: false });
	assert.equal(JSON.stringify(cancel), before);
});

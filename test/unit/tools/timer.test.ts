import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TimerScheduler } from "../../../src/core/timer.ts";
import { registerTimerTool } from "../../../src/tools/timer.ts";

function harness(now = 1_000_000) {
	const tools = new Map<string, any>();
	const pi = { registerTool: (tool: { name: string }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	const timerScheduler = new TimerScheduler({
		now: () => now,
		setTimer: () => 1,
		clearTimer: () => {},
		onFire: () => {},
	});
	registerTimerTool(pi, { lastCtx: undefined, timerScheduler });
	return { tools, timerScheduler };
}

test("timer arm refuses a missing message instead of storing an empty follow-up", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", { action: "arm", delaySeconds: 60 });
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /timer arm needs \{ message \}/);
});

test("timer now returns a fresh UTC instant plus local timezone and offset", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-now", { action: "now" });
	assert.equal(result.isError, false);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /UTC 1970-01-01T00:16:40Z/);
	assert.match(text, /local .* \([^)]*; UTC[+-]\d{2}:\d{2}\)/);
});

test("timer now ignores an action-irrelevant empty message", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-now", { action: "now", message: "" });
	assert.equal(result.isError, false);
});

test("timer arm refuses a whitespace-only message instead of storing an empty follow-up", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", { action: "arm", message: "   ", delaySeconds: 60 });
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /timer arm needs \{ message \}/);
});

test("timer arm refuses neither delaySeconds nor atIso", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", { action: "arm", message: "wake me" });
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /delaySeconds.*atIso.*not neither/);
});

test("timer arm refuses both delaySeconds and atIso", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", {
		action: "arm",
		message: "wake me",
		delaySeconds: 60,
		atIso: "2026-09-02T12:00:00Z",
	});
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /delaySeconds.*atIso.*not both/);
});

test("timer arm with delaySeconds succeeds when the message and delay are present", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", { action: "arm", message: "check status", delaySeconds: 60 });
	assert.equal(result.isError, false);
	assert.match(result.content[0]?.text ?? "", /Armed timer-1/);
	assert.match(result.content[0]?.text ?? "", /fires in 1m 00s/);
	assert.match(result.content[0]?.text ?? "", /1970-01-01T00:17:40\.000Z/);
	assert.doesNotMatch(result.content[0]?.text ?? "", /check status/, "the message is in the tool call; the result does not echo it");
	assert.match(result.content[0]?.text ?? "", /You can end this turn now; keep the session open for the alarm\./);
});

test("timer arm says the truth in a headless run instead of inviting the model to end its turn", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", { action: "arm", message: "check", delaySeconds: 60 }, undefined, undefined, { hasUI: false });
	assert.equal(result.isError, false);
	assert.equal(result.details.ok, true);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /Headless pi -p: the process exits when this turn settles/);
	assert.doesNotMatch(text, /end this turn now/);
	const ui = await tools.get("timer").execute("call-2", { action: "arm", message: "check", delaySeconds: 60 }, undefined, undefined, { hasUI: true });
	assert.match(ui.content[0]?.text ?? "", /You can end this turn now/);
});

test("timer arm rejects an unqualified absolute date-time", async () => {
	const { tools } = harness();
	const result = await tools.get("timer").execute("call-1", {
		action: "arm",
		message: "check status",
		atIso: "2026-09-02T12:00:00",
	});
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /Z or a numeric timezone offset/i);
});

test("timer description states the session-open dependency and finite alarm bound", () => {
	const { tools } = harness();
	const description = String(tools.get("timer").description);
	assert.match(description, /session must remain open/i);
	assert.match(description, /32/);
	assert.match(description, /never use it to wait for a sub-agent or monitor/i);
	assert.match(description, /or to poll: if something can report the event, use `monitor`/i);
	assert.doesNotMatch(description, /nmap|Paperwork/i);
});

test("timer schema documents the runtime message and delay bounds", () => {
	const { tools } = harness();
	const properties = (tools.get("timer").parameters as any).properties;
	assert.equal(properties.message.minLength, undefined, "message is action-conditional and irrelevant to now");
	assert.equal(properties.message.maxLength, undefined, "raw maxLength would reject valid padded text before runtime trimming");
	assert.match(String(properties.message.description), /after trimming.*4000/i);
	assert.match(String(properties.delaySeconds.description), /rounded to milliseconds/i);
	assert.match(String(properties.delaySeconds.description), /1 second through 86400 seconds/i);
});

test("timer keeps valid padded messages and sub-second values that round to one second", async () => {
	const { tools, timerScheduler } = harness();
	const result = await tools.get("timer").execute("call-1", {
		action: "arm",
		message: `wake${" ".repeat(4_001)}`,
		delaySeconds: 0.9999,
	});
	assert.equal(result.isError, false);
	assert.equal(timerScheduler.list()[0]?.message, "wake");
});

// ── presentation contract: compact collapsed cards, shared literal expansion ─────────────────

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function renderHarness() {
	let tool: any;
	const pi = { registerTool: (t: unknown) => { tool = t; } } as unknown as ExtensionAPI;
	const timerScheduler = new TimerScheduler({ now: () => Date.now(), setTimer: () => 1, clearTimer: () => {}, onFire: () => {} });
	registerTimerTool(pi, { lastCtx: undefined, timerScheduler });
	return tool;
}

const armResult = (tool: any, label?: string) =>
	tool.execute("call", { action: "arm", message: "check status and summarize", delaySeconds: 90, ...(label === undefined ? {} : { label }) }, undefined, undefined, { cwd: "D:/project" });

function render(tool: any, result: unknown, expanded: boolean, isError: boolean): string {
	return stripVTControlCharacters(tool.renderResult(result, { expanded }, plainTheme, { isError }).render(400).join("\n"));
}

test("timer call card is a compact purpose line, not an argument echo", () => {
	const tool = renderHarness();
	assert.equal(typeof tool.renderCall, "function", "renderCall must exist; the host fallback echoes raw args JSON");
	const card = stripVTControlCharacters(tool.renderCall({ action: "arm", label: "status review", message: "very long wake instructions ".repeat(50) }, plainTheme).render(200).join("\n"));
	assert.match(card, /timer arm/);
	assert.match(card, /status review/);
	assert.doesNotMatch(card, /very long wake instructions/);
	assert.doesNotMatch(card, /[{}]/);
	const cancel = stripVTControlCharacters(tool.renderCall({ action: "cancel", id: "timer-3" }, plainTheme).render(200).join("\n"));
	assert.match(cancel, /timer cancel timer-3/);
});

test("timer arm result card collapses to label and a relative fire time — no advice paragraph, no ISO", async () => {
	const tool = renderHarness();
	const result = await armResult(tool, "status review");
	assert.equal(result.isError, false);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.id, "timer-1");
	assert.equal(result.details.label, "status review", "bounded card fields land in arm-success details only");
	const before = JSON.stringify(result);
	const collapsed = render(tool, result, false, false);
	assert.match(collapsed, /armed status review/);
	assert.match(collapsed, /fires in \d/);
	assert.doesNotMatch(collapsed, /end this turn|keep the session open|sleep, poll|Headless/);
	assert.doesNotMatch(collapsed, /\d{4}-\d{2}-\d{2}T/);
	assert.ok(collapsed.split("\n").length <= 2, `collapsed arm card stays one compact line, got ${collapsed.split("\n").length}`);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
});

test("timer arm card expands to the complete literal receipt", async () => {
	const tool = renderHarness();
	const result = await armResult(tool, "status review");
	const before = JSON.stringify(result);
	const expanded = render(tool, result, true, false);
	assert.match(expanded, /Armed timer-1 \(status review\)/);
	assert.match(expanded, /\d{4}-\d{2}-\d{2}T/);
	assert.match(expanded, /You can end this turn now/);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
});

test("timer failures and non-arm receipts render through the shared literal renderer", async () => {
	const tool = renderHarness();
	const failed = await tool.execute("call", { action: "arm", message: "x", delaySeconds: 60, atIso: "2026-09-02T12:00:00Z" }, undefined, undefined, { cwd: "D:/project" });
	assert.equal(failed.isError, true);
	const collapsed = render(tool, failed, false, true);
	assert.match(collapsed, /^failed/);
	assert.match(collapsed, /not both/);
	assert.doesNotMatch(collapsed, /armed /);
	assert.ok(collapsed.split("\n").length <= 6, "failed arm stays a bounded collapsed card");
	assert.match(render(tool, failed, true, true), /not both/, "expanded failure shows the full text");

	const cancel = await tool.execute("call", { action: "cancel", id: "timer-9" }, undefined, undefined, { cwd: "D:/project" });
	assert.equal(cancel.isError, true);
	assert.match(render(tool, cancel, false, true), /No armed timer with id "timer-9"/);

	const now = await tool.execute("call", { action: "now" }, undefined, undefined, { cwd: "D:/project" });
	assert.equal(now.isError, false);
	const nowCard = render(tool, now, false, false);
	assert.match(nowCard, /UTC/);
	assert.ok(nowCard.split("\n").length <= 6, "clock reading stays a bounded collapsed card");
});

test("timer collapsed arm cards are escape-free even for hostile labels", async () => {
	const tool = renderHarness();
	const result = await armResult(tool, "build\u001b[31m REDACTED\u001b[0m safe.exe");
	assert.equal(result.isError, false);
	const collapsed = render(tool, result, false, false);
	assert.doesNotMatch(collapsed, /\u001b/);
	assert.match(collapsed, /armed build REDACTED safe\.exe/);
});

test("timer arm card says due-now instead of a negative countdown", () => {
	const tool = renderHarness();
	const past = { content: [{ type: "text", text: "Armed timer-1 (late)." }], details: { action: "arm", id: "timer-1", fireAtEpochMs: Date.now() - 5_000, ok: true, label: "late" }, isError: false };
	assert.match(render(tool, past, false, false), /due now/);
	assert.doesNotMatch(render(tool, past, false, false), /fires in/);
});

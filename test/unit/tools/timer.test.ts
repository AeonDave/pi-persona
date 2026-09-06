import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TimerScheduler } from "../../../src/core/timer.ts";
import { registerTimerTool } from "../../../src/tools/timer.ts";

function harness(now = 1_000_000) {
	const tools = new Map<string, any>();
	const pi = { registerTool: (tool: { name: string }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerTimerTool(pi, {
		lastCtx: undefined,
		timerScheduler: new TimerScheduler({
			now: () => now,
			setTimer: () => 1,
			clearTimer: () => {},
			onFire: () => {},
		}),
	});
	return { tools };
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
	assert.doesNotMatch(description, /nmap|Paperwork/i);
});

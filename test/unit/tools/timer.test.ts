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
	const result = await tools.get("timer").execute("call-1", { action: "arm", message: "spawn Paperwork", delaySeconds: 60 });
	assert.equal(result.isError, false);
	assert.match(result.content[0]?.text ?? "", /Armed timer-1/);
});

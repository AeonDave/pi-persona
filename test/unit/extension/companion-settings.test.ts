import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCompanionSettings, COMPANION_SETTINGS_CHANNEL } from "../../../src/extension/companion-settings.ts";

test("only loaded companions contribute their current settings without runtime dependencies", () => {
	let requests = 0;
	const result = collectCompanionSettings({ emit: (channel, data) => {
		assert.equal(channel, COMPANION_SETTINGS_CHANNEL);
		requests++;
		const { add } = data as { add: (id: string, values: unknown) => void };
		add("mind", { mindCapture: "prompt", mindNudge: false });
	} });
	assert.equal(requests, 1);
	assert.deepEqual(result, { mind: { mindCapture: "prompt", mindNudge: false } });
	assert.deepEqual(collectCompanionSettings(undefined), {});
});

test("invalid or foreign contributions cannot create a settings section or inject another owner's fields", () => {
	const result = collectCompanionSettings({ emit: (_channel, data) => {
		const { add } = data as { add: (id: string, values: unknown) => void };
		add("optimizer", { engine: "child" });
		add("mind", { mindCapture: "invalid", mindNudge: true });
		add("flow", { flowEnabled: true, flowPort: -1, flowIdleMs: 60000 });
		add("mind", { mindCapture: "off", mindNudge: false, engine: "child" });
	} });
	assert.deepEqual(result, {});
});

test("Flow contributes desired service settings; a broken listener cannot break the settings command", () => {
	const result = collectCompanionSettings({ emit: (_channel, data) => {
		const { add } = data as { add: (id: string, values: unknown) => void };
		add("flow", { flowEnabled: true, flowPort: 0, flowIdleMs: 60000 });
		throw new Error("another listener failed");
	} });
	assert.deepEqual(result, { flow: { flowEnabled: true, flowPort: 0, flowIdleMs: 60000 } });
});

test("a companion may expose a subset of known settings without advertising unsupported controls", () => {
	const result = collectCompanionSettings({ emit: (_channel, data) => {
		const { add } = data as { add: (id: string, values: unknown) => void };
		add("mind", { mindNudge: true });
	} });
	assert.deepEqual(result, { mind: { mindNudge: true } });
});

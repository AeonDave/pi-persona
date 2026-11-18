import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSPECTOR_FRAME_EVENT, inspectorFrame, type InspectorFrameProviderResponse } from "../../../src/ui/inspector-frame.ts";
import { installInspectorFrameProvider } from "../../../src/extension/inspector-frame.ts";

test("provider responds synchronously to valid queries and unsubscribes", () => {
	const events = createEventBus();
	const dispose = installInspectorFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	const responses: InspectorFrameProviderResponse[] = [];
	const query = { version: 1, respond: (response: InspectorFrameProviderResponse) => responses.push(response) };
	events.emit(INSPECTOR_FRAME_EVENT, query);
	assert.deepEqual(responses, [{ version: 1, provider: "pi-persona", frame: inspectorFrame }]);
	dispose();
	events.emit(INSPECTOR_FRAME_EVENT, query);
	assert.equal(responses.length, 1);
});

test("provider ignores malformed requests and isolates throwing callbacks", () => {
	const events = createEventBus();
	installInspectorFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	let calls = 0;
	for (const query of [null, [], { version: 2, respond: () => calls++ }, { version: 1, respond: 4 }, { version: 1, respond: () => calls++, extra: true }, Object.assign(Object.create({}), { version: 1, respond: () => calls++ })]) events.emit(INSPECTOR_FRAME_EVENT, query);
	assert.equal(calls, 0);
	assert.doesNotThrow(() => events.emit(INSPECTOR_FRAME_EVENT, { version: 1, respond: () => { throw new Error("consumer"); } }));
	events.emit(INSPECTOR_FRAME_EVENT, { version: 1, respond: () => calls++ });
	assert.equal(calls, 1);
});

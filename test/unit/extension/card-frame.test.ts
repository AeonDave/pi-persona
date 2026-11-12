import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CARD_FRAME_EVENT, createCardFrame, type CardFrameProviderResponse } from "../../../src/ui/card-frame.ts";
import { installCardFrameProvider } from "../../../src/extension/card-frame.ts";

test("provider exposes only a valid V1 synchronous query and returns the one shared frame factory", () => {
	const events = createEventBus();
	const dispose = installCardFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	const responses: CardFrameProviderResponse[] = [];
	events.emit(CARD_FRAME_EVENT, { version: 1, respond: (response: CardFrameProviderResponse) => responses.push(response) });
	assert.equal(responses.length, 1);
	assert.equal(responses[0]?.version, 1);
	assert.equal(responses[0]?.provider, "pi-persona");
	assert.equal(responses[0]?.createCard, createCardFrame, "the event provider exposes Persona's one shared frame implementation");
	assert.equal(typeof responses[0]?.createCard({
		title: "Card", state: "neutral", full: "body", preview: () => ({ text: "body", truncated: false }),
	}, {
		expanded: false,
		theme: { fg: (_token: string, text: string) => text, bold: (text: string) => text, bg: (_token: string, text: string) => text } as never,
		outputPad: 0,
		detailHint: () => "expand",
	}).render, "function");
	assert.equal(typeof dispose, "function");
});

test("provider ignores malformed, incompatible, or ambiguous query shapes", () => {
	const events = createEventBus();
	installCardFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	const responses: unknown[] = [];
	for (const value of [
		null,
		[],
		{ version: 2, respond: (response: unknown) => responses.push(response) },
		{ version: 1, respond: "not a callback" },
		{ version: 1, respond: (response: unknown) => responses.push(response), extra: true },
		Object.assign(Object.create({ version: 1 }), { respond: (response: unknown) => responses.push(response) }),
	]) events.emit(CARD_FRAME_EVENT, value);
	assert.deepEqual(responses, []);
});

test("a throwing query callback is isolated and subsequent queries still respond", () => {
	const events = createEventBus();
	installCardFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	assert.doesNotThrow(() => events.emit(CARD_FRAME_EVENT, { version: 1, respond: () => { throw new Error("consumer callback"); } }));
	const responses: CardFrameProviderResponse[] = [];
	events.emit(CARD_FRAME_EVENT, { version: 1, respond: (response: CardFrameProviderResponse) => responses.push(response) });
	assert.equal(responses.length, 1);
});

test("provider load order, subscription cleanup, and requery follow Pi's public event-bus API", () => {
	const events = createEventBus();
	let responses: CardFrameProviderResponse[] = [];
	const callback = (response: CardFrameProviderResponse) => responses.push(response);
	const emitQuery = () => events.emit(CARD_FRAME_EVENT, { version: 1, respond: callback });

	emitQuery();
	assert.equal(responses.length, 0, "an extension loaded before its provider can observe absence");
	const dispose = installCardFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	emitQuery();
	assert.equal(responses.length, 1, "a fresh query sees the loaded provider");
	dispose();
	emitQuery();
	assert.equal(responses.length, 1, "the public unsubscribe removes its response");
	installCardFrameProvider({ events } as unknown as Pick<ExtensionAPI, "events">);
	emitQuery();
	assert.equal(responses.length, 2, "requery observes a newly loaded provider");
});

test("Persona registers the card-frame responder before disabled-extension early returns", async () => {
	const { default: piPersona } = await import("../../../src/extension.ts");
	const before = process.env.PI_PERSONA_DISABLE;
	try {
		process.env.PI_PERSONA_DISABLE = "1";
		const events = createEventBus();
		piPersona({ events } as never);
		const responses: CardFrameProviderResponse[] = [];
		events.emit(CARD_FRAME_EVENT, { version: 1, respond: (response: CardFrameProviderResponse) => responses.push(response) });
		assert.equal(responses.length, 1);
	} finally {
		if (before === undefined) delete process.env.PI_PERSONA_DISABLE;
		else process.env.PI_PERSONA_DISABLE = before;
	}
});

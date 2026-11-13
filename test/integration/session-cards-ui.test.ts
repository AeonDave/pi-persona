import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { CustomMessageComponent, initTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { registerSessionCards } from "../../src/ui/session-cards.ts";
import type { MonitorLogRecord } from "../../src/monitor/archive.ts";

const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { CustomEntryComponent } = await import(pathToFileURL(join(dirname(hostEntry), "modes/interactive/components/custom-entry.js")).href);

initTheme("dark", false);

const mouse = (type: TuiMouseEvent["type"] = "click", button: TuiMouseEvent["button"] = "left"): TuiMouseEvent => ({
	type, button, x: 1, y: 1, screenX: 1, screenY: 1, width: 120, height: 20,
	shift: false, alt: false, ctrl: false, clickCount: 1,
});
const longBody = Array.from({ length: 12 }, (_, index) => `detail-${index}`).join("\n");

function registeredRenderers() {
	const messages = new Map<string, (value: never, options: never, theme: Theme) => Component | undefined>();
	const entries = new Map<string, (value: never, options: never, theme: Theme) => Component | undefined>();
	registerSessionCards({
		registerMessageRenderer: (type: string, renderer: (value: never, options: never, theme: Theme) => Component | undefined) => messages.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: (value: never, options: never, theme: Theme) => Component | undefined) => entries.set(type, renderer),
	} as unknown as ExtensionAPI, {
		detailHint: () => "to expand",
		getOutputPad: () => 0,
		processLog: (record: MonitorLogRecord) => record.text,
	});
	return { messages, entries };
}

function render(component: Component, width = 120): string {
	return component.render(width).join("\n");
}

// These are the actual pinned-host transcript wrappers. They rebuild their custom renderer on
// invalidate/padding/expanded changes and do not themselves implement the native tool click toggle.
test("registered custom message and entry cards toggle from a primary transcript click", () => {
	const { messages, entries } = registeredRenderers();
	const message = { role: "custom", customType: "pi-persona", content: longBody, timestamp: "2026-01-01T00:00:00.000Z" } as never;
	const messageRenderer = messages.get("pi-persona")!;
	const messageHost = new CustomMessageComponent(message, messageRenderer as never);
	assert.match(render(messageHost), /detail-0/);
	assert.doesNotMatch(render(messageHost), /detail-11/);
	messageHost.handleMouse(mouse());
	assert.match(render(messageHost), /detail-11/, "click expands the message despite a host rebuild with expanded=false");
	messageHost.invalidate();
	messageHost.setOutputPad(2);
	assert.match(render(messageHost), /detail-11/, "host invalidate and outputPad rebuild retain local state");
	for (const width of [40, 80, 120]) assert.ok(messageHost.render(width).every((line) => visibleWidth(line) <= width), `message resize width ${width}`);
	initTheme("light", false);
	messageHost.invalidate();
	assert.match(render(messageHost), /detail-11/, "theme invalidation retains local state");
	initTheme("dark", false);
	messageHost.setExpanded(true);
	assert.match(render(messageHost), /detail-11/, "host expansion transition is authoritative");
	messageHost.handleMouse(mouse());
	assert.doesNotMatch(render(messageHost), /detail-11/, "local collapse works while the host remains expanded");
	messageHost.invalidate();
	assert.doesNotMatch(render(messageHost), /detail-11/, "invalidate retains the local collapse");
	messageHost.setExpanded(false);
	assert.doesNotMatch(render(messageHost), /detail-11/, "changed host state overrides local expansion");
	messageHost.handleMouse(mouse());
	assert.match(render(messageHost), /detail-11/);
	messageHost.handleMouse(mouse());
	assert.doesNotMatch(render(messageHost), /detail-11/);

	const entry = { type: "custom", customType: "pi-persona-result", data: { label: "report", ok: true, content: longBody } } as never;
	const entryHost = new CustomEntryComponent(entry, entries.get("pi-persona-result")! as never, 0);
	assert.match(render(entryHost), /detail-0/);
	assert.doesNotMatch(render(entryHost), /detail-11/);
	entryHost.handleMouse(mouse());
	assert.match(render(entryHost), /detail-11/, "the real custom-entry wrapper also expands on primary click");
	entryHost.invalidate();
	entryHost.setOutputPad(2);
	assert.match(render(entryHost), /detail-11/, "entry rebuild retains expansion");
	entryHost.setExpanded(true);
	entryHost.handleMouse(mouse());
	assert.doesNotMatch(render(entryHost), /detail-11/, "entry local collapse works while host expansion stays true");
	entryHost.invalidate();
	assert.doesNotMatch(render(entryHost), /detail-11/);
});

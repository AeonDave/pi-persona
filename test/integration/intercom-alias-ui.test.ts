import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { AsyncRunTracker } from "../../src/engine/async.ts";
import { InProcessBus } from "../../src/bus/inproc.ts";
import { registerIntercomTool } from "../../src/tools/intercom-tool.ts";
import { sanitizeTerminalText } from "../../src/ui/presentation.ts";
// Characterize the pinned Pi TUI's call-before-result rendering of restored history.
// These internals stay test-only; recheck the seam when upgrading development host pins.
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

for (const action of ["steer", "send", "reply"] as const) test(`native Pi tool card restores a ${action} alias on its first frame and expands the full sent message`, () => {
	initTheme("dark", false);
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	try {
		let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
		registerIntercomTool({ registerTool: (definition: typeof tool) => { tool = definition; } } as ExtensionAPI, {
			tracker: new AsyncRunTracker(),
			bus: new InProcessBus(),
		} as Parameters<typeof registerIntercomTool>[1]);
		let redrawRequests = 0;
		const route = action === "send" ? "operator#5" : "run-9";
		const askId = "m17";
		const firstLine = `Finish the runtime seam first. ${"Review the typed behavior. ".repeat(4).trimEnd()}`;
		const repeatedLine = `Keep the public contract. ${"Verify each caller. ".repeat(6).trimEnd()}\n`;
		const message = `${firstLine}\n${repeatedLine.repeat(8)}Report the final limitation.`;
		const component = new ToolExecutionComponent(
			"intercom", `saved-${action}`, { action, ...(action === "reply" ? { askId } : { to: route }), message }, {}, tool,
			{ requestRender: () => { redrawRequests += 1; } } as unknown as TUI, process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: action === "reply" ? `Replied to ${askId}.` : action === "send" ? "Sent to Dewglass-asyncfix." : "Steering queued for Dewglass-asyncfix (run-9)." }],
			details: { action, ok: true, target: "Dewglass-asyncfix", ...(action === "reply" ? { askId, busId: "operator#5" } : action === "send" ? { busId: route, sentMessage: message } : { runId: route, message }) },
			isError: false,
		});
		const render = (width: number) => component.render(width).map((line) => sanitizeTerminalText(line).trimEnd()).join("\n");
		const collapsed = render(120);
		assert.match(collapsed, new RegExp(`intercom ${action} Dewglass-asyncfix`));
		assert.match(collapsed, /Finish the runtime seam first/);
		assert.match(collapsed, /ctrl\+o/i);
		assert.doesNotMatch(collapsed, /m17|run-9|operator#5|soft request|cancellation|steering queued|steering sent|Sent to/i, "the call header already identifies the action and worker; its result shows the message, not a duplicate receipt");
		assert.equal(redrawRequests, 0, "restoring the alias does not recursively invalidate the native component");
		const narrow = render(32);
		assert.match(narrow, /Dewglass/, "narrow terminals retain recognizable worker identity");
		assert.match(narrow, /Finish the runtime seam.*…/);
		assert.match(narrow, /ctrl\+o/i);
		assert.ok(narrow.split("\n").filter((line) => line.trim()).length <= 6, narrow);
		component.setExpanded(true);
		const expanded = render(160);
		assert.match(expanded, action === "reply" ? /Ask: m17/ : action === "send" ? /Bus handle: operator#5/ : /Run: run-9/);
		assert.ok(expanded.includes(firstLine));
		assert.equal(expanded.split("Keep the public contract.").length - 1, 8);
		assert.match(expanded, /Report the final limitation/);
	} finally {
		setKeybindings(previousKeys);
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { AsyncRunTracker } from "../../src/engine/async.ts";
import { registerIntercomTool } from "../../src/tools/intercom-tool.ts";
import { sanitizeTerminalText } from "../../src/ui/presentation.ts";
// Characterize the pinned Pi 1.0 TUI's call-before-result rendering of restored history.
// These internals stay test-only; recheck the seam when upgrading development host pins.
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("native Pi tool card restores a steering alias on its first frame and expands the full sent message", () => {
	initTheme("dark", false);
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	try {
		let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
		registerIntercomTool({ registerTool: (definition: typeof tool) => { tool = definition; } } as ExtensionAPI, {
			tracker: new AsyncRunTracker(),
		} as Parameters<typeof registerIntercomTool>[1]);
		let redrawRequests = 0;
		const message = "Finish the runtime seam first.\n" + "Keep the public contract.\n".repeat(8) + "Report the final limitation.";
		const component = new ToolExecutionComponent(
			"intercom", "saved-steering", { action: "steer", to: "run-9", message }, {}, tool,
			{ requestRender: () => { redrawRequests += 1; } } as unknown as TUI, process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "Steering queued for Dewglass-asyncfix (run-9)." }],
			details: { action: "steer", ok: true, runId: "run-9", target: "Dewglass-asyncfix", message },
			isError: false,
		});
		const render = (width: number) => component.render(width).map((line) => sanitizeTerminalText(line).trimEnd()).join("\n");
		const collapsed = render(120);
		assert.match(collapsed, /intercom steer Dewglass-asyncfix/);
		assert.match(collapsed, /Finish the runtime seam first/);
		assert.match(collapsed, /ctrl\+o/i);
		assert.doesNotMatch(collapsed, /run-9|soft request|cancellation|steering queued|steering sent/i, "the call header already identifies the action and worker; its result shows the message, not a duplicate receipt");
		assert.equal(redrawRequests, 0, "restoring the alias does not recursively invalidate the native component");
		assert.match(render(32), /Dewglass/, "narrow terminals retain recognizable worker identity");
		component.setExpanded(true);
		const expanded = render(160);
		assert.match(expanded, /Run: run-9/);
		assert.equal(expanded.split("Keep the public contract.").length - 1, 8);
		assert.match(expanded, /Report the final limitation/);
	} finally {
		setKeybindings(previousKeys);
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AsyncRunTracker } from "../../src/engine/async.ts";
import { registerDelegateTool } from "../../src/tools/delegate-tool.ts";
import { registerCouncilTool } from "../../src/tools/council.ts";
import { registerFlowTool } from "../../src/tools/flow.ts";
import { sanitizeTerminalText } from "../../src/ui/presentation.ts";
// Test-only qualification of the pinned host's real result mouse region and expansion state.
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("native delegate, council and flow cards reveal literal prompts through a real result click", () => {
	initTheme("dark", false);
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	try {
		for (const kind of ["delegate", "council", "flow"] as const) {
			let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
			const api = { registerTool(definition: typeof tool) { tool = definition; } } as ExtensionAPI;
			const deps: any = { tracker: new AsyncRunTracker(), RUN_LIMITS: { maxChildren: 4, maxConcurrency: 4 }, config: { ledgerV2: false } };
			if (kind === "delegate") registerDelegateTool(api, deps);
			else if (kind === "council") registerCouncilTool(api, deps);
			else registerFlowTool(api, deps);
			const task = `**PRIVATE ${kind} TASK**\nFULL PROMPT TAIL`;
			const args = kind === "delegate" ? { agent: "scout", name: "Cedar", task } : kind === "council" ? { question: task } : { name: "example", task };
			const component = new ToolExecutionComponent(kind, `saved-${kind}`, args, {}, tool, { requestRender() {} } as unknown as TUI, process.cwd());
			const details = kind === "delegate"
				? { runId: "run-1", runs: [{ id: "run-1", label: "Cedar", agent: "scout", request: { task } }] }
				: { runId: "run-1", strategy: "fanout", roster: "review", flow: "example", launch: { participants: [], request: { task } } };
			component.updateResult({ content: [{ type: "text", text: `Launched ${kind}.` }], details, isError: false });
			const render = () => component.render(140);
			let lines = render();
			const visible = () => sanitizeTerminalText(render().join("\n"));
			assert.match(visible(), /ctrl\+o/i, `${kind}: native configured expansion hint`);
			assert.doesNotMatch(visible(), /PRIVATE|FULL PROMPT TAIL/);
			const click = (): void => {
				lines = render();
				const y = lines.length - 2;
				const event: TuiMouseEvent = { type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 140, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1 };
				assert.equal(component.handleMouse(event)?.handled, true, `${kind}: native result region handles click`);
			};
			click();
			assert.match(visible(), new RegExp(`\\*\\*PRIVATE ${kind} TASK\\*\\*`));
			assert.match(visible(), /FULL PROMPT TAIL/);
			click();
			assert.doesNotMatch(visible(), /PRIVATE|FULL PROMPT TAIL/, `${kind}: second click collapses prompt`);
			// Pi's global expand key targets this same public host state.
			component.setExpanded(true);
			assert.match(visible(), /FULL PROMPT TAIL/);
		}
	} finally { setKeybindings(previousKeys); }
});

test("native delegate first frame and saved receipt preserve explicit or inherited effort", () => {
	initTheme("dark", false);
	let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
	const api = { registerTool(definition: typeof tool) { tool = definition; } } as ExtensionAPI;
	const deps: any = { tracker: new AsyncRunTracker(), RUN_LIMITS: { maxChildren: 4, maxConcurrency: 4 }, config: { ledgerV2: false }, launchThinking: () => "low" };
	registerDelegateTool(api, deps);
	for (const [args, effort] of [
		[{ agent: "scout", name: "Cedar", task: "inspect", model: `provider/${"long-model-".repeat(20)}`, thinking: "xhigh" }, "xhigh"],
		[{ agent: "scout", name: "Cedar", task: "inspect", model: "provider/model" }, "low"],
	] as const) {
		const component = new ToolExecutionComponent("delegate", "saved-delegate", args, {}, tool, { requestRender() {} } as unknown as TUI, process.cwd());
		const render = () => sanitizeTerminalText(component.render(140).join("\n"));
		if ("thinking" in args) assert.match(render(), /xhigh/, "complete call shows explicit effort before the receipt");
		const model = args.model.split("/").at(-1)!;
		component.updateResult({ content: [{ type: "text", text: "Launched delegate." }], details: { runId: "run-1", runs: [{ id: "run-1", label: "Cedar", agent: "scout", model, thinking: effort, request: { task: args.task } }] }, isError: false });
		assert.match(render(), new RegExp(effort), "saved launch makes the selected effort visible even when call and receipt are deduplicated");
	}
});

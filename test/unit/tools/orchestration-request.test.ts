import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCouncilTool } from "../../../src/tools/council.ts";
import { registerFlowTool } from "../../../src/tools/flow.ts";

const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };

test("council and flow launches preserve their user prompt and native expand hint even without participant metadata", async () => {
	for (const kind of ["council", "flow"] as const) for (const unavailable of [false, true]) {
		let tool: any;
		const api = { registerTool(value: unknown) { tool = value; } } as ExtensionAPI;
		const deps: any = { lastCtx: undefined, controller: { activePersona: undefined }, personas: [],
			launchSnapshot: () => { if (unavailable) throw new Error("metadata unavailable"); return { participants: [] }; },
			runs: { launch: () => "run-1" }, loadFlow: () => ({ ok: true, flow: { name: "example", phases: [] } }), listFlows: () => [],
		};
		if (kind === "council") registerCouncilTool(api, deps); else registerFlowTool(api, deps);
		const prompt = "**PRIVATE USER TASK**\nsecond line\u001b[31m";
		const params = kind === "council" ? { question: prompt, strategy: "fanout", members: ["scout"] } : { name: "example", task: prompt };
		const result = await tool.execute("launch", params, undefined, undefined, { hasUI: true });
		assert.equal(result.isError, false);
		assert.equal(result.details.launch.request.task, prompt);
		const context = { keyHint: () => "ctrl+o to expand" };
		const compact = tool.renderResult(result, { expanded: false }, theme, context).render(200).join("\n");
		assert.match(compact, /ctrl\+o/);
		assert.doesNotMatch(compact, /PRIVATE USER TASK/);
		const expanded = tool.renderResult(result, { expanded: true }, theme, context).render(200).join("\n");
		assert.match(expanded, /\*\*PRIVATE USER TASK\*\*/);
		assert.match(expanded, /second line/);
		assert.doesNotMatch(expanded, /\u001b/);
	}
});

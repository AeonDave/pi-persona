import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCouncilTool } from "../../../src/tools/council.ts";
import { registerExocomCollaborationTools } from "../../../src/tools/exocom-collaboration.ts";
import { registerExocomProfileTool } from "../../../src/tools/exocom-profile.ts";
import { registerExocomWorkTools } from "../../../src/tools/exocom-work.ts";
import { registerExocomTools } from "../../../src/tools/exocom.ts";
import { registerFlowTool } from "../../../src/tools/flow.ts";
import { registerIntercomTool } from "../../../src/tools/intercom-tool.ts";
import { registerMonitorTool } from "../../../src/tools/monitor.ts";
import { registerScriptTool } from "../../../src/tools/script.ts";
import { registerTimerTool } from "../../../src/tools/timer.ts";
import { installIdentity } from "../../../src/extension/identity.ts";
import { registerModelsTool } from "../../../src/tools/models.ts";
import { makeReadResultTool } from "../../../src/tools/read-result.ts";
import { makeShowImageTool } from "../../../src/tools/show-image.ts";
import { makeCodeOutlineTool } from "../../../src/tools/code-outline.ts";

const plain = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function tools(): Map<string, any> {
	const registered = new Map<string, any>();
	const pi = new Proxy({ registerTool: (tool: any) => registered.set(tool.name, tool) }, { get: (target, key) => key in target ? (target as any)[key] : () => undefined }) as unknown as ExtensionAPI;
	const deps = new Proxy({}, { get: () => () => undefined }) as never;
	registerCouncilTool(pi, deps);
	registerFlowTool(pi, deps);
	registerIntercomTool(pi, deps);
	registerExocomTools(pi, () => undefined);
	registerExocomCollaborationTools(pi, deps);
	registerExocomWorkTools(pi, deps);
	registerExocomProfileTool(pi, () => undefined);
	registerTimerTool(pi, deps);
	registerMonitorTool(pi, deps);
	registerScriptTool(pi, deps);
	installIdentity(pi, deps);
	registerModelsTool(pi, deps);
	for (const tool of [makeReadResultTool({ read: async () => { throw new Error("unused"); } } as never), makeShowImageTool(), makeCodeOutlineTool()]) registered.set(tool.name, tool);
	return registered;
}

test("every orchestration and collaboration call card shows one pending line while its arguments stream", () => {
	const registered = tools();
	const expected = ["council", "flow", "intercom", "exocom_list", "exocom_send", "exocom_name", "exocom_task", "exocom_offer", "exocom_publish",
		"exocom_claim", "exocom_ask", "exocom_answer", "exocom_decline", "exocom_wait", "exocom_release", "exocom_progress", "exocom_status", "exocom_profile", "timer", "monitor", "script", "agent_name", "models", "read_result", "show_image", "code_outline"];
	for (const name of expected) {
		const tool = registered.get(name);
		assert.ok(tool, `${name} is registered`);
		const composing = { isPartial: true, argsComplete: false, executionStarted: false, state: {}, invalidate: () => {} };
		const pending = tool.renderCall({}, plain, composing).render(120).join("\n").trimEnd();
		assert.match(pending, /^[a-z_]+(?: [a-z]+)? . preparing…$/, `${name}: ${pending}`);
		assert.doesNotMatch(pending, /\?/, `${name} shows no placeholder for missing arguments`);
		const complete = tool.renderCall({}, plain, { ...composing, argsComplete: true }).render(120).join("\n");
		assert.doesNotMatch(complete, /preparing…/, `${name} renders its full card once arguments are complete`);
	}
});

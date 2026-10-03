import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCouncilTool, type CouncilToolDeps } from "../../../src/tools/council.ts";
import type { Persona } from "../../../src/persona/persona.ts";

/** Capture the registered `council` tool (schema + description) without a real Pi host. */
function councilTool(): { description: string; parameters: { properties: Record<string, { description?: string }> } } {
	const tools = new Map<string, { description: string; parameters: unknown }>();
	const pi = { registerTool: (tool: { name: string; description: string; parameters: unknown }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	const deps = {
		get lastCtx() {
			return undefined;
		},
		set lastCtx(_v: undefined) {},
		controller: { activePersona: undefined },
		personas: [] as Persona[],
		runStrategyVisible: async () => undefined,
		drainBusBlock: () => "",
		childUsage: { account: () => {}, snapshot: () => undefined },
		publishPersonaCost: () => {},
	} as unknown as CouncilToolDeps;
	registerCouncilTool(pi, deps);
	const tool = tools.get("council");
	assert.ok(tool, "the council tool is registered");
	return tool as unknown as { description: string; parameters: { properties: Record<string, { description?: string }> } };
}

test("the council description is proportionate: it does not mandate a council before every decision", () => {
	const { description } = councilTool();
	assert.doesNotMatch(description, /before any significant choice/i);
	assert.match(description, /not before every decision/i);
});

test("the council description names when NOT to convene and which sibling tool does that work", () => {
	const { description } = councilTool();
	assert.match(description, /do not use/i);
	assert.match(description, /`delegate`/);
});

test("the council description explains the decision patterns it supports", () => {
	const { description } = councilTool();
	for (const pattern of [/judge/i, /critique/i, /debate/i, /synthesi[sz]e/i]) {
		assert.match(description, pattern);
	}
});

test("the council description does not imply a separate judge tool", () => {
	const { description } = councilTool();
	assert.doesNotMatch(description, /judge tool/i);
	assert.doesNotMatch(description, /use the `judge`/i);
});

test("the council description documents the ad-hoc members override", () => {
	const { description, parameters } = councilTool();
	assert.match(description, /members/i);
	assert.match(parameters.properties.members?.description ?? "", /agent/i);
});
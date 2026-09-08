import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIntercomTool } from "../../../src/tools/intercom-tool.ts";

function registeredTool(): any {
	let tool: any;
	registerIntercomTool(
		{ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI,
		{} as any,
	);
	return tool;
}

test("intercom wait schema exposes its effective timeout window", () => {
	const tool = registeredTool();
	const properties = (tool.parameters as any).properties;
	assert.equal(properties.timeoutMs.minimum, undefined, "runtime clamps out-of-range waits instead of rejecting them");
	assert.equal(properties.timeoutMs.maximum, undefined, "runtime clamps out-of-range waits instead of rejecting them");
	assert.match(String(properties.timeoutMs.description), /below 1000 clamp to 1000/i);
	assert.match(String(properties.timeoutMs.description), /above 600000 clamp to 600000/i);
});

test("intercom descriptions explain pending completion joins and child steer queuing", () => {
	const tool = registeredTool();
	const properties = (tool.parameters as any).properties;
	assert.match(String(properties.to.description), /pending completions/i);
	assert.match(String(tool.description), /follow-up/i);
});

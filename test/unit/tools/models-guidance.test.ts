import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModelsTool } from "../../../src/tools/models.ts";

function modelsToolDescription(): string {
	let description = "";
	const pi = {
		registerTool: (definition: { name: string; description: string }) => {
			if (definition.name === "models") description = definition.description;
		},
	};
	registerModelsTool(pi as unknown as ExtensionAPI, {
		lastCtx: undefined,
		searchModels: () => ({ lines: [], total: 0, capped: false, shortlist: false }),
	});
	return description;
}

test("models tool describes omission and explicit supervisor selection without promising precedence", () => {
	const description = modelsToolDescription();
	assert.match(description, /Omitting `model` preserves saved per-persona role\/agent assignments, then the agent frontmatter model and engine defaults/);
	assert.match(description, /does not necessarily select the supervisor model/);
	assert.match(description, /intentionally choose the supervisor's current model.*exact provider\/id.*only when explicitly authorized/i);
	assert.match(description, /Never silently switch providers or billing routes/i);
	assert.doesNotMatch(description, /omit.*inherit the working session model/i);
});

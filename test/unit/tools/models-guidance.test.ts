import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

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

// ── presentation contract: compact collapsed counts line, shared literal expansion ──────────

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function modelsHarness(search: () => { lines: string[]; total: number; capped: boolean; shortlist: boolean }) {
	let tool: any;
	registerModelsTool({ registerTool: (t: unknown) => { tool = t; } } as unknown as ExtensionAPI, {
		lastCtx: undefined,
		searchModels: search as any,
	});
	return tool;
}

function catalogResult(tool: any, query?: string) {
	return tool.execute("call", query === undefined ? {} : { query }, undefined, undefined, { cwd: "D:/project" });
}

function renderCard(tool: any, result: unknown, expanded: boolean, isError = false): string {
	return stripVTControlCharacters(tool.renderResult(result, { expanded }, plainTheme, { isError }).render(400).join("\n"));
}

test("models result card collapses to a counts line instead of echoing the catalog", async () => {
	const long = Array.from({ length: 40 }, (_, i) =>
		`provider-${i}/model-${i} \u001b[31mred\u001b[0m 2026-09-02T12:00:00Z ${"detail ".repeat(12)}`);
	const tool = modelsHarness(() => ({ lines: long, total: 40, capped: true, shortlist: false }));
	const result = await catalogResult(tool, "model");
	const before = JSON.stringify(result);
	const collapsed = renderCard(tool, result, false);
	assert.match(collapsed, /40 catalog models/);
	assert.match(collapsed, /showing 40/);
	assert.doesNotMatch(collapsed, /model-1\b|2026-\d{2}-\d{2}T|\u001b/, "no catalog rows, ISO stamps or escapes in the collapsed card");
	assert.ok(collapsed.split("\n").length <= 2, `collapsed card stays compact, got ${collapsed.split("\n").length} lines`);
	assert.equal(JSON.stringify(result), before, "rendering never mutates the tool result");
	const expanded = renderCard(tool, result, true);
	assert.match(expanded, /model-39/);
	assert.doesNotMatch(expanded, /\u001b/, "expanded literal receipt is escape-free");
});

test("models shortlist and empty results carry a purpose-bearing collapsed line", async () => {
	const tool = modelsHarness(() => ({ lines: ["a/b"], total: 30, capped: false, shortlist: true }));
	const shortlist = await catalogResult(tool);
	const card = renderCard(tool, shortlist, false);
	assert.match(card, /30 catalog models/);
	assert.match(card, /showing 1 nearby candidates/);
	assert.doesNotMatch(card, /a\/b/);

	const empty = await modelsHarness(() => ({ lines: [], total: 0, capped: false, shortlist: false })).execute("call", { query: "sonnet" }, undefined, undefined, { cwd: "D:/project" });
	assert.match(renderCard(tool, empty, false), /no catalog matches/);
	assert.doesNotMatch(renderCard(tool, empty, false), /sonnet/, "the query is the call card's job, not the result card's");
});

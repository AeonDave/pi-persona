import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { fenceUntrusted } from "../../../src/core/fence.ts";
import { buildCompletionReport, type AsyncRun } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { registerDelegateTool, type DelegateToolDeps } from "../../../src/tools/delegate-tool.ts";
import { registerCouncilTool, type CouncilToolDeps } from "../../../src/tools/council.ts";
import { registerFlowTool, type FlowToolDeps } from "../../../src/tools/flow.ts";

initTheme("dark", false);
const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const diagnostic = "host **failure** at `path`\n\n  > literal detail\n- not a report\nTAIL\u001b[2J";
const prose = "**Verdict:** inspect `src/ui`\n\n> quoted evidence\n\nTAIL";

function tools(): Map<string, ToolDefinition> {
	const registered = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => { registered.set(tool.name, tool); } } as ExtensionAPI;
	registerDelegateTool(pi, {
		RUN_LIMITS: { maxChildren: 4, maxConcurrency: 2 }, config: { ledgerV2: false }, tracker: { onComplete() {} },
	} as unknown as DelegateToolDeps);
	registerCouncilTool(pi, {} as CouncilToolDeps);
	registerFlowTool(pi, {} as FlowToolDeps);
	return registered;
}

function render(tool: ToolDefinition, result: { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }, expanded: boolean, isError: boolean, lastComponent?: Component): Component {
	assert.ok(tool.renderResult);
	return tool.renderResult(result, { expanded, isPartial: false }, theme, {
		args: {}, toolCallId: "host-call", invalidate() {}, lastComponent, state: {}, cwd: "/repo",
		executionStarted: true, argsComplete: true, isPartial: false, expanded, showImages: false,
		isError, durationMs: undefined, outputPad: 0,
	});
}
function text(component: Component): string {
	return component.render(240).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

for (const [name, tool] of tools()) {
	test(`${name}: expanded native host errors with empty details stay literal and preserve newlines`, () => {
		// The native host carries the error flag in context, NOT in content/details.
		const result = { content: [{ type: "text" as const, text: diagnostic }], details: {} };
		const before = JSON.stringify(result);
		const rendered = text(render(tool, result, true, true));
		assert.ok(rendered.includes(diagnostic.replace("\u001b[2J", "")), rendered);
		assert.doesNotMatch(rendered, /\u001b/);
		if (name !== "delegate") assert.match(rendered, new RegExp(`^${name} failed\\n`));
		assert.notEqual(tool.renderShell, "self", "the native host still owns the tool shell");
		assert.equal(JSON.stringify(result), before, "rendering never changes the model/stored diagnostic");
	});

	test(`${name}: host error context remains authoritative and collapsed diagnostics stay bounded`, () => {
		const result = { content: [{ type: "text" as const, text: Array.from({ length: 40 }, (_, i) => `evidence ${i} **literal**`).join("\n") }], details: {}, isError: true };
		const failed = text(render(tool, result, false, true));
		assert.match(failed, new RegExp(`^${name} failed\\n`));
		assert.ok(failed.split("\n").length <= 6);
		assert.match(failed, /expand/);
		assert.doesNotMatch(failed, /evidence 39/);
		const hostSuccess = text(render(tool, result, false, false));
		assert.doesNotMatch(hostSuccess, new RegExp(`^${name} failed`), "a stale result.isError cannot overrule context.isError=false");
	});
}

const reports = new Map<string, { text: string; details: unknown }>();
const progress = { output: "", turns: 1, tokens: 10 };
const runs: AsyncRun[] = [
	{ id: "run-1", agent: "reviewer", label: "Quartz", task: "review", status: "done", progress, result: { agent: "reviewer", ok: true, output: prose, usage: emptyUsage() } },
	{ id: "run-2", agent: "scout", task: "inspect", status: "failed", error: "provider unavailable", progress },
];
reports.set("delegate", { text: buildCompletionReport(runs, fenceUntrusted, { bounded: false }), details: {} });
reports.set("council", { text: fenceUntrusted(prose), details: { ok: false, body: prose, error: "one member failed", failureKind: "provider" } });
reports.set("flow", { text: fenceUntrusted(prose), details: { ok: false, failedPhase: "inspect", error: "one leg failed", failureKind: "provider" } });

for (const [name, tool] of tools()) {
	test(`${name}: real reports retain native Markdown and its cache even when some legs failed`, () => {
		const report = reports.get(name)!;
		const result = { content: [{ type: "text" as const, text: report.text }], details: report.details };
		const before = JSON.stringify(result);
		const component = render(tool, result, true, true);
		const rendered = text(component);
		assert.match(rendered, /Verdict:.*inspect src\/ui/);
		assert.doesNotMatch(rendered, /\*\*Verdict|`src\/ui`/);
		assert.match(rendered, /│.*quoted evidence/);
		if (name !== "council") assert.match(rendered, /Sub-agent output \(untrusted data\):/);
		if (name === "delegate") assert.match(rendered, /run-1 \(Quartz\)/);
		assert.equal(render(tool, result, true, true, component), component, "the host reuses the report parser component");
		assert.equal(JSON.stringify(result), before, "reports, attribution and fences remain unchanged");
	});
}

test("both delegate model parameters distinguish omission from deliberately selecting the supervisor", () => {
	const schema = tools().get("delegate")!.parameters as any;
	const descriptions = [schema.properties.model.description, schema.properties.tasks.anyOf[0].items.anyOf[0].properties.model.description];
	for (const description of descriptions) {
		assert.match(description, /omission retains saved\/agent selections and defaults/i);
		assert.match(description, /explicit current supervisor provider\/id selects it deliberately/i);
		assert.match(description, /provider\/billing authorization/i);
		assert.doesNotMatch(description, /omit to inherit the working session model/i);
	}
});

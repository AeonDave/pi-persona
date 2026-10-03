import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { registerDelegateTool } from "../../../src/tools/delegate-tool.ts";

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

function register(overrides: Record<string, unknown> = {}): { tool: any; deps: any } {
	let tool: any;
	const tracker = new AsyncRunTracker();
	const deps: any = {
		lastCtx: undefined,
		controller: { activePersona: undefined },
		agents: [{ name: "operator" }, { name: "scout" }],
		contractNames: () => ["default"],
		buildEngine: () => ({ run: async (spec: any) => ({ agent: spec.agent, output: "done", usage: emptyUsage(), ok: true }) }),
		agentTree: { add: () => {}, update: () => {}, remove: () => {} },
		nextRootId: () => "delegate:test",
		tracker,
		config: { ledgerV2: false },
		RUN_LIMITS: { maxConcurrency: 4, maxChildren: 4, timeoutMs: 1000 },
		publishAgentTool: () => {},
		stopRegistry: new Map(),
		steerRegistry: new Map(),
		stopRequested: new Set(),
		ensurePersonaModels: async () => {},
		clearStops: () => {},
		clearSteers: () => {},
		drainBusBlock: () => "",
		startPeek: () => {},
		childUsage: { account: () => {} },
		publishPersonaCost: () => {},
		...overrides,
	};
	registerDelegateTool({ registerTool: (definition: unknown) => { tool = definition; } } as unknown as ExtensionAPI, deps);
	return { tool, deps };
}

function ctx() {
	return {
		hasUI: true,
		modelRegistry: { getAll: () => [], getAvailable: () => [] },
	};
}

function render(tool: any, result: any, expanded = false, width = 240, context?: any): string {
	return tool.renderResult(result, { expanded }, plainTheme, context).render(width).join("\n");
}

test("async single card persists and renders its tree alias after tracker reload", async () => {
	const first = register();
	const launched = await first.tool.execute(
		"single",
		{ agent: "operator", name: "Dewglass-asyncfix", task: "repair the view", model: "provider/sonnet", async: true },
		undefined,
		undefined,
		ctx(),
	);
	const details = launched.details as { runId: string; runs: Array<{ id: string; label: string; agent: string; model?: string }> };
	assert.equal(details.runId, "run-1", "routing id stays available to the model and intercom");
	assert.deepEqual(details.runs, [{ id: "run-1", label: "Dewglass-asyncfix", agent: "operator", model: "sonnet" }]);
	assert.match(launched.content[0].text, /run-1/, "the model-facing payload retains the internal routing id");

	const afterReload = register();
	const collapsed = render(afterReload.tool, launched);
	assert.match(collapsed, /delegate launched Dewglass-asyncfix · sonnet/);
	assert.doesNotMatch(collapsed, /run-1/);
	const expanded = render(afterReload.tool, launched, true);
	assert.match(expanded, /Dewglass-asyncfix · sonnet/);
	assert.match(expanded, /run-1/);
	assert.match(expanded, /Launched async run run-1/);
	assert.match(launched.content[0].text, /run-1/, "rendering leaves model-facing content untouched");
});

test("fanout card shows only launched aliases and accounts for dropped tasks", async () => {
	const first = register({ RUN_LIMITS: { maxConcurrency: 4, maxChildren: 2, timeoutMs: 1000 } });
	const launched = await first.tool.execute(
		"fanout",
		{
			tasks: [
				{ agent: "operator", name: "Dewglass", task: "first" },
				{ agent: "scout", name: "Brooklantern", task: "second" },
				{ agent: "operator", name: "Dropped-worker", task: "third" },
			],
		async: true,
		},
		undefined,
		undefined,
		ctx(),
	);
	const details = launched.details as { runIds: string[]; runs: Array<{ id: string; label: string; agent: string }>; dropped: number };
	assert.deepEqual(details.runIds, ["run-1", "run-2"]);
	assert.deepEqual(details.runs.map(({ id, label, agent }) => ({ id, label, agent })), [
		{ id: "run-1", label: "Dewglass", agent: "operator" },
		{ id: "run-2", label: "Brooklantern", agent: "scout" },
	]);
	assert.equal(details.dropped, 1);
	const afterReload = register();
	const collapsed = render(afterReload.tool, launched);
	assert.match(collapsed, /Dewglass/);
	assert.match(collapsed, /Brooklantern/);
	assert.match(collapsed, /1 task dropped/);
	assert.doesNotMatch(collapsed, /run-1|run-2|Dropped-worker/);
	const expanded = render(afterReload.tool, launched, true);
	assert.match(expanded, /Dewglass.*run-1/s);
	assert.match(expanded, /Brooklantern.*run-2/s);
	assert.match(expanded, /Dropped-worker|1 task/);
});

test("legacy launch details use a tracked alias when available and retain id diagnostics otherwise", () => {
	const h = register();
	h.deps.tracker.launch({ agent: "scout", task: "old launch", label: "Acornrail-retentionfix", model: "haiku" }, async () => ({
		agent: "scout", output: "done", usage: emptyUsage(), ok: true,
	}));
	const known = { content: [{ type: "text", text: "Launched async run run-1 (scout)." }], details: { runId: "run-1" }, isError: false };
	assert.match(render(h.tool, known), /Acornrail-retentionfix · haiku/);
	assert.doesNotMatch(render(h.tool, known), /run-1/);

	const unknown = { content: [{ type: "text", text: "Launched async run run-legacy (scout)." }], details: { runId: "run-legacy" }, isError: false };
	assert.match(render(h.tool, unknown), /run-legacy/, "legacy details without a saved or tracked alias keep their old diagnostic fallback");
	assert.equal(render(h.tool, unknown, true).trimEnd(), String(unknown.content[0]?.text ?? ""), "id-only legacy cards preserve their historical expanded payload");
});

test("completed legacy receipt does not borrow a reused run id's current alias", () => {
	const h = register();
	h.deps.tracker.launch({ agent: "operator", task: "new session", label: "New-session-worker" }, async () => ({
		agent: "operator", output: "done", usage: emptyUsage(), ok: true,
	}));
	const receipt = {
		content: [{ type: "text", text: "Launched async run run-1 (operator)." }],
		details: { runId: "run-1" },
		isError: false,
	};
	const completed = render(h.tool, receipt, false, 240, { isPartial: false });
	assert.match(completed, /run-1/);
	assert.doesNotMatch(completed, /New-session-worker/);
	const partial = render(h.tool, receipt, false, 240, { isPartial: true });
	assert.match(partial, /New-session-worker/, "live partial output can still use the current tracker");
});

test("legacy fanout keeps every id when only part of the batch is still tracked", () => {
	const h = register();
	h.deps.tracker.launch({ agent: "scout", task: "tracked task", label: "Tracked-worker" }, async () => ({
		agent: "scout", output: "done", usage: emptyUsage(), ok: true,
	}));
	const result = {
		content: [{ type: "text", text: "Launched three workers." }],
		details: { runIds: ["run-1", "run-old-2", "run-old-3", "run-old-4"] },
		isError: false,
	};
	const collapsed = render(h.tool, result);
	assert.match(collapsed, /Tracked-worker/);
	assert.match(collapsed, /run-old-2/);
	assert.match(collapsed, /\+1 more/);
	assert.match(collapsed, /expand/i);
	const expanded = render(h.tool, result, true);
	assert.match(expanded, /Tracked-worker \[run-1\]/);
	assert.match(expanded, /run-old-2 \[run-old-2\]/);
	assert.match(expanded, /run-old-3 \[run-old-3\]/);
	assert.match(expanded, /run-old-4 \[run-old-4\]/);
});

test("duplicate composed aliases gain ids only to distinguish the colliding launch rows", () => {
	const h = register();
	const result = {
		content: [{ type: "text", text: "Launched two workers." }],
		details: {
			runIds: ["run-a", "run-b"],
			runs: [
				{ id: "run-a", label: "Same-name", agent: "scout" },
				{ id: "run-b", label: "Same-name", agent: "operator" },
			],
		},
		isError: false,
	};
	const collapsed = render(h.tool, result);
	assert.match(collapsed, /Same-name \[run-a\]/);
	assert.match(collapsed, /Same-name \[run-b\]/);
	const expanded = render(h.tool, result, true);
	assert.match(expanded, /Same-name \[run-a\]/);
	assert.match(expanded, /Same-name \[run-b\]/);
});

test("alias rendering sanitizes terminal controls and bounds labels on wide terminals", async () => {
	const alias = `\u001b[2J${"界".repeat(160)}\nforged`;
	const first = register();
	const launched = await first.tool.execute("wide", { agent: "operator", name: alias, task: "inspect", async: true }, undefined, undefined, ctx());
	const afterReload = register();
	const collapsed = render(afterReload.tool, launched, false, 500).trimEnd();
	assert.doesNotMatch(collapsed, /\u001b|[\u0000-\u001f]/);
	assert.ok(visibleWidth(collapsed) <= 100, "wide aliases are clipped to the collapsed card's column bound");
	assert.match(collapsed, /expand/i, "a clipped alias tells the operator how to expand the full name");
	const expanded = render(afterReload.tool, launched, true, 500);
	assert.doesNotMatch(expanded, /\u001b|[\u0000-\u0009\u000b-\u001f]/);
});

test("expanded launch metadata includes admitted snapshots beyond 128 rows", () => {
	const h = register();
	const runs = Array.from({ length: 130 }, (_, index) => ({
		id: `run-${index}`,
		label: `worker-${index}`,
		agent: "operator",
	}));
	const result = {
		content: [{ type: "text", text: "Launched a large bounded batch." }],
		details: { runIds: runs.map((run) => run.id), runs },
		isError: false,
	};
	const expanded = render(h.tool, result, true, 180);
	assert.match(expanded, /worker-129 \[run-129\]/);
	assert.doesNotMatch(expanded, /launch records omitted/);
	const collapsed = render(h.tool, result).trimEnd();
	assert.match(collapsed, /\+127 more/);
	assert.match(collapsed, /expand/i);
	assert.ok(visibleWidth(collapsed) <= 100);
});

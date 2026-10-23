import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AsyncRunTracker } from "../../../src/engine/async.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { Semaphore } from "../../../src/orchestration/parallel.ts";
import { createBackgroundRuns } from "../../../src/tools/background-run.ts";
import { registerDelegateTool } from "../../../src/tools/delegate-tool.ts";

const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const tokenTheme = {
	fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
	bold: (text: string) => `**${text}**`,
};

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
		tracker,
		completionNotifier: { discard: () => {} },
		config: { ledgerV2: false },
		RUN_LIMITS: { maxConcurrency: 4, maxChildren: 4, timeoutMs: 1000 },
		publishAgentTool: () => {},
		stopRegistry: new Map(),
		steerRegistry: new Map(),
		drainBusBlock: () => "",
		startPeek: () => {},
		childUsage: { account: () => {} },
		publishPersonaCost: () => {},
		...overrides,
	};
	// A headless call joins its runs through the shared launcher, wired exactly as the extension wires it.
	deps.runs ??= createBackgroundRuns({ tracker: deps.tracker, agentTree: deps.agentTree, stopRegistry: deps.stopRegistry, slots: new Semaphore(4), completionNotifier: deps.completionNotifier, startPeek: deps.startPeek, childUsage: { account: () => {}, accountMany: () => emptyUsage() } as any, publishPersonaCost: deps.publishPersonaCost });
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
	return tool.renderResult(result, { expanded, isPartial: context?.isPartial ?? false }, plainTheme, context).render(width).join("\n");
}

function renderCall(tool: any, args: unknown, width = 240, context?: any): string {
	return tool.renderCall(args, plainTheme, context).render(width).join("\n");
}

test("single delegate call gives the alias a title line and keeps agent plus provider-qualified model in dim metadata", async () => {
	const h = register();
	const args = { agent: "operator", name: "Velvet-recon", model: "openai-codex/gpt-5.4-mini", task: "PRIVATE TASK" };
	await h.tool.execute("single", args, undefined, undefined, ctx());
	const wide = renderCall(h.tool, args, 120);
	assert.match(wide, /delegate Velvet-recon/);
	assert.match(wide, /operator · openai-codex\/gpt-5\.4-mini/);
	assert.doesNotMatch(wide, /PRIVATE TASK/);
	const styled = h.tool.renderCall(args, tokenTheme).render(120).join("\n");
	assert.match(styled, /<toolTitle>\*\*delegate \*\*<\/toolTitle><accent>\*\*Velvet-recon\*\*<\/accent>/);
	assert.match(styled, /<dim>  operator · openai-codex\/gpt-5\.4-mini<\/dim>/);
	const unnamed = renderCall(h.tool, { agent: "scout", task: "PRIVATE" }, 120);
	assert.match(unnamed, /delegate scout/);

	const narrow = renderCall(h.tool, args, 36);
	assert.ok(narrow.split("\n").every((line) => visibleWidth(line.trimEnd()) <= 36));
	assert.match(narrow, /Velvet/);
});

test("a complete coherent Pi receipt avoids repeating identity, while standalone history keeps it", async () => {
	const first = register();
	const args = { agent: "operator", name: "Velvet-recon", model: "openai-codex/gpt-5.4-mini", task: "PRIVATE TASK" };
	const launched = await first.tool.execute("single", args, undefined, undefined, ctx());
	const afterReload = register();
	const piContext = { args, argsComplete: true, isPartial: false };
	const originalContent = JSON.stringify(launched.content);
	const receipt = render(afterReload.tool, launched, false, 120, piContext).trimEnd();
	assert.equal(receipt, "↳ launched");
	assert.doesNotMatch(receipt, /delegate|Velvet-recon|operator|gpt-5\.4-mini|done|completed/i);

	const standalone = render(afterReload.tool, launched, false, 120);
	assert.match(standalone, /Velvet-recon/);
	assert.match(standalone, /operator/);
	assert.match(standalone, /gpt-5\.4-mini/);
	const expanded = render(afterReload.tool, launched, true, 240);
	assert.match(expanded, /Velvet-recon/);
	assert.match(expanded, /operator/);
	assert.match(expanded, /gpt-5\.4-mini/);
	assert.match(expanded, /run-1/);
	assert.equal(JSON.stringify(launched.content), originalContent, "rendering does not alter model-facing content");
});

test("incomplete, partial, or incoherent contexts keep a full standalone receipt", async () => {
	const first = register();
	const args = { agent: "operator", name: "Dewglass-worker", model: "provider/model", task: "work" };
	const launched = await first.tool.execute("single", args, undefined, undefined, ctx());
	const afterReload = register();
	for (const context of [
		{ args, argsComplete: false, isPartial: false },
		{ args, argsComplete: true, isPartial: true },
		{ args: { ...args, agent: "scout" }, argsComplete: true, isPartial: false },
		{ args: { ...args, model: "other/not-model" }, argsComplete: true, isPartial: false },
	]) {
		const card = render(afterReload.tool, launched, false, 160, context);
		assert.match(card, /Dewglass-worker/);
		assert.match(card, /operator/);
		assert.match(card, /model/);
	}
});

test("fanout receipt shows at most three identity rows and retains omitted and dropped counts", () => {
	const h = register();
	const result = {
		content: [{ type: "text", text: "Launched four workers." }],
		details: {
			runIds: ["run-1", "run-2", "run-3", "run-4"],
			dropped: 2,
			runs: [
				{ id: "run-1", label: "Velvet-recon", agent: "operator", model: "gpt-5.4-mini" },
				{ id: "run-2", label: "Brooklantern", agent: "scout", model: "glm-5.3" },
				{ id: "run-3", label: "Mossbridge", agent: "reviewer", model: "sonnet-4.5" },
				{ id: "run-4", label: "Fourth-worker", agent: "scout", model: "haiku-4.5" },
			],
		},
		isError: false,
	};
	const collapsed = render(h.tool, result, false, 120);
	const rows = collapsed.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
	assert.ok(rows.length <= 3, `expected at most three compact rows, got ${rows.length}: ${collapsed}`);
	assert.deepEqual(rows, [
		"↳ launched Velvet-recon · operator · gpt-5.4-mini",
		"  Brooklantern · scout · glm-5.3",
		"  Mossbridge · reviewer · sonnet-4.5 · +1 more · 2 tasks dropped · expand to see full detail",
	]);
	for (const value of ["Velvet-recon", "operator", "gpt-5.4-mini", "Brooklantern", "scout", "glm-5.3", "Mossbridge", "reviewer", "sonnet-4.5", "+1 more", "2 tasks dropped", "expand"]) {
		assert.match(collapsed, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.doesNotMatch(collapsed, /Fourth-worker|run-1|run-2|run-3/);
	assert.ok(rows.every((line) => visibleWidth(line.trimEnd()) <= 100));
	const expanded = render(h.tool, result, true, 240);
	assert.match(expanded, /Fourth-worker.*scout.*haiku-4\.5 \[run-4\]/s);
});

test("async single card persists and renders its tree alias after tracker reload", async () => {
	const first = register();
	const launched = await first.tool.execute(
		"single",
		{ agent: "operator", name: "Dewglass-asyncfix", task: "repair the view", model: "provider/sonnet" },
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
	assert.match(collapsed, /Dewglass-asyncfix/);
	assert.match(collapsed, /operator/);
	assert.match(collapsed, /sonnet/);
	assert.doesNotMatch(collapsed, /run-1/);
	const expanded = render(afterReload.tool, launched, true);
	assert.match(expanded, /Dewglass-asyncfix · operator · sonnet/);
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

test("one-row fanout receipt still reports dropped tasks in a complete Pi context", async () => {
	const first = register({ RUN_LIMITS: { maxConcurrency: 4, maxChildren: 1, timeoutMs: 1000 } });
	const args = {
		tasks: [
			{ agent: "operator", name: "Dewglass", task: "first" },
			{ agent: "scout", name: "Dropped-worker", task: "second" },
		],
	};
	const launched = await first.tool.execute("fanout", args, undefined, undefined, ctx());
	const afterReload = register();
	for (const context of [undefined, { args, argsComplete: true, isPartial: false }]) {
		const collapsed = render(afterReload.tool, launched, false, 120, context);
		assert.match(collapsed, /Dewglass/);
		assert.match(collapsed, /operator/);
		assert.match(collapsed, /1 task dropped/);
		assert.match(collapsed, /expand to see full detail/);
	}
});

test("legacy launch details use a tracked alias when available and retain id diagnostics otherwise", () => {
	const h = register();
	h.deps.tracker.launch({ agent: "scout", task: "old launch", label: "Acornrail-retentionfix", model: "haiku" }, async () => ({
		agent: "scout", output: "done", usage: emptyUsage(), ok: true,
	}));
	const known = { content: [{ type: "text", text: "Launched async run run-1 (scout)." }], details: { runId: "run-1" }, isError: false };
	assert.match(render(h.tool, known), /Acornrail-retentionfix/);
	assert.match(render(h.tool, known), /scout · haiku/);
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
	assert.match(expanded, /Tracked-worker · scout \[run-1\]/);
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
	const launched = await first.tool.execute("wide", { agent: "operator", name: alias, task: "inspect" }, undefined, undefined, ctx());
	const afterReload = register();
	const collapsed = render(afterReload.tool, launched, false, 500).split("\n").map((line) => line.trimEnd()).join("\n");
	assert.doesNotMatch(collapsed, /\u001b|[\u0000-\u0009\u000b-\u001f]/);
	assert.ok(collapsed.split("\n").every((line) => visibleWidth(line) <= 100), "wide aliases are clipped to the collapsed card's column bound");
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
	assert.match(expanded, /worker-129 · operator \[run-129\]/);
	assert.doesNotMatch(expanded, /launch records omitted/);
	const collapsed = render(h.tool, result).split("\n").map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /\+127 more/);
	assert.match(collapsed, /expand/i);
	assert.ok(collapsed.split("\n").length <= 3);
	assert.ok(collapsed.split("\n").every((line) => visibleWidth(line) <= 100));
});

test("only a background launch arms the status monitor; a headless leg runs inline with nobody to read a card", async () => {
	let armed = 0;
	const h = register({ startPeek: () => { armed++; }, childUsage: { accountMany: () => emptyUsage() } });
	await h.tool.execute("headless", { agent: "operator", task: "t" }, undefined, undefined, { ...ctx(), hasUI: false });
	assert.equal(armed, 0);
	await h.tool.execute("interactive", { agent: "operator", task: "t" }, undefined, undefined, ctx());
	assert.equal(armed, 1);
});

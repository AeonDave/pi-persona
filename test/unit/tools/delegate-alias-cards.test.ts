import assert from "node:assert/strict";
import { test } from "node:test";

import { initTheme, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	const sessionManager = SessionManager.inMemory(process.cwd());
	sessionManager.newSession({ id: "delegate-alias-cards" });
	return {
		hasUI: true,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			getRegisteredProviderIds: () => [],
			getProvider: () => undefined,
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
		},
		sessionManager,
		isIdle: () => true,
		getContextUsage: () => undefined,
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
	assert.match(receipt, /^launched · .*expand/);
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
	assert.match(expanded, /PRIVATE TASK/);
	assert.equal(JSON.stringify(launched.content), originalContent, "rendering does not alter model-facing content");
});

test("every admitted fan-out launch persists its exact task and keeps a native expansion hint", async () => {
	const h = register();
	const result = await h.tool.execute("batch", { tasks: [
		{ agent: "operator", name: "Amber", task: "FIRST PROMPT\nverbatim second line" },
		{ agent: "scout", name: "Birch", task: "SECOND PROMPT" },
	] }, undefined, undefined, ctx());
	const fresh = register();
	const context = { keyHint: (_key: string, action: string) => `ctrl+o ${action}` };
	const collapsed = render(fresh.tool, result, false, 180, context);
	assert.match(collapsed, /ctrl\+o/);
	assert.doesNotMatch(collapsed, /FIRST PROMPT|SECOND PROMPT/);
	const expanded = render(fresh.tool, result, true, 240, context);
	assert.match(expanded, /Amber[\s\S]*FIRST PROMPT[\s\S]*verbatim second line/);
	assert.match(expanded, /Birch[\s\S]*SECOND PROMPT/);
	assert.equal(result.details.runs[0].request.task, "FIRST PROMPT\nverbatim second line");
});

test("ownership checks inspect admitted writers, never dropped tasks", async () => {
	for (const maxChildren of [1, 2]) {
		const spawned: string[] = [];
		const h = register({
			controller: { activePersona: { delegation: { requireDisjointWrites: true } } },
			RUN_LIMITS: { maxConcurrency: 4, maxChildren, timeoutMs: 1000 },
			getAllTools: () => [],
			buildEngine: () => ({ run: async (spec: any) => { spawned.push(spec.task); return { agent: spec.agent, output: "done", usage: emptyUsage(), ok: true }; } }),
		});
		const tasks = maxChildren === 1
			? [{ agent: "operator", task: "admitted" }, { agent: "operator", task: "dropped" }]
			: [{ agent: "operator", task: "A", writeSet: ["src/a"] }, { agent: "operator", task: "B", writeSet: ["src/b"] }, { agent: "operator", task: "dropped overlap", writeSet: ["src/a"] }];
		const result = await h.tool.execute("admit", { tasks }, undefined, undefined, ctx());
		assert.equal(result.isError, false, result.content[0].text);
		assert.equal(result.details.runs.length, maxChildren);
		assert.equal(result.details.dropped, 1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(spawned, tasks.slice(0, maxChildren).map((task) => task.task));
	}
});

test("dropping a declared verifier still rejects the entire batch before spawning", async () => {
	let spawned = 0;
	const h = register({
		controller: { activePersona: { delegation: { requireDisjointWrites: true, requireFreshVerification: true, verificationAgents: ["scout"] } } },
		RUN_LIMITS: { maxConcurrency: 4, maxChildren: 1, timeoutMs: 1000 }, getAllTools: () => [],
		buildEngine: () => ({ run: async () => { spawned++; return {}; } }),
	});
	const result = await h.tool.execute("reject", { tasks: [{ agent: "operator", task: "mutate" }, { agent: "scout", task: "verify" }] }, undefined, undefined, ctx());
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /truncate declared fresh verifier/);
	assert.equal(spawned, 0);
});

test("missing write ownership is structured and compact while remaining actionable", async () => {
	const h = register({ controller: { activePersona: { delegation: { requireDisjointWrites: true } } }, getAllTools: () => [] });
	const result = await h.tool.execute("reject", { tasks: [{ agent: "operator", name: "Amber", task: "edit A" }, { agent: "operator", name: "Birch", task: "edit B" }] }, undefined, undefined, ctx());
	assert.equal(result.isError, true);
	assert.equal(result.details.rejection.code, "parallel-write-set-required");
	assert.deepEqual(result.details.rejection.tasks.map((task: any) => task.index), [0, 1]);
	const compact = render(h.tool, result, false, 120);
	assert.match(compact, /writeSet/);
	assert.match(compact, /Amber|operator/);
	assert.match(compact, /concurrency: 1/);
	assert.ok(compact.split("\n").length <= 5, compact);
});

test("ownership rejection freezes original arguments and guard grants for expanded history only", async () => {
	const h = register({
		controller: { activePersona: { delegation: { requireDisjointWrites: true } } },
		agents: [{ name: "operator" }, { name: "reader", tools: ["read"] }, { name: "shell", tools: ["read", "bash"] }, { name: "mcp-reader", tools: ["read"], mcp: true }],
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin", path: "builtin" } }],
	});
	const tasks = [
		{ agent: "operator", name: "Amber", task: "PRIVATE original prompt\n**literal**" },
		{ agent: "reader", task: "read only" },
		{ agent: "shell", task: "shell can write" },
		{ agent: "mcp-reader", task: "MCP may write", tools: ["read"] },
	];
	const raw = { tools: ["read"], writeSet: ["top-level-only"], concurrency: 3, tasks: JSON.stringify(tasks) };
	const original = JSON.stringify(raw);
	const result = await h.tool.execute("reject-original", raw, undefined, undefined, ctx());
	assert.equal(result.isError, true);
	const diagnostic = result.details.rejection.diagnostics;
	assert.equal(diagnostic.version, 1);
	assert.equal(JSON.stringify(JSON.parse(diagnostic.arguments.text)), original, "nested JSON strings and misplaced single-mode fields remain original");
	const guard = diagnostic.guard.text;
	assert.match(guard, /Effective concurrency: 3/);
	const legs = guard.split(/(?=tasks\[\d\])/).slice(1);
	assert.equal(legs.length, 4);
	assert.match(legs[0], /requested tools: not supplied/);
	assert.match(legs[0], /requested writeSet: not supplied/);
	assert.match(legs[0], /guard tools \(session-default\): not enumerated/);
	assert.match(legs[0], /guard writeSet \(undeclared\): not supplied/);
	assert.match(legs[0], /classification: writer.*default.*not enumerated/);
	assert.match(legs[1], /guard tools \(agent\): \["read"\]/);
	assert.match(legs[1], /classification: reader/);
	assert.match(legs[2], /non-read-only or unrecognized tools: \["bash"\]/);
	assert.match(legs[3], /guard mcp \(agent\): true/);
	assert.match(legs[3], /guard tools \(task\): \["read"\]/);
	assert.match(legs[3], /classification: writer.*MCP/);
	assert.doesNotMatch(JSON.stringify(result.content), /PRIVATE|effectiveConcurrency|session-default/);
	raw.tasks = "MUTATED"; raw.tools.push("MUTATED"); h.deps.agents[1].tools.push("MUTATED");
	const saved = JSON.parse(JSON.stringify(result));
	const reloaded = register();
	const context = { isError: true, args: { task: "WRONG RENDER CONTEXT" }, keyHint: (_key: string, action: string) => `ctrl+o ${action}` };
	const compact = render(reloaded.tool, saved, false, 140, context);
	assert.match(compact, /ctrl\+o/);
	assert.doesNotMatch(compact, /PRIVATE|literal|top-level-only|session-default|MUTATED|WRONG RENDER/);
	const expanded = render(reloaded.tool, saved, true, 240, context);
	assert.match(expanded, /Original arguments/);
	assert.match(expanded, /PRIVATE original prompt/);
	assert.match(expanded, /\*\*literal\*\*/);
	assert.match(expanded, /Guard assessment/);
	assert.match(expanded, /top-level.*not inherited/i);
	assert.doesNotMatch(expanded, /MUTATED|WRONG RENDER/);
});

test("ownership rejection bounds snapshots, escapes controls and retains fallback for old history", async () => {
	const h = register({ controller: { activePersona: { delegation: { requireDisjointWrites: true } } }, getAllTools: () => [] });
	const result = await h.tool.execute("reject-large", { tasks: [
		{ agent: "operator", task: `**LITERAL**\u001b[31m${"🌳".repeat(30_000)}`, tools: ["unknown".repeat(8_000)] },
		{ agent: "operator", task: "second" },
	] }, undefined, undefined, ctx());
	const diagnostic = result.details.rejection.diagnostics;
	assert.equal(diagnostic.arguments.truncated, true);
	assert.equal(diagnostic.guard.truncated, true);
	assert.ok(diagnostic.arguments.text.length <= 32_768);
	assert.ok(diagnostic.guard.text.length <= 16_384);
	assert.ok(JSON.stringify(diagnostic).length < 100_000, "duplicated grant fields cannot bypass the persisted limits");
	const expanded = render(register().tool, JSON.parse(JSON.stringify(result)), true, 240);
	assert.match(expanded, /truncated.*32768|32768.*truncated/i);
	assert.match(expanded, /truncated.*16384|16384.*truncated/i);
	assert.match(expanded, /\\u001b\[31m/, "terminal controls in original args are JSON escaped");
	assert.match(expanded, /\*\*LITERAL\*\*/);
	assert.doesNotMatch(expanded, /\u001b\[31m/);
	const old = JSON.parse(JSON.stringify(result)); delete old.details.rejection.diagnostics;
	assert.match(render(register().tool, old, true), /missing non-empty writeSet/);
});

test("ownership diagnostics retain explicit reader overrides and agent write-set inheritance", async () => {
	const h = register({
		controller: { activePersona: { delegation: { requireDisjointWrites: true } } },
		agents: [{ name: "operator" }, { name: "research", tools: ["read", "bash"], writeSet: [".research/"] }, { name: "mcp", mcp: true }],
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin", path: "builtin" } }],
	});
	const result = await h.tool.execute("reject-grants", { tasks: [
		{ agent: "operator", task: "default writer" },
		{ agent: "research", task: "inherited writer" },
		{ agent: "mcp", task: "explicit reader", tools: ["read"], mcp: false },
		{ agent: "operator", task: "explicit shell writer", tools: ["bash"], writeSet: ["src/other"] },
	] }, undefined, undefined, ctx());
	const legs = result.details.rejection.diagnostics.guard.text.split(/(?=tasks\[\d\])/).slice(1);
	assert.match(legs[1], /guard writeSet \(agent\): \["\.research\/"\]/);
	assert.match(legs[2], /guard mcp \(task\): false/);
	assert.match(legs[2], /classification: reader/);
	assert.match(legs[3], /guard writeSet \(task\): \["src\/other"\]/);
	assert.match(legs[3], /non-read-only or unrecognized tools: \["bash"\]/);
});

test("ownership diagnostics preserve supplied empty or whitespace write-set provenance", async () => {
	const h = register({
		controller: { activePersona: { delegation: { requireDisjointWrites: true } } },
		agents: [{ name: "operator" }, { name: "research", writeSet: [".research/"] }],
		getAllTools: () => [],
	});
	const result = await h.tool.execute("reject-empty-scope", { tasks: [
		{ agent: "operator", task: "empty scope", writeSet: [] },
		{ agent: "operator", task: "blank scope", writeSet: ["   "] },
		{ agent: "research", task: "inherited scope", writeSet: [] },
	] }, undefined, undefined, ctx());
	assert.equal(result.isError, true);
	const legs = result.details.rejection.diagnostics.guard.text.split(/(?=tasks\[\d\])/).slice(1);
	assert.match(legs[0], /guard writeSet \(task\): \[\]/);
	assert.match(legs[1], /guard writeSet \(task\): \["   "\]/);
	assert.match(legs[2], /requested writeSet: \[\]/);
	assert.match(legs[2], /guard writeSet \(agent\): \["\.research\/"\]/);
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
		"launched Velvet-recon · operator · gpt-5.4-mini",
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
	assert.deepEqual(details.runs, [{ id: "run-1", label: "Dewglass-asyncfix", agent: "operator", model: "sonnet", request: { task: "repair the view" } }]);
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
	assert.doesNotMatch(collapsed, /^↳/m, "generated launch headings have no decorative arrow");
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

test("headless delegate completion persists observed model metadata independently of its launch model", async () => {
	initTheme("dark");
	const h = register({ buildEngine: () => ({ run: async (spec: any) => ({ agent: spec.agent, output: "verified", usage: emptyUsage(), ok: true, modelUsed: "provider/resolved" }) }) });
	const result = await h.tool.execute("headless", { agent: "operator", task: "t", model: "provider/requested" }, undefined, undefined, { ...ctx(), hasUI: false });
	assert.equal(result.details.settledRuns[0].modelUsed, "provider/resolved");
	assert.match(result.content[0].text, /Observed model: provider\/resolved/);
	assert.match(render(h.tool, result, true, 180), /provider\/resolved/);
});

test("delegate launch cards surface the declared effort in FULL, collapsed and expanded", async () => {
	const h = register();
	const args = { agent: "operator", name: "AshCoral-view", model: "zai/glm-5.3-flash", task: "PRIVATE TASK", thinking: "xhigh" };
	const launched = await h.tool.execute("single", args, undefined, undefined, ctx());
	const details = launched.details as { runs: Array<{ thinking?: string }> };
	assert.equal(details.runs[0]?.thinking, "xhigh", "the launch snapshot carries the args-declared effort");

	const collapsed = render(h.tool, launched, false, 120);
	assert.match(collapsed, /operator · glm-5\.3-flash · xhigh/);
	const expanded = render(h.tool, launched, true, 240);
	assert.match(expanded, /operator · glm-5\.3-flash · xhigh/);
	const call = renderCall(h.tool, args, 120);
	assert.match(call, /operator · zai\/glm-5\.3-flash · xhigh/);

	// No declared thinking, nothing appended — args-level only, no invented display.
	const plain = renderCall(h.tool, { agent: "scout", name: "Plain-worker", task: "t" }, 120);
	assert.doesNotMatch(plain, /off|minimal|low|medium|high|xhigh|max/);
	const plainLaunch = await h.tool.execute("single", { agent: "scout", name: "Plain-two", task: "t" }, undefined, undefined, ctx());
	const plainCard = render(h.tool, plainLaunch, false, 120);
	assert.doesNotMatch(plainCard, / · (off|minimal|low|medium|high|xhigh|max)/);

	// A declared `off` selection still renders nothing.
	const offLaunch = await h.tool.execute("single", { agent: "operator", name: "Off-worker", task: "t", thinking: "off" }, undefined, undefined, ctx());
	assert.equal((offLaunch.details as { runs: Array<{ thinking?: string }> }).runs[0]?.thinking, "off");
	assert.match(render(h.tool, offLaunch, false, 120), /Off-worker/);
	assert.doesNotMatch(render(h.tool, offLaunch, false, 120), /· off/);
	assert.doesNotMatch(render(h.tool, offLaunch, true, 240), /· off/);
});

test("launch rendering never mutates the model-facing payload, launch details, or call args", async () => {
	const h = register();
	const args = { agent: "operator", name: "AshCoral-view", model: "zai/glm-5.3-flash", task: "PRIVATE TASK", thinking: "xhigh" };
	const launched = await h.tool.execute("single", args, undefined, undefined, ctx());
	const before = JSON.stringify([launched.content, launched.details]);
	const argsBefore = JSON.stringify(args);
	render(h.tool, launched, false, 120);
	render(h.tool, launched, true, 240);
	renderCall(h.tool, args, 120);
	assert.equal(JSON.stringify([launched.content, launched.details]), before, "payload and details unchanged by rendering");
	assert.equal(JSON.stringify(args), argsBefore, "renderCall does not mutate the call args");
});

test("fanout rows show each declared effort in full; undeclared legs stay bare; a uniform batch names it in the header", async () => {
	const h = register();
	const launched = await h.tool.execute("fanout", {
		tasks: [
			{ agent: "operator", name: "Hot-leg", task: "a", thinking: "xhigh" },
			{ agent: "scout", name: "Cool-leg", task: "b" },
			{ agent: "operator", name: "Mid-leg", task: "c", thinking: "medium" },
		],
	}, undefined, undefined, ctx());
	const collapsed = render(h.tool, launched, false, 200);
	assert.match(collapsed, /Hot-leg · operator · xhigh/);
	assert.match(collapsed, /Cool-leg · scout(?!\s·)/);
	assert.match(collapsed, /Mid-leg · operator · medium/);
	const expanded = render(h.tool, launched, true, 240);
	assert.match(expanded, /· xhigh \[run-1\]/);
	assert.match(expanded, /· medium \[run-3\]/);
	assert.doesNotMatch(expanded, /Cool-leg · scout · (xhigh|medium)/);

	const uniform = renderCall(h.tool, { tasks: [
		{ agent: "operator", task: "a", thinking: "high" },
		{ agent: "scout", task: "b", thinking: "high" },
	] }, 120);
	assert.match(uniform, /parallel \(2\) · high/);
	const mixed = renderCall(h.tool, { tasks: [
		{ agent: "operator", task: "a", thinking: "high" },
		{ agent: "scout", task: "b" },
	] }, 120);
	assert.match(mixed, /parallel \(2\)/);
	assert.doesNotMatch(mixed, /· high/);
});

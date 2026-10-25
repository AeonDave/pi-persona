import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import type { StrategyEngine } from "../../src/orchestration/sdk.ts";
import { TERMINAL_RESULT_ENTRY } from "../../src/results/types.ts";
import { tempDir } from "../setup/temp-dir.ts";

type AnyFn = (...args: any[]) => any;

test("same extension and tracker retain delegate receipts and Intercom history after shutdown/start", async () => {
	const cwd = tempDir("pi-persona-result-reactivation-");
	const agentDir = tempDir("pi-persona-result-reactivation-agent-");
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_PERSONA_PERSIST = "off";
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reader.md"), "---\nname: reader\ntools: [read]\n---\nRead only.\n");
	let manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const hooks = new Map<string, AnyFn>();
	const tools = new Map<string, { execute: AnyFn }>();
	let activeTools = ["read", "delegate", "intercom"];
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: AnyFn) => { hooks.set(name, handler); },
		registerTool: (tool: { name: string; execute: AnyFn }) => { tools.set(tool.name, tool); },
		registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
		registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => false,
		appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); },
		sendMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (value: string[]) => { activeTools = value; },
		getAllTools: () => [...new Set([...activeTools, ...tools.keys()])].map((name) => ({ name })),
		getThinkingLevel: () => "high", setThinkingLevel: () => {}, setModel: async () => true,
	};
	let calls = 0;
	const engine: StrategyEngine = { run: async (spec) => ({ agent: spec.agent, output: `durable report ${++calls}`, ok: true, usage: emptyUsage() }) };
	// Exactly one factory invocation: both activations therefore use its original AsyncRunTracker.
	piPersona(pi as unknown as ExtensionAPI, { engineFactories: { makeEngine: () => engine, makeInProcessEngine: () => engine } });
	const context = () => ({
		cwd, hasUI: false, sessionManager: manager,
		modelRegistry: { getAll: () => [], getAvailable: () => [], getRegisteredProviderIds: () => [],
			getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined, getProvider: () => undefined },
		isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => undefined,
		ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
	});
	const entries = () => manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === TERMINAL_RESULT_ENTRY);
	let ctx = context();
	try {
		for (let cycle = 0; cycle < 2; cycle++) {
			if (cycle > 0) { manager = SessionManager.create(cwd, join(agentDir, "sessions")); ctx = context(); }
			await hooks.get("session_start")!({ type: "session_start", reason: cycle ? "new" : "startup" }, ctx);
			const receipt = await tools.get("delegate")!.execute(`delegate-${cycle}`, { agent: "reader", task: `read fixture ${cycle}` }, undefined, undefined, ctx);
			assert.equal(receipt.isError, false, receipt.content?.[0]?.text);
			assert.equal(entries().length, 1, `activation ${cycle} archives the same tracker's new delegate exactly once`);
			const listed = await tools.get("intercom")!.execute(`list-${cycle}`, { action: "results" }, undefined, undefined, ctx);
			assert.equal(listed.isError, false);
			assert.equal(listed.details.results.length, 1);
			const ref = listed.details.results[0].ref;
			assert.ok(ref, "Intercom exposes a retained receipt after each activation");
			assert.ok(receipt.content[0].text.includes(ref), "the actual delegate completion carries that same archived receipt");
			const page = await tools.get("intercom")!.execute(`page-${cycle}`, { action: "result", ref }, undefined, undefined, ctx);
			assert.equal(page.isError, false);
			assert.match(page.content[0].text, new RegExp(`durable report ${cycle + 1}`));
			assert.equal(calls, cycle + 1, "retrieval never reruns the delegate");
			await hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, ctx);
		}
	} finally { await hooks.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx); }
});

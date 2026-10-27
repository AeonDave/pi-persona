import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEventBus, SessionManager, type CompactOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { patchPersonaSettings } from "../../src/persona/settings-store.ts";
import { tempDir } from "../setup/temp-dir.ts";

// A deliberately loose host fixture: preserve every registered handler and native session state.
type Hook = (...args: any[]) => any;
const IDLE_MS = 15 * 60 * 1_000;

async function fixture(option: "env" | "saved" | "off") {
	const savedEnv = { ...process.env };
	const cwd = tempDir("persona-idle-wiring-work-");
	const agentDir = tempDir("persona-idle-wiring-agent-");
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_PERSONA_PERSIST = "off";
	process.env.PI_PERSONA_TELEMETRY = "off";
	process.env.PI_PERSONA_LEG_CHANGE_REPORT = "off";
	if (option === "env") process.env.PI_PERSONA_IDLE_COMPACTION = "on";
	else delete process.env.PI_PERSONA_IDLE_COMPACTION;
	if (option === "saved") patchPersonaSettings(join(agentDir, "persona", "settings.json"), { preferences: { idleCompaction: true } });
	const hooks = new Map<string, Hook[]>();
	const tools = new Map<string, { execute: Hook }>();
	const flags = new Map<string, unknown>();
	const compactions: CompactOptions[] = [];
	const messages: Array<{ message: unknown; options: unknown }> = [];
	let activeTools = ["read", "bash", "delegate", "timer", "intercom"];
	const manager = SessionManager.inMemory(cwd);
	const state = { idle: true, pending: false, percent: 41 };
	const pi = {
		events: createEventBus(),
		on(name: string, handler: Hook) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); return () => {}; },
		registerTool(tool: { name: string; execute: Hook }) { tools.set(tool.name, tool); },
		registerMessageRenderer() {}, registerEntryRenderer() {}, registerShortcut() {}, registerCommand() {},
		registerFlag(name: string, options: { default?: unknown }) { flags.set(name, options.default); },
		getFlag: (name: string) => flags.get(name),
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		sendMessage: (message: unknown, options: unknown) => { messages.push({ message, options }); },
		getAllTools: () => [...new Set([...activeTools, ...tools.keys()])].map(name => ({ name })),
		getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = names; },
		getThinkingLevel: () => "medium", setThinkingLevel() {}, setModel: async () => true,
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd, sessionManager: manager, hasUI: true, mode: "tui", model: { provider: "stub", id: "model" },
		modelRegistry: { getAll: () => [], getAvailable: () => [], getRegisteredProviderIds: () => [], find: () => undefined },
		isIdle: () => state.idle, hasPendingMessages: () => state.pending,
		getContextUsage: () => ({ tokens: state.percent * 1_000, contextWindow: 100_000, percent: state.percent }),
		compact(options: CompactOptions = {}) { compactions.push(options); },
		ui: { setStatus() {}, setWidget() {}, notify() {}, select: async () => undefined,
			getEditorText: () => "", onTerminalInput: () => () => {} },
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
	};
	piPersona(pi);
	await fire("session_start");
	mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	return {
		compactions, messages, hooks,
		async episode() {
			await fire("before_agent_start", { messageType: "user", prompt: "offline work", systemPrompt: "BASE" });
			await fire("agent_start");
			await fire("agent_settled");
		},
		async close() {
			try { await fire("session_shutdown", { reason: "quit" }); }
			finally { mock.timers.reset(); for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]; Object.assign(process.env, savedEnv); }
		},
	};
}

test("root quarantine ignores saved/environment enable requests and installs no idle-compaction hooks", async () => {
	let baseline: Array<[string, number]> | undefined;
	for (const option of ["off", "env", "saved"] as const) {
		const f = await fixture(option);
		try {
			const hooks = [...f.hooks].map(([name, values]): [string, number] => [name, values.length]);
			if (!baseline) baseline = hooks;
			else assert.deepEqual(hooks, baseline, "forcing enable cannot install additional hooks");
			assert.equal(f.hooks.has("session_before_compact"), false, "native lifecycle is untouched");
			await f.episode();
			mock.timers.tick(IDLE_MS * 4);
			assert.equal(f.compactions.length, 0, option);
			assert.equal(f.messages.length, 0, "blocked compaction cannot create a supervisor wake");
		} finally { await f.close(); }
	}
});

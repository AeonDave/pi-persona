import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { tempDir } from "../setup/temp-dir.ts";

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

function makeMockPi(initialActive: string[]) {
	const hooks: Record<string, AnyFn> = {};
	const tools: Record<string, unknown> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	const flags: Record<string, boolean | string> = {};
	let activeTools = [...initialActive];
	const pi = {
		on: (event: string, handler: AnyFn) => { hooks[event] = handler; },
		registerTool: (definition: { name: string }) => { tools[definition.name] = definition; },
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerCommand: (name: string, definition: { handler: AnyFn }) => { commands[name] = definition; },
		registerShortcut: () => {},
		registerFlag: (name: string, options: { default?: boolean | string }) => { flags[name] = options.default ?? false; },
		getFlag: (name: string) => flags[name],
		sendMessage: () => {},
		getAllTools: () => [...new Set([...activeTools, ...Object.keys(tools)])].map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		fire: (event: string, ...args: unknown[]) => {
			const handler = hooks[event];
			if (!handler) throw new Error(`no hook: ${event}`);
			return handler(...args);
		},
		cmd: (name: string, args: string, ctx: unknown) => {
			const command = commands[name];
			if (!command) throw new Error(`no command: ${name}`);
			return command.handler(args, ctx);
		},
	};
}

async function delegationPrompt(options: {
	name: string;
	toolsBlock?: string;
	activeTools: string[];
	activateModelsAfterPersona?: boolean;
}): Promise<string> {
	const cwd = tempDir("pi-persona-model-brief-");
	const agentDir = tempDir("pi-persona-model-brief-agentdir-");
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	const agentsDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "worker.md"), "---\nname: worker\ndescription: bounded helper\n---\nA focused worker.");
	fs.writeFileSync(path.join(agentsDir, `${options.name}.md`),
		`---\nname: ${options.name}\npersona: true\n${options.toolsBlock ?? ""}---\nSupervise delegated work.`);
	const m = makeMockPi(options.activeTools);
	piPersona(m.pi);
	const ctx = {
		cwd,
		hasUI: false,
		model: undefined,
		modelRegistry: { getAll: () => [], getAvailable: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
	};
	try {
		await m.fire("session_start", {}, ctx);
		await m.cmd("persona", options.name, ctx);
		if (options.activateModelsAfterPersona) m.setActiveTools([...options.activeTools, "models"]);
		const result = m.fire("before_agent_start", { systemPrompt: "BASE" }, ctx) as { systemPrompt: string };
		return result.systemPrompt;
	} finally {
		await m.fire("session_shutdown", {}, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
	}
}

test("an unrestricted persona keeps model discovery guidance when the host tool is active", async () => {
	const prompt = await delegationPrompt({
		name: "open-host",
		activeTools: ["read", "grep", "delegate", "models"],
	});
	assert.match(prompt, /Use `models` for targeted lookup or explicit refresh/);
	assert.match(prompt, /reuse supplied cached current-provider candidates across turns and tasks until the base model changes/);
});

test("the persona capability gate suppresses model discovery even if the host marks the tool active", async () => {
	const prompt = await delegationPrompt({
		name: "locked-host",
		toolsBlock: "tools:\n  allow: [delegate]\n",
		activeTools: ["read", "grep", "delegate", "models"],
		activateModelsAfterPersona: true,
	});
	assert.doesNotMatch(prompt, /`models`/, "the effective persona gate wins even if the host lists the tool active");
	assert.match(prompt, /model.{0,80}(sized|size|task)/i, "model sizing advice remains");
});

test("an inactive host models tool is omitted for an unrestricted persona", async () => {
	const prompt = await delegationPrompt({
		name: "host-inactive",
		activeTools: ["read", "grep", "delegate"],
	});
	assert.doesNotMatch(prompt, /`models`/, "an inactive host tool is not presented as callable");
	assert.match(prompt, /model.{0,80}(sized|size|task)/i, "model sizing advice remains");
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { seedDefaults } from "../../src/core/seed.ts";
import { tempDir } from "../setup/temp-dir.ts";

type Handler = (...args: any[]) => any;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function boot(t: TestContext, prepare?: (dir: string, file: string) => void) {
	const dir = tempDir("persona-settings-integration-");
	const data = path.join(dir, "persona");
	const file = path.join(data, "settings.json");
	seedDefaults(root, data, true);
	prepare?.(data, file);
	const oldDir = process.env.PI_AGENT_DIR;
	const oldPersist = process.env.PI_PERSONA_PERSIST;
	process.env.PI_AGENT_DIR = dir;
	delete process.env.PI_PERSONA_PERSIST;
	const hooks = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const shortcuts: unknown[] = [];
	const tools = new Map<string, unknown>();
	const notes: string[] = [];
	const flags = new Map<string, string | boolean>();
	const ctx = {
		cwd: dir, mode: "print", hasUI: true,
		sessionManager: SessionManager.inMemory(dir),
		model: undefined,
		modelRegistry: { getAll: () => [], getAvailable: () => [], refresh: async () => undefined },
		isIdle: () => true, hasPendingMessages: () => false,
		ui: { setStatus: () => {}, notify: (message: string) => notes.push(message),
			select: async () => undefined, custom: async () => undefined },
	};
	const pi = {
		events: { emit: () => {}, on: () => () => {} },
		on: (event: string, handler: Handler) => { hooks.set(event, [...hooks.get(event) ?? [], handler]); },
		registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def),
		registerTool: (def: { name: string }) => tools.set(def.name, def),
		registerMessageRenderer: () => {}, registerEntryRenderer: () => {}, appendEntry: () => {},
		registerShortcut: (key: unknown) => shortcuts.push(key),
		registerFlag: (name: string, def: { default?: boolean | string }) => flags.set(name, def.default ?? false),
		getFlag: (name: string) => flags.get(name), sendMessage: () => {},
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => [...tools.keys()], setActiveTools: () => {},
		getThinkingLevel: () => "medium", setThinkingLevel: () => {}, setModel: async () => true,
	};
	const fire = async (event: string) => {
		for (const handler of hooks.get(event) ?? []) await handler(event === "session_shutdown" ? { reason: "quit" } : undefined, ctx);
	};
	t.after(async () => {
		await fire("session_shutdown");
		if (oldDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldDir;
		if (oldPersist === undefined) delete process.env.PI_PERSONA_PERSIST; else process.env.PI_PERSONA_PERSIST = oldPersist;
	});
	piPersona(pi as unknown as ExtensionAPI);
	return { dir, data, file, ctx, notes, shortcuts, commands, fire,
		cmd: async (name: string, args = "") => {
			const def = commands.get(name);
			assert.ok(def, `${name} command must exist`);
			await def.handler(args, ctx);
		},
		read: () => JSON.parse(fs.readFileSync(file, "utf8")),
	};
}

test("Persona owns a distinct persona-settings command; show is read-only without an active persona", async (t) => {
	const h = boot(t);
	assert.ok(h.commands.has("persona-settings"));
	assert.ok(!h.commands.has("settings"), "do not replace Pi's own settings");
	await h.fire("session_start");
	await h.cmd("persona-settings", "show");
	assert.ok(h.notes.some((note) => note.includes(h.file)), JSON.stringify(h.notes));
	assert.equal(fs.existsSync(h.file), false, "viewing defaults must not materialize a settings file");
});

test("canonical saved preferences configure the extension without changing Pi settings", async (t) => {
	const h = boot(t, (_data, file) => fs.writeFileSync(file, JSON.stringify({
		version: 1, preferences: { engine: "child", keybinding: "f7", persist: false },
		personas: {}, lastPersona: null,
	})));
	await h.fire("session_start");
	await h.cmd("doctor");
	assert.ok(h.notes.some((note) => note.includes("engine backend: child-process")), JSON.stringify(h.notes));
	assert.ok(h.shortcuts.includes("f7"));
	assert.equal(fs.existsSync(path.join(h.dir, "settings.json")), false, "never write native Pi settings");
});

test("legacy selection and models migrate once, then all persistence uses the canonical file", async (t) => {
	const h = boot(t, (data) => {
		fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({
			dev: { models: { operator: "alpha/one" } }, magi: { models: { melchior: "beta/two" } },
		}));
		fs.writeFileSync(path.join(data, "state.json"), JSON.stringify({ lastPersona: "dev" }));
	});
	await h.fire("session_start");
	await h.cmd("doctor");
	assert.ok(h.notes.some((note) => /active:.*Dev/i.test(note)), JSON.stringify(h.notes));
	assert.equal(h.read().lastPersona, "dev");
	assert.deepEqual(h.read().personas.dev.models, { operator: "alpha/one" });
	assert.deepEqual(h.read().personas.magi.models, { melchior: "beta/two" });
	for (const old of ["config.json", "state.json"]) {
		assert.equal(fs.existsSync(path.join(h.data, old)), false, JSON.stringify(h.notes));
		assert.equal(fs.existsSync(path.join(h.data, `${old}.migrated`)), true, "migration remains recoverable");
	}
	await h.cmd("persona", "magi");
	assert.equal(h.read().lastPersona, "magi");
	assert.equal(fs.existsSync(path.join(h.data, "state.json")), false);
	await h.cmd("persona", "off");
	assert.equal(h.read().lastPersona, null);
	assert.deepEqual(h.read().personas.dev.models, { operator: "alpha/one" });
});

test("malformed canonical settings remain recoverable and are never replaced by a persona gesture", async (t) => {
	const broken = "{user settings temporarily broken";
	const h = boot(t, (_data, file) => fs.writeFileSync(file, broken));
	await h.fire("session_start");
	await h.cmd("persona", "dev");
	assert.equal(fs.readFileSync(h.file, "utf8"), broken);
	assert.ok(h.notes.some((note) => /settings/i.test(note) && /could not|invalid|failed|parse/i.test(note)), JSON.stringify(h.notes));
});

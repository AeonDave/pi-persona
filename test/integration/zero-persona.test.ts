import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";
import { tempDir } from "../setup/temp-dir.ts";

// A fresh install loads NO personas until `/persona seed` (deliberate). F8 and /doctor must say so
// instead of staying silent. The agent dir is empty and PI_PERSONA_SEED is scrubbed by the hermetic
// import, so no persona is ever installed here.
process.env.PI_AGENT_DIR = tempDir("pi-persona-zero-persona-");

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

function makeMockPi() {
	const hooks: Record<string, AnyFn> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	const shortcuts: Array<{ handler: AnyFn }> = [];
	const pi = {
		on: (name: string, handler: AnyFn) => { hooks[name] = handler; },
		registerTool: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerCommand: (name: string, command: { handler: AnyFn }) => { commands[name] = command; },
		registerShortcut: (_key: unknown, shortcut: { handler: AnyFn }) => { shortcuts.push(shortcut); },
		registerFlag: () => {},
		getFlag: () => false,
		sendMessage: () => {},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		fire: (name: string, ...args: unknown[]) => hooks[name]?.(...args),
		cmd: (name: string, args: string, ctx: unknown) => commands[name]?.handler(args, ctx),
		f8: (ctx: unknown) => shortcuts[0]?.handler(ctx),
	};
}

function makeCtx(hasUI: boolean) {
	const notes: string[] = [];
	const ctx = {
		cwd: tempDir("pi-persona-zero-persona-cwd-"),
		hasUI,
		model: undefined,
		modelRegistry: { getAll: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { setStatus: () => {}, notify: (message: string) => { notes.push(message); }, select: async () => undefined },
	};
	return { ctx, notes };
}

test("with zero personas F8 and /doctor print the /persona seed remedy instead of staying silent", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx, notes } = makeCtx(true);
	await m.fire("session_start", undefined, ctx);
	try {
		await m.f8(ctx);
		assert.equal(notes.length, 1, "F8 tells the operator once, it is not a silent no-op");
		assert.match(notes[0] ?? "", /\/persona seed/);

		notes.length = 0;
		await m.cmd("doctor", "", ctx);
		assert.match(notes.join("\n"), /personas \(0\): .*\/persona seed/);

		notes.length = 0;
		await m.cmd("persona", "list", ctx);
		assert.equal(notes.length, 1);
		assert.match(notes[0] ?? "", /\/persona seed/, "the /persona list remedy is the same sentence");
	} finally {
		await m.fire("session_shutdown", undefined, ctx);
	}
});

test("F8 with zero personas stays quiet without a UI", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx, notes } = makeCtx(false);
	await m.fire("session_start", undefined, ctx);
	try {
		await m.f8(ctx);
		assert.deepEqual(notes, []);
	} finally {
		await m.fire("session_shutdown", undefined, ctx);
	}
});

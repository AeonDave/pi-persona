import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPersona from "../../src/extension.ts";

// Hermetic: point the "user" agent dir at an empty temp dir so the real
// ~/.pi/agent/agents (seeded by other tools) cannot shadow the bundled assets.
process.env.PI_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-userdir-"));
// Hermetic by default: general tests must not persist/restore the last persona.
// The persistence test re-enables it explicitly with its own state file.
process.env.PI_PERSONA_PERSIST = "off";

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

function makeMockPi() {
	const hooks: Record<string, AnyFn> = {};
	const tools: Record<string, unknown> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	const shortcuts: Array<{ handler: AnyFn }> = [];
	let activeTools = ["read", "grep", "write", "delegate", "web_search"];
	const pi = {
		on: (ev: string, h: AnyFn) => {
			hooks[ev] = h;
		},
		registerTool: (def: { name: string }) => {
			tools[def.name] = def;
		},
		registerCommand: (name: string, def: { handler: AnyFn }) => {
			commands[name] = def;
		},
		registerShortcut: (_key: unknown, def: { handler: AnyFn }) => {
			shortcuts.push(def);
		},
		getAllTools: () => activeTools.map((n) => ({ name: n })),
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		toolNames: () => Object.keys(tools),
		commandNames: () => Object.keys(commands),
		shortcutCount: () => shortcuts.length,
		fire: (ev: string, ...args: unknown[]) => {
			const h = hooks[ev];
			if (!h) throw new Error(`no hook: ${ev}`);
			return h(...args);
		},
		cmd: (name: string, args: string, ctx: unknown) => {
			const c = commands[name];
			if (!c) throw new Error(`no command: ${name}`);
			return c.handler(args, ctx);
		},
		fireShortcut: (ctx: unknown) => shortcuts[0]?.handler(ctx),
	};
}

function makeCtx(cwd: string) {
	const notes: string[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		model: undefined,
		modelRegistry: { getAll: () => [] },
		ui: {
			setStatus: () => {},
			notify: (msg: string) => {
				notes.push(msg);
			},
			select: async () => undefined,
		},
	};
	return { ctx, notes };
}

function projectCwdWithLockedPersona(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-ext-"));
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "locked.md"),
		"---\nname: locked\nlabel: Locked\npersona: true\ndelegate:\n  allow: [scout]\n---\nLocked supervisor.",
	);
	return cwd;
}

test("piPersona registers the delegate tool, an f8 shortcut, and persona/doctor/orchestrate commands", () => {
	const m = makeMockPi();
	piPersona(m.pi);
	assert.ok(m.toolNames().includes("delegate"));
	assert.deepEqual(m.commandNames().sort(), ["doctor", "orchestrate", "peek", "persona"]);
	assert.equal(m.shortcutCount(), 1);
});

test("/peek reports no async runs initially", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx, notes } = makeCtx(os.tmpdir());
	await m.fire("session_start", undefined, ctx);
	await m.cmd("peek", "", ctx);
	assert.match(notes.join("\n"), /No async runs/);
});

test("session_start loads the bundled personas and agents", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx, notes } = makeCtx(os.tmpdir());
	await m.fire("session_start", undefined, ctx);
	await m.cmd("persona", "list", ctx);
	const listing = notes.join("\n");
	assert.match(listing, /coder/);
	assert.match(listing, /review/);
	assert.match(listing, /antagonist/);
	assert.match(listing, /magi/);
});

test("the input hook leaves opportunistic personas (and no persona) to a normal turn", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx } = makeCtx(os.tmpdir());
	await m.fire("session_start", undefined, ctx);

	assert.equal(await m.fire("input", { source: "interactive", text: "hi" }, ctx), undefined, "no persona ⇒ normal turn");

	await m.cmd("persona", "coder", ctx); // coder has no orchestration block ⇒ opportunistic
	assert.equal(await m.fire("input", { source: "interactive", text: "hi" }, ctx), undefined, "opportunistic ⇒ normal turn");
});

test("/persona activates a persona and before_agent_start injects its prompt", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx } = makeCtx(os.tmpdir());
	await m.fire("session_start", undefined, ctx);

	assert.equal(m.fire("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined, "no persona ⇒ no change");

	await m.cmd("persona", "coder", ctx);
	const injected = m.fire("before_agent_start", { systemPrompt: "BASE" }, ctx);
	assert.match(injected.systemPrompt, /BASE/);
	assert.match(injected.systemPrompt, /decisive software engineer/);
});

test("tool_call gating blocks delegation outside a restrictive project persona's allowlist", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx } = makeCtx(projectCwdWithLockedPersona());
	await m.fire("session_start", undefined, ctx);
	await m.cmd("persona", "locked", ctx);

	assert.equal(m.fire("tool_call", { toolName: "delegate", input: { agent: "scout" } }, ctx), undefined);
	const blocked = m.fire("tool_call", { toolName: "delegate", input: { agent: "ghost" } }, ctx);
	assert.equal(blocked?.block, true);
});

test("the f8 shortcut cycles into a persona", async () => {
	const m = makeMockPi();
	piPersona(m.pi);
	const { ctx } = makeCtx(os.tmpdir());
	await m.fire("session_start", undefined, ctx);
	await m.fireShortcut(ctx);
	assert.notEqual(m.fire("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
});

test("persistence: /persona writes the selection and a fresh session restores it", async () => {
	const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-persist-")), "state.json");
	process.env.PI_PERSONA_STATE_FILE = stateFile;
	process.env.PI_PERSONA_PERSIST = "on";
	try {
		const m1 = makeMockPi();
		piPersona(m1.pi);
		const c1 = makeCtx(os.tmpdir());
		await m1.fire("session_start", undefined, c1.ctx);
		await m1.cmd("persona", "magi", c1.ctx); // user gesture → writes state

		const m2 = makeMockPi();
		piPersona(m2.pi);
		const c2 = makeCtx(os.tmpdir());
		await m2.fire("session_start", undefined, c2.ctx); // restores from disk
		const injected = m2.fire("before_agent_start", { systemPrompt: "BASE" }, c2.ctx);
		assert.notEqual(injected, undefined, "the remembered persona is restored");
		assert.match(injected.systemPrompt, /MAGI/);
	} finally {
		delete process.env.PI_PERSONA_STATE_FILE;
		process.env.PI_PERSONA_PERSIST = "off";
	}
});

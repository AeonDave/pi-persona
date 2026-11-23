import assert from "node:assert/strict";
import * as fs from "node:fs";
import { connect } from "node:net";
import * as path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createEventBus, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piPersona from "../../src/extension.ts";
import { seedDefaults } from "../../src/core/seed.ts";
import { workspaceHash } from "../../src/exocom/paths.ts";
import { makeInProcessEngine, type InProcSession } from "../../src/engine/inproc.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import type { AgentRunSpec, StrategyEngine } from "../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../src/orchestration/types.ts";
import { tempDir } from "../setup/temp-dir.ts";

// A reload must stop everything: after session_shutdown returns, nothing of the old activation is
// running or holding process-global state, so the next activation comes up as the supervisor.
process.env.PI_AGENT_DIR = tempDir("pi-persona-reload-userdir-");
process.env.PI_PERSONA_PERSIST = "off";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
seedDefaults(REPO_ROOT, path.join(process.env.PI_AGENT_DIR, "persona"), true);

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

function makeMockPi() {
	const hooks: Record<string, AnyFn> = {};
	const tools: Record<string, { execute: AnyFn }> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	let activeTools = ["read", "grep", "write", "delegate"];
	const pi = {
		events: createEventBus(),
		getSettings: () => ({ outputPad: 0 }),
		on: (name: string, handler: AnyFn) => { hooks[name] = handler; },
		registerTool: (def: { name: string; execute: AnyFn }) => { tools[def.name] = def; },
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerCommand: (name: string, command: { handler: AnyFn }) => { commands[name] = command; },
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => false,
		sendMessage: () => {},
		getAllTools: () => [...new Set([...activeTools, ...Object.keys(tools)])].map((name) => ({ name, sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "user", origin: "file" } })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = names; },
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		toolNames: () => Object.keys(tools),
		tool: (name: string) => tools[name],
		fire: (name: string, ...args: unknown[]) => hooks[name]?.(...args),
		cmd: (name: string, args: string, ctx: unknown) => commands[name]?.handler(args, ctx),
	};
}

const stubModel = { provider: "stub", id: "m" };

function makeCtx(label: string) {
	const cwd = tempDir(`pi-persona-reload-${label}-`);
	const sessionManager = SessionManager.inMemory(cwd);
	sessionManager.newSession({ id: `reload-${label}` });
	return {
		cwd,
		ctx: {
			cwd,
			hasUI: true,
			mode: "rpc",
			model: stubModel,
			modelRegistry: {
				find: () => stubModel,
				getAll: () => [stubModel],
				getAvailable: () => [stubModel],
				getRegisteredProviderIds: () => [],
				getProvider: () => undefined,
				getRegisteredNativeProvider: () => undefined,
				getRegisteredProviderConfig: () => undefined,
			},
			sessionManager,
			isIdle: () => true,
			hasPendingMessages: () => false,
			getContextUsage: () => undefined,
			ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, select: async () => undefined },
		},
	};
}

/** Resolves once any of the signals aborts. */
function aborted(...signals: Array<AbortSignal | undefined>): Promise<void> {
	return new Promise((resolve) => {
		for (const signal of signals) {
			if (!signal) continue;
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		}
	});
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitUntil(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const start = Date.now();
	while (!(await pred())) {
		if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${what}`);
		await later(10);
	}
}

function canConnect(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ path: endpoint });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => resolve(false));
	});
}

function naturalStop(spec: AgentRunSpec): AgentResult {
	return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, failureKind: "abort", error: "natural stop", modelUsed: "natural/model" };
}

test("reload during an unsettled in-process session factory still brings the next activation up as the supervisor", async () => {
	const priorLeg = process.env.PI_PERSONA_LEG;
	const priorDisable = process.env.PI_PERSONA_DISABLE;
	delete process.env.PI_PERSONA_LEG;
	delete process.env.PI_PERSONA_DISABLE;
	let factoryStarted = false;
	const m = makeMockPi();
	piPersona(m.pi, {
		engineFactories: {
			// Pi's resource loader cannot be cancelled: this factory never settles.
			makeInProcessEngine: (deps) => makeInProcessEngine({ ...deps, createSession: () => { factoryStarted = true; return new Promise<InProcSession>(() => {}); } }),
			makeEngine: () => { throw new Error("the in-process default must not build a child engine"); },
		},
	});
	const { ctx } = makeCtx("guard");
	try {
		await m.fire("session_start", undefined, ctx);
		await m.tool("delegate")!.execute("hang", { agent: "scout", task: "never builds" }, undefined, undefined, ctx);
		await waitUntil(() => factoryStarted, "the leg's session factory");
		assert.equal(process.env.PI_PERSONA_LEG, "1", "the factory holds the leg guard while it loads");

		// The guard is released only at the shutdown deadline; drive that deadline with mocked timers.
		mock.timers.enable({ apis: ["setTimeout"] });
		let done = false;
		const shutdown = Promise.resolve(m.fire("session_shutdown", { reason: "reload" }, ctx)).finally(() => { done = true; });
		for (let i = 0; i < 200 && !done; i++) {
			mock.timers.tick(1_000);
			await turn();
		}
		mock.timers.reset();
		await shutdown;
		assert.notEqual(process.env.PI_PERSONA_LEG, "1", "no leg marker outlives the activation's shutdown");
		assert.equal(process.env.PI_PERSONA_DISABLE, undefined, "the fork-bomb guard is restored");

		const next = makeMockPi();
		piPersona(next.pi);
		assert.ok(next.toolNames().includes("delegate"), "the reloaded activation registers delegate");
		assert.ok(next.toolNames().includes("intercom"), "the reloaded activation registers intercom");
	} finally {
		mock.timers.reset();
		if (priorLeg === undefined) delete process.env.PI_PERSONA_LEG; else process.env.PI_PERSONA_LEG = priorLeg;
		if (priorDisable === undefined) delete process.env.PI_PERSONA_DISABLE; else process.env.PI_PERSONA_DISABLE = priorDisable;
	}
});

test("shutdown keeps a background run's natural stopped result and closes the broker only after the run settles", async () => {
	let endpoint: string | undefined;
	let brokerUpAtSettle: boolean | undefined;
	let settled = false;
	const m = makeMockPi();
	piPersona(m.pi, {
		engineFactories: {
			makeInProcessEngine: () => ({ run: async () => { throw new Error("an mcp leg must use the child engine"); } }),
			makeEngine: (deps) => ({
				run: async (spec, _progress, signal) => {
					endpoint = deps.broker?.endpoint;
					await aborted(signal, deps.signal);
					await later(50); // the real child engine settles after its kill grace, not at once
					brokerUpAtSettle = endpoint ? await canConnect(endpoint) : undefined;
					settled = true;
					return naturalStop(spec);
				},
			}) satisfies StrategyEngine,
		},
	});
	const { ctx, cwd } = makeCtx("natural");
	await m.fire("session_start", undefined, ctx);
	await m.tool("delegate")!.execute("natural", { agent: "scout", task: "stop me", mcp: true }, undefined, undefined, ctx);
	await waitUntil(async () => endpoint !== undefined && await canConnect(endpoint), "the broker host");

	await m.fire("session_shutdown", { reason: "reload" }, ctx);
	assert.equal(settled, true, "shutdown waited for the run's own settlement");
	assert.equal(brokerUpAtSettle, true, "the broker was still up while the child was settling");
	assert.equal(await canConnect(endpoint!), false, "the broker is closed once shutdown returns");

	const root = path.join(process.env.PI_AGENT_DIR!, "telemetry", "v2", workspaceHash(cwd), "pi-persona");
	const events = fs.readdirSync(root).filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => fs.readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean))
		.map((line) => JSON.parse(line) as { type: string; payload: { id?: string; patch?: { status?: string; model?: string } } });
	const final = events.filter((event) => event.type === "agent.updated" && event.payload.id === "async:run-1").at(-1);
	assert.equal(final?.payload.patch?.status, "stopped");
	assert.equal(final?.payload.patch?.model, "natural/model", "the natural result settled the run, not the forced 'session ended'");
});

test("shutdown awaits an untracked /orchestrate run through the same drain", async () => {
	const cwdTag = "orchestrate";
	let started = 0;
	let settled = 0;
	const engine = (signal: AbortSignal | undefined): StrategyEngine => ({
		run: async (spec, _progress, runSignal) => {
			started += 1;
			await aborted(signal, runSignal);
			await later(30);
			settled += 1;
			return naturalStop(spec);
		},
	});
	const m = makeMockPi();
	piPersona(m.pi, { engineFactories: { makeInProcessEngine: (deps) => engine(deps.signal), makeEngine: (deps) => engine(deps.signal) } });
	const { ctx, cwd } = makeCtx(cwdTag);
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "reload-orch.md"),
		"---\nname: reload-orch\npersona: true\norchestration:\n  mode: strategy\n  strategy: fanout\n  roster: magi\n---\nReload drain test supervisor.",
	);
	await m.fire("session_start", undefined, ctx);
	await m.cmd("persona", "reload-orch", ctx);
	const run = Promise.resolve(m.cmd("orchestrate", "audit the repo", ctx));
	await waitUntil(() => started === 3, "the three fan-out members");

	await m.fire("session_shutdown", { reason: "reload" }, ctx);
	assert.equal(settled, 3, "every member settled before shutdown returned");
	await run;
});

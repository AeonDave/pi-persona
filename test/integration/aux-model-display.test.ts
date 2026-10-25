import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piPersona, { type EngineFactories } from "../../src/extension.ts";
import { AgentTree } from "../../src/ui/agent-tree.ts";
import { seedDefaults } from "../../src/core/seed.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import type { AgentRunSpec, StrategyEngine } from "../../src/orchestration/sdk.ts";
import { convene } from "../setup/convene.ts";
import { tempDir } from "../setup/temp-dir.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS = [{ provider: "alpha", id: "one" }, { provider: "beta", id: "two" }];
const SECURITY = "Focus ONLY on the SECURITY lens";

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;
type TelemetryEvent = { type: string; payload: Record<string, unknown> };

function makeMockPi() {
	const hooks: Record<string, AnyFn> = {};
	const tools: Record<string, unknown> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	const events: TelemetryEvent[] = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events: { emit: (_name: string, event: TelemetryEvent) => events.push(event) },
		on: (name: string, handler: AnyFn) => { hooks[name] = handler; },
		registerTool: (tool: { name: string }) => { tools[tool.name] = tool; },
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerCommand: (name: string, command: { handler: AnyFn }) => { commands[name] = command; },
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => false,
		sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); },
		getAllTools: () => Object.keys(tools).map((name) => ({ name })),
		getActiveTools: () => Object.keys(tools),
		setActiveTools: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		events,
		tool: (name: string) => tools[name],
		sentMessages: () => [...sent],
		fire: (name: string, ...args: unknown[]) => hooks[name]?.(...args),
		command: (name: string, args: string, ctx: unknown) => commands[name]?.handler(args, ctx),
	};
}

function projectDir(): string {
	const cwd = tempDir("pi-persona-aux-model-display-");
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "teams.yaml"), "unused: []\n");
	for (const name of ["arbiter", "reviewer"]) {
		fs.writeFileSync(path.join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\n---\nTest actor.\n`);
	}
	return cwd;
}

function personaText(): string {
	return "---\nname: display-host\npersona: true\ncouncil:\n  strategy: fanout\n---\nHost.\n";
}

interface Harness {
	m: ReturnType<typeof makeMockPi>;
	ctx: unknown;
	titles: string[];
	runs: AgentRunSpec[];
}

async function boot(selectModel: (title: string, options: string[]) => string): Promise<Harness> {
	const agentDir = tempDir("pi-persona-aux-model-user-");
	seedDefaults(REPO_ROOT, path.join(agentDir, "persona"), true);
	process.env.PI_AGENT_DIR = agentDir;
	const personaFile = path.join(agentDir, "persona", "agents", "display-host.md");
	fs.mkdirSync(path.dirname(personaFile), { recursive: true });
	fs.writeFileSync(personaFile, personaText());
	const m = makeMockPi();
	const runs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			runs.push(spec);
			return {
				agent: spec.agent,
				output: spec.outputContract ? "approved" : "draft",
				...(spec.outputContract ? { structured: { stance: "approve" } } : {}),
				usage: emptyUsage(),
				ok: true,
			};
		},
	};
	const factories: EngineFactories = { makeEngine: () => engine, makeInProcessEngine: () => engine };
	piPersona(m.pi, { engineFactories: factories });
	const titles: string[] = [];
	const ctx = {
		cwd: projectDir(),
		hasUI: true,
		mode: "rpc",
		model: { provider: "gamma", id: "main" },
		modelRegistry: {
			getAll: () => MODELS, getAvailable: () => MODELS,
			getRegisteredProviderIds: () => [], getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined, getProvider: () => undefined,
		},
		sessionManager: SessionManager.inMemory(),
		isIdle: () => true,
		getContextUsage: () => undefined,
		hasPendingMessages: () => false,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			select: async (title: string, options: string[]) => {
				titles.push(title);
				return selectModel(title, options);
			},
			custom: async () => undefined,
		},
	};
	await m.fire("session_start", undefined, ctx);
	await m.command("persona", "display-host", ctx);
	return { m, ctx, titles, runs };
}

async function runCriticLoop(h: Harness, params: Record<string, unknown>): Promise<unknown> {
	return convene(h, "aux-model-display", { question: "review", strategy: "critic-loop", params });
}

function actorEvents(h: Harness, agent: string): Array<{ label: string; model: string | undefined }> {
	return h.m.events
		.filter((event) => event.type === "agent.added" && event.payload.agent === agent)
		.map((event) => ({ label: String(event.payload.label), model: typeof event.payload.model === "string" ? event.payload.model : undefined }));
}

test("role-keyed auxiliary actors keep their assignment across duplicate SDK display keys", async () => {
	const h = await boot((_title, options) => options.find((option) => option === "beta/two") ?? options[0] ?? "");
	try {
		const actor = { agent: "arbiter", role: SECURITY };
		const result = await runCriticLoop(h, { generator: actor, critic: actor, rounds: 1 }) as { isError?: boolean; content?: Array<{ text?: string }> };
		assert.notEqual(result.isError, true, JSON.stringify(result));

		const rolePrompts = h.titles.filter((title) => title.includes("arbiter · SECURITY"));
		assert.equal(rolePrompts.length, 1, `identical auxiliary role actors share one model participant: ${JSON.stringify(h.titles)}`);
		const actors = actorEvents(h, "arbiter");
		assert.equal(actors.length, 2, "the strategy ran both auxiliary occurrences");
		assert.ok(actors.every((entry) => entry.model === "beta/two"), JSON.stringify(actors));
		assert.deepEqual(actors.map((entry) => entry.label), ["arbiter · SECURITY · two", "arbiter · SECURITY#2 · two"], "AgentTree labels carry the model F9 renders for both duplicate keys");
	} finally {
		await h.m.fire("session_shutdown", {}, h.ctx);
	}
});

test("inline role models and bare auxiliary assignments remain visible at their own precedence", async () => {
	const h = await boot((_title, options) => options.find((option) => option === "alpha/one") ?? options[0] ?? "");
	try {
		const result = await runCriticLoop(h, {
			generator: { agent: "arbiter", role: SECURITY, model: "beta/two" },
			critic: "verifier",
			rounds: 1,
		}) as { isError?: boolean; content?: Array<{ text?: string }> };
		assert.notEqual(result.isError, true, JSON.stringify(result));

		assert.equal(h.titles.filter((title) => title.includes("verifier")).length, 1, `the bare critic needs one choice: ${JSON.stringify(h.titles)}`);
		assert.equal(h.titles.some((title) => title.includes("arbiter · SECURITY")), false, "the inline model is already assigned");
		const arbiter = actorEvents(h, "arbiter");
		const verifier = actorEvents(h, "verifier");
		assert.equal(arbiter[0]?.model, "beta/two", `the inline role pin is displayed: ${JSON.stringify({ arbiter, verifier, runs: h.runs })}`);
		assert.equal(verifier[0]?.model, "alpha/one", `the bare auxiliary keeps its saved agent-key assignment: ${JSON.stringify({ arbiter, verifier, runs: h.runs })}`);
		assert.match(arbiter[0]?.label ?? "", /arbiter · SECURITY · two/, "the AgentTree label carries the inline model F9 renders");
		assert.match(verifier[0]?.label ?? "", /verifier · one/, "the AgentTree label carries the bare assignment F9 renders");
		assert.equal(h.runs[0]?.model, "beta/two", "the explicit inline engine pin is passed through unchanged");
	} finally {
		await h.m.fire("session_shutdown", {}, h.ctx);
	}
});

test("colliding and repeated role hints preserve each inline model and effort on its tree occurrence", async () => {
	const h = await boot((_title, options) => options[0] ?? "");
	const additions: Array<Parameters<AgentTree["add"]>[0]> = [];
	const original = AgentTree.prototype.add;
	const add = mock.method(AgentTree.prototype, "add", function (this: AgentTree, input: Parameters<AgentTree["add"]>[0]) {
		additions.push({ ...input });
		return original.call(this, input);
	});
	try {
		const result = await convene(h, "colliding-role-hints", {
			question: "review",
			strategy: "fanout",
			members: [
				{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens for auth", model: "alpha/one", thinking: "low" },
				{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens for storage", model: "beta/two", thinking: "high" },
				{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens for storage", model: "gamma/three", thinking: "xhigh" },
			],
		});
		assert.notEqual(result.isError, true);

		const reviewers = actorEvents(h, "reviewer");
		assert.equal(reviewers.length, 3);
		assert.deepEqual(reviewers.map((entry) => entry.model).sort(), ["alpha/one", "beta/two", "gamma/three"], JSON.stringify(reviewers));
		assert.deepEqual(h.runs.map((run) => run.model).sort(), ["alpha/one", "beta/two", "gamma/three"], "each occurrence keeps its original inline engine model");
		assert.deepEqual(h.runs.map((run) => run.thinking).sort(), ["high", "low", "xhigh"]);
		const firstRoot = [...new Set(additions.filter((input) => input.kind === "subagent").map((input) => input.parentId))][0];
		assert.ok(firstRoot, "the first call has a tree root");
		for (const [key, model, thinking] of [
			["reviewer · SECURITY", "alpha/one", "low"],
			["reviewer · SECURITY#2", "beta/two", "high"],
			["reviewer · SECURITY#3", "gamma/three", "xhigh"],
		] as const) {
			const occurrence: Array<Parameters<AgentTree["add"]>[0]> = additions.filter((input: Parameters<AgentTree["add"]>[0]) => input.kind === "subagent" && input.parentId === firstRoot && input.id.endsWith(`/${key}`));
			assert.equal(occurrence.length, 2, `${key} is seeded and re-added when live`);
			assert.ok(occurrence.every((input) => input.model === model && input.thinking === thinking), `${key} shows its own inline model/effort in both frames: ${JSON.stringify(occurrence)}`);
		}

		const beforeReordered = h.runs.length;
		const reordered = await convene(h, "colliding-role-hints-reordered", {
			question: "review again",
			strategy: "fanout",
			members: [
				{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens for storage", model: "beta/reordered", thinking: "medium" },
				{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens for auth", model: "alpha/reordered", thinking: "max" },
			],
		});
		assert.notEqual(reordered.isError, true);
		assert.deepEqual(h.runs.slice(beforeReordered).map((run) => run.model).sort(), ["alpha/reordered", "beta/reordered"]);
		assert.deepEqual(h.runs.slice(beforeReordered).map((run) => run.thinking).sort(), ["max", "medium"]);
		const roots = [...new Set(additions.filter((input) => input.kind === "subagent").map((input) => input.parentId))];
		assert.equal(roots.length, 2);
		for (const [key, model, thinking] of [
			["reviewer · SECURITY", "beta/reordered", "medium"],
			["reviewer · SECURITY#2", "alpha/reordered", "max"],
		] as const) {
			const occurrence: Array<Parameters<AgentTree["add"]>[0]> = additions.filter((input: Parameters<AgentTree["add"]>[0]) => input.kind === "subagent" && input.parentId === roots[1] && input.id.endsWith(`/${key}`));
			assert.equal(occurrence.length, 2, `${key} is seeded and re-added in the reordered call`);
			assert.ok(occurrence.every((input) => input.model === model && input.thinking === thinking), `${key} follows the reordered inline participant, not the prior call: ${JSON.stringify(occurrence)}`);
		}
		assert.deepEqual(actorEvents(h, "reviewer").map((entry) => entry.model).sort(), ["alpha/one", "alpha/reordered", "beta/reordered", "beta/two", "gamma/three"]);
	} finally {
		add.mock.restore();
		await h.m.fire("session_shutdown", {}, h.ctx);
	}
});

test("same-role auxiliary generator and critic keep distinct inline model/effort metadata", async () => {
	const h = await boot((_title, options) => options[0] ?? "");
	const additions: Array<Parameters<AgentTree["add"]>[0]> = [];
	const original = AgentTree.prototype.add;
	const add = mock.method(AgentTree.prototype, "add", function (this: AgentTree, input: Parameters<AgentTree["add"]>[0]) {
		additions.push({ ...input });
		return original.call(this, input);
	});
	try {
		const result = await runCriticLoop(h, {
			generator: { agent: "arbiter", role: SECURITY, model: "alpha/generator", thinking: "low" },
			critic: { agent: "arbiter", role: SECURITY, model: "beta/critic", thinking: "xhigh" },
			rounds: 1,
		}) as { isError?: boolean; content?: Array<{ text?: string }> };
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.deepEqual(h.runs.map((run) => [run.model, run.thinking]), [["alpha/generator", "low"], ["beta/critic", "xhigh"]]);
		for (const [key, model, thinking] of [
			["arbiter · SECURITY", "alpha/generator", "low"],
			["arbiter · SECURITY#2", "beta/critic", "xhigh"],
		] as const) {
			const row = additions.filter((input) => input.kind === "subagent" && input.id.endsWith(`/${key}`));
			assert.equal(row.length, 1, `${key} is an auxiliary live row, not a roster seed`);
			assert.equal(row[0]?.model, model, `${key} shows its own inline model`);
			assert.equal(row[0]?.thinking, thinking, `${key} shows its own requested effort`);
		}
		const events = actorEvents(h, "arbiter");
		assert.equal(events.length, 2);
		assert.deepEqual(events.map((event) => event.model), ["alpha/generator", "beta/critic"]);
	} finally {
		add.mock.restore();
		await h.m.fire("session_shutdown", undefined, h.ctx);
	}
});

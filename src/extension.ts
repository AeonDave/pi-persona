/**
 * pi-persona — the single ExtensionFactory wiring every layer to Pi.
 *
 * Loads personas/agents/teams on session_start; applies a persona (prompt +
 * model/thinking/tools) and gates delegation via the PersonaController; registers
 * the `delegate` tool (opportunistic L0), the `f8` cycle, and the `/persona`,
 * `/doctor`, `/orchestrate` commands. Orchestration strategies run through the
 * SDK + ChildProcessEngine. v0.1: child-process engine only.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentConfig } from "./agents/agent.ts";
import { resolveConfig } from "./core/config.ts";
import { DEFAULT_CONTRACT } from "./core/contract.ts";
import type { RunLimits } from "./core/capabilities.ts";
import { type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { loadDefinitions, loadTeams, type ScopedDir } from "./loader.ts";
import { makeRoster } from "./orchestration/roster.ts";
import { makeSDK, type StrategyEngine, type StrategyInput } from "./orchestration/sdk.ts";
import { getStrategy } from "./orchestration/strategy.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import type { Persona } from "./persona/persona.ts";
import { runDelegate } from "./tools/delegate.ts";

const RUN_LIMITS: RunLimits = {
	maxChildren: 8,
	maxDepth: 2,
	maxConcurrency: 4,
	timeoutMs: 120_000,
	budgetTokens: 1_000_000,
};

const BUNDLED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Pi global agent dir, overridable via PI_AGENT_DIR (handy for tests/sandboxes). */
function userAgentDir(): string {
	return process.env.PI_AGENT_DIR || getAgentDir();
}

export default function piPersona(pi: ExtensionAPI): void {
	const config = resolveConfig(process.env);
	if (config.disabled) return;

	let lastCtx: ExtensionContext | undefined;
	let personas: Persona[] = [];
	let agents: AgentConfig[] = [];
	let teams: Record<string, string[]> = {};
	let shadowed: Array<{ name: string; scope: string; path: string }> = [];

	const defDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "personas"), scope: "builtin" },
		{ path: join(BUNDLED_DIR, "agents"), scope: "builtin" },
		{ path: join(userAgentDir(), "agents"), scope: "user" },
		{ path: join(cwd, ".pi", "agents"), scope: "project" },
		...config.extraDirs.map((p) => ({ path: p, scope: "env" })),
	];
	const teamFiles = (cwd: string): string[] => [
		join(BUNDLED_DIR, "teams.yaml"),
		join(userAgentDir(), "teams.yaml"),
		join(cwd, ".pi", "teams.yaml"),
	];

	function reload(cwd: string): void {
		const result = loadDefinitions(defDirs(cwd));
		personas = result.personas;
		agents = result.agents;
		shadowed = result.shadowed.map((f) => ({ name: f.name, scope: f.scope, path: f.path }));
		teams = loadTeams(teamFiles(cwd));
	}

	const host: PersonaHost = {
		allToolNames: () => {
			try {
				return pi.getAllTools().map((t) => t.name);
			} catch {
				return [];
			}
		},
		setActiveTools: (names) => {
			try {
				pi.setActiveTools(names);
			} catch {
				/* ignore */
			}
		},
		getThinkingLevel: () => {
			try {
				return pi.getThinkingLevel();
			} catch {
				return "medium";
			}
		},
		setThinkingLevel: (level) => {
			try {
				pi.setThinkingLevel(level);
			} catch {
				/* clamped/ignored */
			}
		},
		getModel: () => {
			const m = lastCtx?.model;
			return m ? { provider: m.provider, id: m.id } : undefined;
		},
		findModel: (ref) => {
			try {
				const all = lastCtx?.modelRegistry.getAll() ?? [];
				const m = all.find((x) => `${x.provider}/${x.id}` === ref || x.id === ref);
				return m ? { provider: m.provider, id: m.id } : undefined;
			} catch {
				return undefined;
			}
		},
		setModel: async (handle: ModelHandle) => {
			try {
				const all = lastCtx?.modelRegistry.getAll() ?? [];
				const m = all.find((x) => x.provider === handle.provider && x.id === handle.id);
				if (m) await pi.setModel(m);
			} catch {
				/* keep current */
			}
		},
		setStatus: (text) => {
			try {
				lastCtx?.ui.setStatus("persona", text);
			} catch {
				/* cosmetic */
			}
		},
	};

	const controller = new PersonaController(host, config.delegateDefaultAllow);

	function buildEngine(signal?: AbortSignal): StrategyEngine {
		const deps: EngineAdapterDeps = {
			resolveAgent: (n) => agents.find((a) => a.name === n),
			contracts: (n) => (n === "default" ? DEFAULT_CONTRACT : undefined),
		};
		if (signal) deps.signal = signal;
		if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
		return makeEngine(deps);
	}

	function doctorReport(): string {
		const lines: string[] = [];
		lines.push(`pi-persona — active: ${controller.activePersona?.label ?? "none"}`);
		lines.push(`engine backend: child-process`);
		lines.push(`personas (${personas.length}): ${personas.map((p) => p.name).join(", ") || "—"}`);
		lines.push(`agents (${agents.length}): ${agents.map((a) => a.name).join(", ") || "—"}`);
		const teamNames = Object.keys(teams);
		lines.push(`teams (${teamNames.length}): ${teamNames.join(", ") || "—"}`);
		if (shadowed.length > 0) {
			lines.push("shadowed (lower-precedence, overridden):");
			for (const s of shadowed) lines.push(`  - ${s.name} [${s.scope}] ${s.path}`);
		}
		lines.push(`run limits: children≤${RUN_LIMITS.maxChildren}, concurrency≤${RUN_LIMITS.maxConcurrency}`);
		return lines.join("\n");
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		reload(ctx.cwd);
		const wanted = config.defaultPersona ? personas.find((p) => p.name === config.defaultPersona) : undefined;
		if (wanted) await controller.activate(wanted);
		else host.setStatus(controller.activePersona?.label);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		lastCtx = ctx;
		host.setStatus(undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		const prompt = controller.composePrompt(event.systemPrompt);
		if (prompt !== undefined) return { systemPrompt: prompt };
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		lastCtx = ctx;
		return controller.gate(event.toolName, event.input);
	});

	// ── delegate tool (opportunistic L0) ────────────────────────────────────────
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		tasks: Type.Optional(
			Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
				description: "Independent tasks to run in parallel, each {agent, task}",
			}),
		),
		concurrency: Type.Optional(Type.Number({ description: "Max children to run at once (default 4)" })),
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to a specialized sub-agent (single) or fan out across several in parallel.",
			"Reach for this whenever a task has independent parts, needs a fresh/isolated context, or",
			"benefits from a focused specialist — it runs them and returns their structured results to you.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const outcome = await runDelegate(params, buildEngine(signal), RUN_LIMITS.maxConcurrency);
			return {
				content: [{ type: "text", text: outcome.text }],
				details: { results: outcome.results },
				isError: !outcome.ok,
			};
		},
	});

	// ── f8 cycle ────────────────────────────────────────────────────────────────
	pi.registerShortcut(config.keybinding as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Cycle persona (pi-persona)",
		handler: async (ctx) => {
			lastCtx = ctx;
			if (personas.length === 0) return;
			const current = controller.activePersona;
			const idx = current ? personas.findIndex((p) => p.name === current.name) : -1;
			const next = idx + 1;
			if (next >= personas.length) await controller.deactivate();
			else await controller.activate(personas[next]!);
		},
	});

	// ── /persona ─────────────────────────────────────────────────────────────────
	pi.registerCommand("persona", {
		description: "Switch the active supervisor persona: /persona [name|off|list|reload]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const arg = args.trim();
			if (arg === "off" || arg === "none") {
				await controller.deactivate();
				ctx.ui.notify("persona: cleared (default supervisor)", "info");
				return;
			}
			if (arg === "reload") {
				reload(ctx.cwd);
				ctx.ui.notify(`persona: reloaded ${personas.length} personas, ${agents.length} agents`, "info");
				return;
			}
			if (arg === "" || arg === "list") {
				const lines = personas.map(
					(p) => `${p.name === controller.activePersona?.name ? "▶ " : "  "}${p.label} (${p.name})`,
				);
				ctx.ui.notify(
					[`Personas (active: ${controller.activePersona?.label ?? "none"}):`, ...lines].join("\n"),
					"info",
				);
				return;
			}
			const persona = personas.find((p) => p.name === arg || p.label === arg);
			if (!persona) {
				ctx.ui.notify(`persona: "${arg}" not found. Try /persona list`, "error");
				return;
			}
			await controller.activate(persona);
			ctx.ui.notify(`persona: ${persona.label} active`, "info");
		},
	});

	// ── /doctor ──────────────────────────────────────────────────────────────────
	pi.registerCommand("doctor", {
		description: "Explain pi-persona resolution (personas/agents/teams/shadowed)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			ctx.ui.notify(doctorReport(), "info");
		},
	});

	// ── /orchestrate (run the active persona's strategy) ──────────────────────────
	pi.registerCommand("orchestrate", {
		description: "Run the active persona's strategy on a task: /orchestrate <task>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const task = args.trim();
			const persona = controller.activePersona;
			if (!task) {
				ctx.ui.notify("orchestrate: provide a task — /orchestrate <task>", "warning");
				return;
			}
			const orch = persona?.orchestration;
			const stratName = orch?.strategy ?? (orch?.mode === "parallel" ? "fanout" : undefined);
			if (!orch || !stratName) {
				ctx.ui.notify("orchestrate: the active persona declares no runnable strategy/mode", "warning");
				return;
			}
			const strategy = getStrategy(stratName);
			if (!strategy) {
				ctx.ui.notify(`orchestrate: unknown strategy "${stratName}"`, "error");
				return;
			}
			const sdk = makeSDK({ engine: buildEngine(), roster: makeRoster(teams), limits: RUN_LIMITS });
			const input: StrategyInput = { task, params: {} };
			if (orch.roster) input.roster = orch.roster;
			try {
				const result = await strategy.run(input, sdk);
				ctx.ui.notify(result.output || "(no output)", result.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

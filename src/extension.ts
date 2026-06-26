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
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { AgentConfig } from "./agents/agent.ts";
import { resolveConfig } from "./core/config.ts";
import { DEFAULT_CONTRACT } from "./core/contract.ts";
import type { RunLimits } from "./core/capabilities.ts";
import { type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { AsyncRunTracker, buildPeekDigest } from "./engine/async.ts";
import type { ProgressSnapshot } from "./engine/stream.ts";
import { loadDefinitions, loadTeams, type ScopedDir } from "./loader.ts";
import type { StrategyEngine } from "./orchestration/sdk.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import { resolveStrategyName, runPersonaStrategy } from "./persona/orchestrate.ts";
import type { Persona } from "./persona/persona.ts";
import { type DelegateView, runDelegate } from "./tools/delegate.ts";

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

	// Async runs outlive the turn that launched them; on completion we surface the
	// result back to the supervisor as a follow-up (which triggers a fresh turn).
	const tracker = new AsyncRunTracker();
	tracker.onComplete((run) => {
		try {
			const body = run.status === "done" ? (run.result?.output ?? "(no output)") : `failed: ${run.error ?? "(no detail)"}`;
			pi.sendUserMessage(`[pi-persona] async run ${run.id} (${run.agent}) ${run.status}:\n\n${body}`, {
				deliverAs: "followUp",
			});
		} catch {
			/* ignore */
		}
	});

	function buildEngine(signal?: AbortSignal, onProgress?: (s: ProgressSnapshot) => void): StrategyEngine {
		const deps: EngineAdapterDeps = {
			resolveAgent: (n) => agents.find((a) => a.name === n),
			contracts: (n) => (n === "default" ? DEFAULT_CONTRACT : undefined),
		};
		if (signal) deps.signal = signal;
		if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
		if (onProgress) deps.childOptions = { onProgress };
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

	// Mandatory orchestration: when the active persona declares a strategy/parallel
	// mode, run it on the user's turn (the LLM cannot skip it) and fold the result
	// into the prompt. Opportunistic personas (no strategy) take the normal turn.
	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") return undefined;
		const orch = controller.activePersona?.orchestration;
		const task = event.text?.trim();
		if (!orch || !resolveStrategyName(orch) || !task) return undefined;
		const label = resolveStrategyName(orch);
		try {
			const result = await runPersonaStrategy(orch, task, { engine: buildEngine(), teams, limits: RUN_LIMITS });
			if (!result) return undefined;
			return {
				action: "transform",
				text: `${event.text}\n\n[pi-persona] The mandated "${label}" orchestration ran on this request and produced:\n\n${result.output}\n\nPresent and build on this result.`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { action: "transform", text: `${event.text}\n\n[pi-persona] "${label}" orchestration failed: ${message}` };
		}
	});

	// ── delegate tool (opportunistic L0) ────────────────────────────────────────
	const SkillsSchema = Type.Array(Type.String(), {
		description: "Skills the sub-agent loads first — spawns a dynamic specialist (skills are inherited from the host)",
	});
	const DelegateTaskItem = Type.Object({
		agent: Type.String({ description: 'Agent to run — use "operator" for a dynamic, skill-driven executor' }),
		task: Type.String({ description: "Self-contained packet: objective, scope, allowed tools, success signal, non-goals" }),
		skills: Type.Optional(SkillsSchema),
		model: Type.Optional(Type.String({ description: "Model override for this sub-agent" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this sub-agent" })),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		skills: Type.Optional(SkillsSchema),
		model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override (single mode)" })),
		tasks: Type.Optional(
			Type.Array(DelegateTaskItem, { description: "Independent tasks to run in parallel — give each a disjoint scope" }),
		),
		concurrency: Type.Optional(Type.Number({ description: "Max children to run at once (default 4)" })),
		async: Type.Optional(
			Type.Boolean({ description: "Run in the background (single mode): returns a run id and notifies you on completion" }),
		),
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
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			if (params.async && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const id = tracker.launch({ agent, task }, (onProgress) => buildEngine(undefined, onProgress).run({ agent, task }));
				return {
					content: [
						{
							type: "text",
							text: `Launched async run ${id} (agent "${agent}"). It runs in the background — you'll be notified on completion; peek with /peek ${id}.`,
						},
					],
					details: { runId: id },
					isError: false,
				};
			}
			const outcome = await runDelegate(params, buildEngine(signal), RUN_LIMITS.maxConcurrency, (views) => {
				const done = views.filter((v) => !v.running).length;
				onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: { views: outcome.views },
				isError: !outcome.ok,
			};
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			if (args.tasks && args.tasks.length > 0) {
				const names = args.tasks.map((t) => t.agent).join(", ");
				return new Text(
					`${title}${theme.fg("accent", `parallel (${args.tasks.length})`)}${theme.fg("dim", ` → ${names}`)}`,
					0,
					0,
				);
			}
			const agent = args.agent ?? "?";
			const task = args.task ?? "";
			const preview = task.length > 60 ? `${task.slice(0, 60)}…` : task;
			const asyncTag = args.async ? theme.fg("warning", " async") : "";
			return new Text(`${title}${theme.fg("accent", agent)}${asyncTag}${theme.fg("dim", ` ${preview}`)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as { views?: DelegateView[]; runId?: string } | undefined;
			const views = details?.views ?? [];
			if (views.length === 0) {
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : details?.runId ? `async run ${details.runId}` : "(no output)";
				return new Text(text, 0, 0);
			}
			const done = views.filter((v) => !v.running).length;
			const okCount = views.filter((v) => !v.running && v.ok).length;
			const head = done < views.length ? `${done}/${views.length} done` : `${okCount}/${views.length} ok`;
			const container = new Container();
			container.addChild(new Text(`${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", head)}`, 0, 0));
			for (const v of views) {
				const icon = v.running ? theme.fg("warning", "⏳") : v.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const usage = v.usage.input || v.usage.output ? theme.fg("dim", ` ↑${v.usage.input} ↓${v.usage.output}`) : "";
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${icon} ${theme.fg("accent", v.agent)}${usage}`, 0, 0));
				const body = v.running ? "(running…)" : v.output || "(no output)";
				const preview = expanded ? body : body.split("\n").slice(0, 4).join("\n");
				container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
			}
			return container;
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

	// ── /peek (async run progress) ───────────────────────────────────────────────
	pi.registerCommand("peek", {
		description: "Show background async runs and their progress: /peek [runId]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const id = args.trim();
			if (id) {
				const run = tracker.peek(id);
				ctx.ui.notify(run ? buildPeekDigest([run]) : `peek: no run "${id}"`, run ? "info" : "warning");
			} else {
				ctx.ui.notify(buildPeekDigest(tracker.list()), "info");
			}
		},
	});

	// ── /orchestrate (run the active persona's strategy) ──────────────────────────
	pi.registerCommand("orchestrate", {
		description: "Run the active persona's strategy on a task: /orchestrate <task>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const task = args.trim();
			const orch = controller.activePersona?.orchestration;
			if (!task) {
				ctx.ui.notify("orchestrate: provide a task — /orchestrate <task>", "warning");
				return;
			}
			if (!orch || !resolveStrategyName(orch)) {
				ctx.ui.notify("orchestrate: the active persona declares no runnable strategy/mode", "warning");
				return;
			}
			try {
				const result = await runPersonaStrategy(orch, task, { engine: buildEngine(), teams, limits: RUN_LIMITS });
				ctx.ui.notify(result?.output || "(no output)", result?.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

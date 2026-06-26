/**
 * pi-persona — the single ExtensionFactory wiring every layer to Pi.
 *
 * Loads personas/agents/teams on session_start; applies a persona (prompt +
 * model/thinking/tools) and gates delegation via the PersonaController; registers
 * the `delegate` and `council` tools, the unified agent tree + navigable overlay
 * (`f9` / `/agents`), the `f8` persona cycle, and the `/persona`, `/doctor`,
 * `/orchestrate`, `/peek` commands. Orchestration runs through the Strategy SDK +
 * ChildProcessEngine (the only engine backend so far).
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
import type { OrchestrationGrammar, Persona } from "./persona/persona.ts";
import { readLastPersona, writeLastPersona } from "./persona/state.ts";
import { type PersonaConfigStore, readPersonaConfigs, withPersonaModels, writePersonaConfigs } from "./persona/config-store.ts";
import { type DelegateView, runDelegate } from "./tools/delegate.ts";
import { AgentOverlay } from "./ui/agent-overlay.ts";
import { type AddNodeInput, AgentTree, type AgentNodeStatus, renderAgentTree } from "./ui/agent-tree.ts";
import { formatUsage } from "./ui/usage.ts";

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
	let orchestrating = false; // re-entrancy guard for the mandatory input hook
	// A finished mandatory orchestration, injected (hidden) into the next turn's system prompt.
	let pendingOrchestration: { label: string; output: string } | undefined;

	// The unified live tree of every in-flight agent — strategy cores, delegate
	// sub-agents, dynamic specialists — rendered as one sticky widget above the input.
	const agentTree = new AgentTree();
	function renderAgentWidget(): void {
		if (!lastCtx) return;
		try {
			lastCtx.ui.setWidget("persona-agents", agentTree.isEmpty() ? undefined : renderAgentTree(agentTree.snapshot()), {
				placement: "aboveEditor",
			});
		} catch {
			/* cosmetic — the widget is best-effort */
		}
	}
	agentTree.onChange(renderAgentWidget);

	// The navigable agent overlay (f9 / /agents): ↑↓ navigate, ⏎ drill into an
	// agent's output, esc back/close. Live — it re-renders as the tree changes.
	async function openAgentOverlay(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("agents: the navigable overlay needs the interactive TUI", "warning");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => new AgentOverlay(agentTree, tui, theme, () => done(undefined)),
			{ overlay: true },
		);
	}
	let personas: Persona[] = [];
	let agents: AgentConfig[] = [];
	let teams: Record<string, string[]> = {};
	let shadowed: Array<{ name: string; scope: string; path: string }> = [];

	// Remembered selection lives in the global persona folder; only user gestures write it.
	const stateFile = config.stateFile ?? join(userAgentDir(), "persona", "state.json");
	const persist = (name: string | undefined): void => {
		if (config.persist) writeLastPersona(stateFile, name);
	};

	// Per-persona config (model assignments today, open-ended), indexed by persona name.
	const configFile = join(userAgentDir(), "persona", "config.json");
	let personaConfigs: PersonaConfigStore = {};
	const modelsPrompted = new Set<string>(); // ask-once-per-session guard

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
		agentTree.remove(`async:${run.id}`); // clear the async node from the tree on completion
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
			modelFor: (agent) => {
				const persona = controller.activePersona?.name;
				return persona ? personaConfigs[persona]?.models?.[agent] : undefined;
			},
		};
		if (signal) deps.signal = signal;
		if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
		deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs }; // hard wall-clock cap on every child
		if (onProgress) deps.childOptions.onProgress = onProgress;
		return makeEngine(deps);
	}

	// Ask-on-first-run: a parallel ensemble is pointless if every core runs the same
	// model. The first time a persona runs one, prompt for a model per roster agent and
	// persist it (per-persona config); later runs reuse the saved assignment.
	async function ensurePersonaModels(ctx: ExtensionContext, roster: string[]): Promise<void> {
		const persona = controller.activePersona?.name;
		if (!persona || !ctx.hasUI || roster.length < 2) return;
		if (modelsPrompted.has(persona)) return;
		const configured = personaConfigs[persona]?.models ?? {};
		const missing = roster.filter((a) => !configured[a]);
		if (missing.length === 0) return;
		modelsPrompted.add(persona);
		const available = ctx.modelRegistry.getAll();
		if (available.length < 2) return; // can't diversify with a single model
		const options = available.map((m) => `${m.provider}/${m.id}`);
		try {
			ctx.ui.notify(`${persona}: pick a model per agent so the ensemble is diverse (Esc keeps the session default).`, "info");
			const chosen: Record<string, string> = {};
			for (const agent of missing) {
				const pick = await ctx.ui.select(`Model for "${agent}"  ·  ${persona}`, options);
				if (pick) chosen[agent] = pick;
			}
			if (Object.keys(chosen).length > 0) {
				personaConfigs = withPersonaModels(personaConfigs, persona, chosen);
				writePersonaConfigs(configFile, personaConfigs);
			}
		} catch {
			/* dismissed / no UI → fall back to the default model */
		}
	}

	// Run a persona strategy with the unified tree wired in: assign models on first run,
	// seed the roster (cores show by name at once), flip ⏳ → ✓/✗ live, clear when done.
	async function runStrategyVisible(
		ctx: ExtensionContext,
		orch: OrchestrationGrammar,
		task: string,
		idPrefix: string,
		signal?: AbortSignal,
	) {
		const label = resolveStrategyName(orch) ?? "strategy";
		const roster = orch.roster ? (teams[orch.roster] ?? []) : [];
		await ensurePersonaModels(ctx, roster);
		const rootId = `${idPrefix}:${label}`;
		agentTree.add({ id: rootId, label, status: "running" });
		for (const a of roster) agentTree.add({ id: `${rootId}/${a}`, label: a, parentId: rootId, status: "running" });
		try {
			return await runPersonaStrategy(orch, task, {
				engine: buildEngine(signal),
				teams,
				limits: RUN_LIMITS,
				onAgentStatus: (agent, st, result) => {
					const id = `${rootId}/${agent}`;
					if (st === "running") {
						agentTree.add({ id, label: agent, parentId: rootId, status: "running" });
						return;
					}
					const patch: { status: AgentNodeStatus; detail?: string; output?: string } = { status: st };
					if (result) {
						const u = formatUsage(result.usage);
						if (u) patch.detail = u;
						if (result.output) patch.output = result.output;
					}
					agentTree.update(id, patch);
				},
				onAgentProgress: (agent, p) => {
					// Live streaming: update the core's output buffer + a token counter as it runs.
					const id = `${rootId}/${agent}`;
					const patch: { output?: string; detail?: string } = {};
					if (p.output) patch.output = p.output;
					if (p.tokens) patch.detail = `${p.tokens} tok`;
					if (patch.output !== undefined || patch.detail !== undefined) agentTree.update(id, patch);
				},
			});
		} finally {
			agentTree.remove(rootId);
		}
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
		personaConfigs = readPersonaConfigs(configFile);
		// Restore order: env pin > remembered-on-disk. Read-only — never writes here.
		const remembered = config.defaultPersona ?? (config.persist ? readLastPersona(stateFile) : undefined);
		const target = remembered ? personas.find((p) => p.name === remembered) : undefined;
		if (target) await controller.activate(target);
		else host.setStatus(controller.activePersona?.label);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		lastCtx = ctx;
		host.setStatus(undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		let prompt = controller.composePrompt(event.systemPrompt) ?? event.systemPrompt;
		if (pendingOrchestration) {
			prompt = `${prompt}\n\n[orchestration: ${pendingOrchestration.label}] The mandated multi-agent orchestration was run on the user's request and produced the result below. Present and build on it as your answer — do not re-run it:\n\n${pendingOrchestration.output}`;
			pendingOrchestration = undefined;
		}
		return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
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
		if (event.source === "extension" || orchestrating) return undefined;
		const orch = controller.activePersona?.orchestration;
		const task = event.text?.trim();
		if (!orch || !resolveStrategyName(orch) || !task) return undefined;
		const label = resolveStrategyName(orch) ?? "strategy";
		orchestrating = true;
		try {
			const result = await runStrategyVisible(ctx, orch, task, "strategy");
			pendingOrchestration = { label, output: result ? result.output : "(the orchestration returned no result)" };
		} catch (err) {
			pendingOrchestration = { label, output: `orchestration failed: ${err instanceof Error ? err.message : String(err)}` };
		} finally {
			orchestrating = false;
		}
		// Let the user's original prompt proceed; the ruling is injected (hidden) into the
		// turn's system prompt via before_agent_start — no internal plumbing in the chat.
		return undefined;
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
				let nodeId = "";
				const id = tracker.launch({ agent, task }, (onProgress) =>
					buildEngine(undefined, (snap) => {
						onProgress(snap);
						if (!nodeId) return;
						const patch: { output?: string; detail?: string } = {};
						if (snap.output) patch.output = snap.output;
						if (snap.tokens) patch.detail = `${snap.tokens} tok`;
						if (patch.output !== undefined || patch.detail !== undefined) agentTree.update(nodeId, patch);
					}).run({ agent, task }),
				);
				nodeId = `async:${id}`;
				agentTree.add({ id: nodeId, label: `${agent} (async)`, status: "running" });
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
			const delRoot = `delegate:${_toolCallId}`;
			agentTree.add({ id: delRoot, label: "delegate", status: "running" });
			try {
				const delegateLimits = { maxConcurrency: RUN_LIMITS.maxConcurrency, maxChildren: RUN_LIMITS.maxChildren };
				const outcome = await runDelegate(params, buildEngine(signal), delegateLimits, (views) => {
					views.forEach((v, i) => {
						const status: AgentNodeStatus = v.running ? "running" : v.ok ? "done" : "failed";
						const node: AddNodeInput = { id: `${delRoot}/${i}`, label: v.agent, parentId: delRoot, status };
						const usageStr = formatUsage(v.usage);
						if (usageStr) node.detail = usageStr;
						if (v.output) node.output = v.output;
						agentTree.add(node);
					});
					const done = views.filter((v) => !v.running).length;
					onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
				});
				return {
					content: [{ type: "text", text: outcome.text }],
					details: { views: outcome.views },
					isError: !outcome.ok,
				};
			} finally {
				agentTree.remove(delRoot);
			}
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
				const usageStr = formatUsage(v.usage);
				const usage = usageStr ? theme.fg("dim", ` ${usageStr}`) : "";
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
			if (next >= personas.length) {
				await controller.deactivate();
				persist(undefined);
			} else {
				await controller.activate(personas[next]!);
				persist(personas[next]!.name);
			}
		},
	});

	// ── council tool (deliberate → vote → ruling; the executor then applies it) ───
	const CouncilParams = Type.Object({
		question: Type.String({ description: "The decision or problem to deliberate — specific and self-contained" }),
		roster: Type.Optional(Type.String({ description: "Council to convene (default: the active persona's, e.g. magi)" })),
	});
	pi.registerTool({
		name: "council",
		label: "Council",
		description: [
			"Convene a council of specialists with controlled, complementary biases to deliberate a",
			"decision and vote — returns the ruling (winner, tally, each member's view, recorded dissent).",
			"Use it before any significant choice; then EXECUTE the ruling yourself and re-convene when",
			"execution surfaces a new decision.",
		].join(" "),
		parameters: CouncilParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			try {
				const roster = params.roster ?? controller.activePersona?.orchestration?.roster ?? "magi";
				const orch: OrchestrationGrammar = { mode: "strategy", strategy: "magi", roster, params: {} };
				const result = await runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				return {
					content: [{ type: "text", text: result?.output ?? "(the council returned no ruling)" }],
					details: { ruling: result?.output ?? "", status: result?.structured?.status },
					isError: !(result?.ok ?? false),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: { error: message }, isError: true };
			}
		},
		renderCall(args, theme) {
			const q = args.question ?? "";
			const preview = q.length > 60 ? `${q.slice(0, 60)}…` : q;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("council "))}${theme.fg("accent", args.roster ?? "magi")}${theme.fg("dim", ` ${preview}`)}`,
				0,
				0,
			);
		},
	});

	// ── f9: navigable agent overlay ──────────────────────────────────────────────
	pi.registerShortcut("f9" as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Open the navigable agent tree (pi-persona)",
		handler: async (ctx) => {
			lastCtx = ctx;
			await openAgentOverlay(ctx);
		},
	});
	pi.registerCommand("agents", {
		description: "Open the navigable agent tree overlay (↑↓ navigate, ⏎ open, esc close)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			await openAgentOverlay(ctx);
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
				persist(undefined);
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
			persist(persona.name);
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
				const result = await runStrategyVisible(ctx, orch, task, "orchestrate");
				ctx.ui.notify(result?.output || "(no output)", result?.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

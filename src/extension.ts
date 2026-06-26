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
import { type Static, Type } from "typebox";

import type { AgentConfig } from "./agents/agent.ts";
import { resolveConfig } from "./core/config.ts";
import { resolveModelRef } from "./core/models.ts";
import { isThinkingLevel } from "./core/types.ts";
import { DEFAULT_CONTRACT } from "./core/contract.ts";
import type { RunLimits } from "./core/capabilities.ts";
import { type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { AsyncRunTracker, buildPeekDigest } from "./engine/async.ts";
import type { ProgressSnapshot } from "./engine/stream.ts";
import { loadDefinitions, loadTeams, type ScopedDir } from "./loader.ts";
import type { AgentRunSpec, StrategyEngine } from "./orchestration/sdk.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import { resolveStrategyName, runPersonaStrategy } from "./persona/orchestrate.ts";
import type { OrchestrationGrammar, Persona } from "./persona/persona.ts";
import { readLastPersona, writeLastPersona } from "./persona/state.ts";
import {
	type PersonaConfigStore,
	personaModels,
	readPersonaConfigs,
	withPersonaModels,
	writePersonaConfigs,
} from "./persona/config-store.ts";
import { type DelegateView, runDelegate } from "./tools/delegate.ts";
import { AgentOverlay } from "./ui/agent-overlay.ts";
import { type AddNodeInput, AgentTree, type AgentNodeStatus, renderAgentTree } from "./ui/agent-tree.ts";
import { formatUsage } from "./ui/usage.ts";

const RUN_LIMITS: RunLimits = {
	// A generous anti-runaway backstop, not a council-size cap: a declared ensemble
	// (e.g. 9 members × several rounds) must fit; the token budget is the real cost guard.
	maxChildren: 64,
	maxDepth: 2,
	maxConcurrency: 4,
	timeoutMs: 180_000, // IDLE window (resets on output) — kills a hung child, not a busy one
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
	// node id → abort that one agent (so the overlay can STOP a single sub-agent).
	const stopRegistry = new Map<string, () => void>();
	const clearStops = (prefix: string): void => {
		for (const k of [...stopRegistry.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) stopRegistry.delete(k);
	};
	function stopAgent(nodeId: string): boolean {
		const fn = stopRegistry.get(nodeId);
		if (!fn) return false;
		fn();
		stopRegistry.delete(nodeId);
		return true;
	}

	// The live count of agents in flight (leaf cores/legs), published as a status so a
	// custom UI (e.g. pi-1337's frame) can show "N agents" — covers strategy/council
	// cores too, which pi-1337's own delegate-only counter misses.
	function agentCount(): number {
		const nodes = agentTree.snapshot();
		const leaves = nodes.filter((n) => n.parentId !== undefined);
		return (leaves.length > 0 ? leaves : nodes).length;
	}

	function renderAgentWidget(): void {
		if (!lastCtx) return;
		const empty = agentTree.isEmpty();
		try {
			const lines = empty
				? undefined
				: [...renderAgentTree(agentTree.snapshot()), agentTree.hasRunning() ? "  f9: navigate · drill in" : ""];
			lastCtx.ui.setWidget("persona-agents", lines, { placement: "aboveEditor" });
		} catch {
			/* cosmetic — the widget is best-effort */
		}
		try {
			lastCtx.ui.setStatus("persona-agents", empty ? undefined : String(agentCount()));
		} catch {
			/* cosmetic */
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
			(tui, theme, _kb, done) => new AgentOverlay(agentTree, tui, theme, () => done(undefined), stopAgent),
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
		knownAgents: () => agents.map((a) => a.name),
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

	const controller = new PersonaController(host, config.delegateDefaultAllow, RUN_LIMITS);

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
				return persona ? personaModels(personaConfigs, persona)[agent] : undefined;
			},
		};
		if (signal) deps.signal = signal;
		if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
		// The main model thinks adaptively (it picks effort by difficulty); a spawned child
		// can't inherit "adaptive" if its model doesn't support it, so give children an
		// explicit level — the supervisor's (if concrete) or a sane default, overridable.
		const supLevel = host.getThinkingLevel();
		deps.childThinking = config.childThinking ?? (isThinkingLevel(supLevel) ? supLevel : "high");
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
				onAgentStart: (agent, abort) => {
					stopRegistry.set(`${rootId}/${agent}`, abort);
				},
				onAgentStatus: (agent, st, result) => {
					const id = `${rootId}/${agent}`;
					if (st === "running") {
						agentTree.add({ id, label: agent, parentId: rootId, status: "running" });
						return;
					}
					stopRegistry.delete(id);
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
			clearStops(rootId);
			agentTree.remove(rootId);
		}
	}

	// Search/list available models (provider/id), session provider first (★).
	function searchModels(ctx: ExtensionContext, query?: string): { lines: string[]; total: number; capped: boolean } {
		const session = ctx.model?.provider;
		const isSession = (ref: string): boolean => session !== undefined && ref.startsWith(`${session}/`);
		const all = ctx.modelRegistry.getAll().map((m) => `${m.provider}/${m.id}`);
		const q = query?.trim().toLowerCase();
		const filtered = (q ? all.filter((r) => r.toLowerCase().includes(q)) : all).sort(
			(a, b) => Number(!isSession(a)) - Number(!isSession(b)) || a.localeCompare(b),
		);
		const cap = 40;
		const lines = filtered.slice(0, cap).map((r) => `${isSession(r) ? "★ " : "  "}${r}`);
		return { lines, total: filtered.length, capped: filtered.length > cap };
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
		name: Type.Optional(
			Type.String({ description: "Short friendly name for this sub-agent (helps tell several apart in the UI)" }),
		),
		skills: Type.Optional(SkillsSchema),
		model: Type.Optional(
			Type.String({ description: "Model override (exact provider/id — call the `models` tool to find one)" }),
		),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this sub-agent" })),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		name: Type.Optional(Type.String({ description: "Short friendly name for the sub-agent (single mode)" })),
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

	// Canonicalise a delegate's requested model names to provider/id; return a clear
	// error (no spawn) when one is ambiguous/unknown so the supervisor retries with a
	// valid id instead of wasting a child on an unauthenticated provider.
	function resolveDelegateModels(params: Static<typeof DelegateParams>, ctx: ExtensionContext): string | undefined {
		const models = ctx.modelRegistry.getAll().map((m) => ({ provider: m.provider, id: m.id }));
		if (models.length === 0) return undefined;
		const preferProvider = ctx.model?.provider; // the loader/session provider (the authenticated one)
		const slots: Array<{ ref: string; set: (v: string) => void; who: string }> = [];
		if (params.model) slots.push({ ref: params.model, set: (v) => { params.model = v; }, who: "the sub-agent" });
		params.tasks?.forEach((t, i) => {
			if (t.model) slots.push({ ref: t.model, set: (v) => { t.model = v; }, who: `task ${i + 1} (${t.agent})` });
		});
		for (const s of slots) {
			const r = resolveModelRef(s.ref, models, preferProvider);
			if (r.ok) {
				s.set(r.ref);
				continue;
			}
			const list = r.candidates.slice(0, 10).join(", ");
			return `delegate: model "${s.ref}" for ${s.who} is ${r.reason} — use an exact model id. Candidates: ${list}${r.candidates.length > 10 ? ", …" : ""}.`;
		}
		return undefined;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to a specialized sub-agent (single) or fan out across several in parallel.",
			"Reach for this whenever a task has independent parts, needs a fresh/isolated context, or",
			"benefits from a focused specialist — it runs them and returns their structured results to you.",
			"A sub-agent `model` may be a loose name (e.g. 'sonnet'): it auto-resolves to YOUR provider's",
			"matching id. If a name is ambiguous you get the candidates back — pick one, or call `models`.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const modelErr = resolveDelegateModels(params, ctx);
			if (modelErr) return { content: [{ type: "text", text: modelErr }], details: {}, isError: true };
			if (params.async && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const runSpec: AgentRunSpec = { agent, task };
				if (params.model) runSpec.model = params.model;
				if (params.tools && params.tools.length > 0) runSpec.tools = params.tools;
				if (params.skills && params.skills.length > 0) runSpec.skills = params.skills;
				let nodeId = "";
				const id = tracker.launch({ agent, task }, (onProgress) =>
					buildEngine(undefined, (snap) => {
						onProgress(snap);
						if (!nodeId) return;
						const patch: { output?: string; detail?: string } = {};
						if (snap.output) patch.output = snap.output;
						if (snap.tokens) patch.detail = `${snap.tokens} tok`;
						if (patch.output !== undefined || patch.detail !== undefined) agentTree.update(nodeId, patch);
					}).run(runSpec),
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
				const outcome = await runDelegate(
					params,
					buildEngine(signal),
					delegateLimits,
					(views) => {
						views.forEach((v, i) => {
							const id = `${delRoot}/${i}`;
							if (!v.running) stopRegistry.delete(id);
							const status: AgentNodeStatus = v.running ? "running" : v.ok ? "done" : "failed";
							const node: AddNodeInput = { id, label: v.label, parentId: delRoot, status };
							const usageStr = formatUsage(v.usage);
							if (usageStr) node.detail = usageStr;
							if (v.output) node.output = v.output;
							agentTree.add(node);
						});
						const done = views.filter((v) => !v.running).length;
						onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
					},
					(i, abort) => stopRegistry.set(`${delRoot}/${i}`, abort),
				);
				return {
					content: [{ type: "text", text: outcome.text }],
					details: { views: outcome.views },
					isError: !outcome.ok,
				};
			} finally {
				clearStops(delRoot);
				agentTree.remove(delRoot);
			}
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			if (args.tasks && args.tasks.length > 0) {
				// Names live in the tree / final card — keep the call line itself minimal.
				return new Text(`${title}${theme.fg("accent", `parallel (${args.tasks.length})`)}`, 0, 0);
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
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			const running = views.filter((v) => v.running).length;
			// While running, stay one compact line — the live per-agent detail is the agent
			// tree (press f9 to navigate). Show the full per-leg cards only once complete.
			if (running > 0) {
				const done = views.length - running;
				return new Text(
					`${title}${theme.fg("warning", "⏳ ")}${theme.fg("accent", `${done}/${views.length}`)}${theme.fg("dim", " · f9 to watch")}`,
					0,
					0,
				);
			}
			const okCount = views.filter((v) => v.ok).length;
			const container = new Container();
			container.addChild(new Text(`${title}${theme.fg("accent", `${okCount}/${views.length} ok`)}`, 0, 0));
			for (const v of views) {
				const icon = v.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const usageStr = formatUsage(v.usage);
				const usage = usageStr ? theme.fg("dim", ` ${usageStr}`) : "";
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${icon} ${theme.fg("accent", v.label)}${usage}`, 0, 0));
				const body = v.output || "(no output)";
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
		strategy: Type.Optional(
			Type.String({ description: "Deliberation strategy (default: the persona's council strategy)" }),
		),
		roster: Type.Optional(Type.String({ description: "Council roster to convene (default: the persona's)" })),
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
				// Fully persona-driven: a persona's `council:` block picks the strategy, roster,
				// and params — a new ensemble (more members, supermajority, multi-round) needs no
				// code, just a team + (optional) strategy file + a council block. Params override.
				const council = controller.activePersona?.council;
				const strategy = params.strategy ?? council?.strategy ?? "magi";
				const roster = params.roster ?? council?.roster ?? controller.activePersona?.orchestration?.roster ?? "magi";
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: council?.params ?? {} };
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

	// ── /models + a `models` tool — discover/search model ids ─────────────────────
	pi.registerCommand("models", {
		description: "List or search available models (provider/id): /models [query]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const { lines, total, capped } = searchModels(ctx, args);
			if (lines.length === 0) {
				ctx.ui.notify(`models: no match for "${args.trim()}"`, "warning");
				return;
			}
			const head = `models (${total}${capped ? ", showing 40" : ""})${ctx.model ? ` · session ★ ${ctx.model.provider}/${ctx.model.id}` : ""}`;
			ctx.ui.notify(`${head}\n${lines.join("\n")}${capped ? "\n…refine with /models <query>" : ""}`, "info");
		},
	});

	pi.registerTool({
		name: "models",
		label: "Models",
		description: [
			"List or search the available model ids (provider/id). The same name exists under several",
			"providers — use an EXACT id from here as a delegate task's `model`. ★ marks your session",
			"provider; prefer it (it's the authenticated one).",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Filter by substring (provider or id), e.g. 'sonnet'" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const { lines, total, capped } = searchModels(ctx, params.query);
			const text = lines.length
				? `${total} model(s)${capped ? " (showing 40 — refine with a query)" : ""}; ★ = session provider:\n${lines.join("\n")}`
				: `no models match "${params.query ?? ""}"`;
			return { content: [{ type: "text", text }], details: { total }, isError: false };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("models "))}${theme.fg("dim", args.query ?? "(all)")}`, 0, 0);
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

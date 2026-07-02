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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import type { AgentConfig } from "./agents/agent.ts";
import { installBridge, isBridgeMode } from "./bridge.ts";
import { resolveConfig } from "./core/config.ts";
import { resolveModelRef } from "./core/models.ts";
import { isThinkingLevel } from "./core/types.ts";
import { type ContractDef, DEFAULT_CONTRACT } from "./core/contract.ts";
import { seedDefaults, type SeedResult } from "./core/seed.ts";
import { canFanOut, type RunLimits } from "./core/capabilities.ts";
import { fenceUntrusted } from "./core/fence.ts";
import { type EngineAdapterBroker, type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { withModelFallback } from "./engine/fallback.ts";
import { defaultGitExec, isGitRepo, withWorktree } from "./engine/worktree.ts";
import { type InProcessDeps, makeInProcessEngine } from "./engine/inproc.ts";
import { type AsyncRun, AsyncRunTracker, buildCompletionReport, buildPeekDigest, IdleCoalescingNotifier } from "./engine/async.ts";
import { emptyUsage, type ProgressSnapshot } from "./engine/stream.ts";
import { type BrokerHost, startBrokerHost } from "./bus/broker/host.ts";
import { brokerEndpoint } from "./bus/broker/paths.ts";
import { InProcessBus } from "./bus/inproc.ts";
import { loadContracts, loadDefinitions, loadPresets, loadTeams, type ScopedDir } from "./loader.ts";
import { type FlowSpec, flowHash, parseFlow } from "./orchestration/flow.ts";
import { journalWriter, readJournal } from "./orchestration/flow-journal.ts";
import { runFlow } from "./orchestration/flow-run.ts";
import { Semaphore } from "./orchestration/parallel.ts";
import { type RosterMember, rosterNodeKeys, rosterSpec } from "./orchestration/roster.ts";
import type { AgentProgress, AgentRunSpec, AgentStatus, SteerFn, StrategyEngine } from "./orchestration/sdk.ts";
import type { AgentResult } from "./orchestration/types.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import { resolveStrategyName, runPersonaStrategy } from "./persona/orchestrate.ts";
import { expandCouncilPreset, type OrchestrationGrammar, type Persona } from "./persona/persona.ts";
import { readLastPersona, writeLastPersona } from "./persona/state.ts";
import {
	type PersonaConfigStore,
	personaModels,
	readPersonaConfigs,
	withPersonaModels,
	writePersonaConfigs,
} from "./persona/config-store.ts";
import { DelegationLedger, type DelegateView, labelFor, runDelegate, shortModel } from "./tools/delegate.ts";
import { formatInbox, type IntercomParams, runIntercom } from "./tools/intercom.ts";
import { AgentOverlay } from "./ui/agent-overlay.ts";
import { type AddNodeInput, AgentTree, type AgentNodeStatus, renderAgentTree } from "./ui/agent-tree.ts";
import { filterModels, ModelPicker, orderModelRefs } from "./ui/model-picker.ts";
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

/** Cross-process `contact_peer` roster (spec B7): scopes `brokerPeers` — the process-wide,
 *  pre-spawn registry keyed by handle (populated in `makeBrokerDeps`'s `register`, see
 *  below) — to the SAME per-engine group as the caller `self`, mirroring `engine/inproc.ts`'s
 *  per-engine-instance `peerLabels` map. `self`'s OWN recorded group is the source of truth
 *  here, NOT the wire's `group` argument the host would otherwise pass: the child's env
 *  carries no group (spec B6, the wire `register` frame stays minimal), so every wire group
 *  is "" and scoping by it would either always come back empty (this scope) or leak every
 *  concurrent run's peers into one flat list (the host's own default `group=""` scoping).
 *  `self` not found (not registered with `peers: true`) ⇒ empty roster, never a leak.
 *  Exported for direct unit/integration testing — `extension.ts`'s activation closure itself
 *  isn't a testable unit. */
export function listPeersForGroup(brokerPeers: ReadonlyMap<string, { label: string; group: string }>, self: string): Array<{ handle: string; label: string }> {
	const g = brokerPeers.get(self)?.group;
	if (g === undefined) return [];
	return [...brokerPeers.entries()]
		.filter(([handle, p]) => p.group === g && handle !== self)
		.map(([handle, p]) => ({ handle, label: p.label }));
}

export default function piPersona(pi: ExtensionAPI): void {
	// Cross-process broker (v0.5, spec B3): a child spawned with `PI_PERSONA_BUS` set is a
	// broker-connected sub-agent, not a supervisor — load ONLY the bridge (comm-plane tools +
	// inbound follow-ups) and skip the entire persona/delegate/orchestration surface. Checked
	// before anything else (even config resolution) so bridge mode can never be shadowed by
	// the fork-bomb guard's `PI_PERSONA_DISABLE=1` short-circuit below, or by any other early
	// return. `PI_PERSONA_BUS` unset (the default, and every existing test) ⇒ this branch never
	// runs — zero behavior change.
	if (isBridgeMode()) {
		pi.on("session_start", (_event, ctx) => installBridge(pi, ctx));
		return;
	}

	const config = resolveConfig(process.env);
	if (config.disabled) return;

	let lastCtx: ExtensionContext | undefined;
	let disposed = false; // set on session_shutdown; gates late async-run callbacks of a torn-down instance
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
		steerRegistry.delete(nodeId); // a hard-stopped agent is no longer steerable (mirror the strategy path)
		return true;
	}

	// node id → steer that one agent (in-process engine only): inject a live user message.
	const steerRegistry = new Map<string, SteerFn>();
	const clearSteers = (prefix: string): void => {
		for (const k of [...steerRegistry.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) steerRegistry.delete(k);
	};
	function steerAgent(nodeId: string, text: string): boolean {
		const fn = steerRegistry.get(nodeId);
		if (!fn || !text.trim()) return false;
		try {
			fn(text);
		} catch {
			// the handle may point at a just-finished/disposed session — treat as "not steerable"
			return false;
		}
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
			const lines = empty ? undefined : renderAgentTree(agentTree.snapshot());
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
			(tui, theme, _kb, done) =>
				new AgentOverlay(agentTree, tui, theme, () => done(undefined), stopAgent, steerAgent, (id) => steerRegistry.has(id)),
			// Near-fullscreen: watching sub-agents work is a reading surface, not a popup.
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
		);
	}
	let personas: Persona[] = [];
	let agents: AgentConfig[] = [];
	let teams: Record<string, RosterMember[]> = {};
	let contractDefs: Record<string, ContractDef> = {};
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

	// Personas/agents load ONLY from the user dir (populated by `/persona seed|restore`) and the
	// project `.pi/agents`. The bundled defaults are a *seed source*, NOT a live discovery layer,
	// so a fresh install shows no personas until the user opts in — if you don't want them, or want
	// only your own, they simply aren't there. (Contracts/presets/teams keep a builtin layer below:
	// they aren't "personas" and are needed by strategies once personas are installed.)
	const defDirs = (cwd: string): ScopedDir[] => [
		{ path: join(userAgentDir(), "agents"), scope: "user" },
		{ path: join(cwd, ".pi", "agents"), scope: "project" },
		...config.extraDirs.map((p) => ({ path: p, scope: "env" })),
	];
	const teamFiles = (cwd: string): string[] => [
		join(BUNDLED_DIR, "teams.yaml"),
		join(userAgentDir(), "teams.yaml"),
		join(cwd, ".pi", "teams.yaml"),
	];
	const contractDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "contracts"), scope: "builtin" },
		{ path: join(userAgentDir(), "contracts"), scope: "user" },
		{ path: join(cwd, ".pi", "contracts"), scope: "project" },
	];
	const presetDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "presets"), scope: "builtin" },
		{ path: join(userAgentDir(), "presets"), scope: "user" },
		{ path: join(cwd, ".pi", "presets"), scope: "project" },
	];

	function reload(cwd: string): void {
		const result = loadDefinitions(defDirs(cwd));
		// Expand each persona's council `preset` into concrete strategy/roster/params.
		const presets = loadPresets(presetDirs(cwd));
		personas = result.personas.map((p) => (p.council?.preset ? { ...p, council: expandCouncilPreset(p.council, presets) } : p));
		agents = result.agents;
		shadowed = result.shadowed.map((f) => ({ name: f.name, scope: f.scope, path: f.path }));
		teams = loadTeams(teamFiles(cwd));
		contractDefs = loadContracts(contractDirs(cwd));
	}

	// Install the bundled defaults into the user's agent dir — this is the ONLY way personas/agents
	// become active (they are not a live builtin layer). `/persona seed` pulls in missing defaults,
	// `/persona restore` force-overwrites them back to the originals. First-run auto-install is
	// OPT-IN (PI_PERSONA_SEED=on) and happens once (guarded by the marker); by default nothing is
	// installed. Best-effort — never block startup on a write error.
	const seedMarker = (): string => join(userAgentDir(), ".pi-persona-seeded");
	function runSeed(force: boolean): SeedResult {
		const result = seedDefaults(BUNDLED_DIR, userAgentDir(), force);
		try {
			mkdirSync(userAgentDir(), { recursive: true });
			writeFileSync(seedMarker(), "pi-persona: bundled defaults seeded. Delete this file to re-seed on next start.\n");
		} catch {
			/* marker is best-effort */
		}
		return result;
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

	const controller = new PersonaController(host, config.delegateDefaultAllow);

	// The semantic comm plane (guardrails §4.2/§4.9): the in-process bus carries a child's
	// `contact_supervisor` messages to the supervisor (handle "supervisor"). Distinct from
	// engine events (runtime) and the agent-tree ProgressView (derived). The `intercom` tool
	// is the supervisor's read/reply side; coaching personas inject `contact_supervisor`.
	const SUPERVISOR = "supervisor";
	const bus = new InProcessBus();
	bus.register(SUPERVISOR);
	// Sub-agent output is UNTRUSTED: it surfaces to the supervisor as follow-up user turns and
	// tool results, so a sub-agent could otherwise inject "ignore your instructions…". Fence it
	// (core/fence.ts) in a tagged data block with a standing do-not-obey clause.
	/** Drain child→supervisor messages into a compact block for a sync tool result (push). */
	const drainBusBlock = (): string => {
		const msgs = bus.take(SUPERVISOR);
		return msgs.length > 0 ? `\n\n📨 from sub-agents:\n${fenceUntrusted(formatInbox(msgs))}` : "";
	};

	// Shared "deliver to the supervisor only when it is idle" plumbing (see IdleCoalescingNotifier).
	// Both async-run completions and a child's blocking intercom ask flow through it so they reach
	// the supervisor as a fresh turn instead of stranding as orphaned "sticky" follow-ups in pi's
	// queue (pi only drains that queue from an active turn, one-at-a-time, skipping errored turns).
	const idleDelivery = {
		isIdle: () => lastCtx?.isIdle?.() === true,
		hasPending: () => lastCtx?.hasPendingMessages?.() === true,
		deliver: (message: string) => pi.sendUserMessage(message),
		setTimer: (fn: () => void, ms: number) => {
			const h = setTimeout(fn, ms);
			h.unref?.();
			return h;
		},
		clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	// Async runs outlive the turn that launched them; on completion we surface the result(s) back as
	// ONE coalesced notice so the (idle) supervisor can react — e.g. retry a failure with another model.
	const completionNotifier = new IdleCoalescingNotifier<AsyncRun>({
		...idleDelivery,
		render: (runs) => buildCompletionReport(runs, fenceUntrusted),
	});
	// A child's blocking ask (decision/interview) — coalesced and idle-gated so it can't strand and
	// leave the child blocked until its 10-minute ask timeout (bus.ask default).
	const intercomNotifier = new IdleCoalescingNotifier<string>({
		...idleDelivery,
		render: (asks) => asks.join("\n\n"),
	});
	const tracker = new AsyncRunTracker();
	tracker.onComplete((run) => {
		agentTree.remove(`async:${run.id}`); // clear the async node from the tree on completion
		steerRegistry.delete(`async:${run.id}`); // its steer handle is dead once it finishes
		stopRegistry.delete(`async:${run.id}`); // …and so is its stop handle
		if (disposed) return; // instance torn down — don't notify the next session or re-arm a cancelled timer
		// Immediate, human-facing feedback — independent of the supervisor's LLM turn.
		if (run.status === "failed") {
			lastCtx?.ui.notify(`async run ${run.id} (${run.agent}) failed: ${run.error ?? "(no detail)"}`, "error");
		} else {
			lastCtx?.ui.notify(`async run ${run.id} (${run.agent}) done`, "info");
		}
		completionNotifier.notify(run); // coalesced, idle-gated delivery (no sticky pile-up)
		if (tracker.running().length === 0) stopPeek(); // no live runs → stop the idle peek
	});

	// Event wake (default on): a child's BLOCKING question (decision/interview) surfaces at once
	// as a follow-up so the free (async) supervisor can answer it via the `intercom` tool.
	bus.onMessage((env) => {
		if (disposed || env.to !== SUPERVISOR || !env.expectsReply) return;
		// Idle-gated so the ask reaches the (free) supervisor as a turn it can answer via the
		// intercom tool, rather than stranding mid-stream as a sticky follow-up.
		intercomNotifier.notify(
			`[pi-persona] sub-agent ${env.from} needs a ${env.kind}:\n\n${fenceUntrusted(env.text)}\n\nAnswer with the intercom tool: { action: "reply", askId: "${env.id}", message: "…" }`,
		);
	});

	// Periodic peek (opt-in, off unless PI_PERSONA_PEEK_MS > 0): while async children run, the
	// idle supervisor is woken every interval with a compact ProgressView digest + unread
	// messages, so it can choose to steer/reply. Bounded: unref'd, self-stops when no runs remain.
	let peekTimer: ReturnType<typeof setInterval> | undefined;
	function stopPeek(): void {
		if (peekTimer) {
			clearInterval(peekTimer);
			peekTimer = undefined;
		}
	}
	function startPeek(): void {
		if (config.peekEveryMs <= 0 || peekTimer) return;
		peekTimer = setInterval(() => {
			const runs = tracker.running();
			if (runs.length === 0) {
				stopPeek();
				return;
			}
			// Only peek a free, unqueued supervisor: an idle delivery triggers a clean turn, while a
			// busy one would pile up as a sticky follow-up. Skipping is safe — the next tick re-surfaces.
			if (lastCtx?.isIdle?.() !== true || lastCtx?.hasPendingMessages?.() === true) return;
			// Drain only progress messages; blocking asks (expectsReply) are surfaced by the intercom
			// notifier and left for the `intercom inbox` tool — so peek never double-shows them.
			const unread = bus.takeWhere(SUPERVISOR, (e) => !e.expectsReply);
			try {
				pi.sendUserMessage(
					`[pi-persona] peek — ${buildPeekDigest(runs)}${unread.length > 0 ? `\n\n📨 from sub-agents:\n${fenceUntrusted(formatInbox(unread))}` : ""}`,
				);
			} catch {
				/* ignore */
			}
		}, config.peekEveryMs);
		peekTimer.unref?.();
	}

	// Cross-process broker (v0.5, spec B1-B7): opt-in (PI_PERSONA_BROKER), off by default — see
	// `config.broker`. Off ⇒ none of the state below is ever touched, so `deps.broker` stays
	// undefined and the child engine spawns byte-identical to pre-broker pi-persona.
	let brokerHost: BrokerHost | undefined;
	let brokerHostPromise: Promise<BrokerHost> | undefined;
	// Pre-spawn peer registrations (handle → {label, group}): the child's env carries no group
	// (the wire register frame stays minimal, spec B6), so the host's own client-populated
	// registry can't scope `list` per engine instance. `EngineAdapterBroker.register` is called
	// BEFORE spawn with the correct `group` (adapter.ts's per-engine-instance `peerGroup`) —
	// recorded here and used to override the host's default peer lookup, mirroring
	// `engine/inproc.ts`'s per-engine-instance `peerLabels` map (this one is process-wide since
	// several engine instances share the ONE host, each contributing its own group).
	const brokerPeers = new Map<string, { label: string; group: string }>();

	// Lazily starts the host on the FIRST child-engine build (fire-and-forget — the child's own
	// capped-backoff connect tolerates the brief startup race; `endpoint` is a pure function of
	// the session id, so it's known and handed to the child immediately, without waiting on the
	// listen to complete). Idempotent; a failed bind clears the promise so a later build retries.
	function ensureBrokerHost(endpoint: string): void {
		if (brokerHostPromise) return;
		if (process.platform !== "win32") {
			try {
				mkdirSync(dirname(endpoint), { recursive: true }); // POSIX sockets are filesystem paths
			} catch {
				/* best-effort — a failed mkdir surfaces as a listen error below */
			}
		}
		brokerHostPromise = startBrokerHost({
			bus,
			supervisorHandle: SUPERVISOR,
			endpoint,
			// Ignore the wire-supplied `group` (always "" — the child's env carries no group,
			// spec B6) — see `listPeersForGroup`'s header for why deriving scope from `self`'s
			// own `brokerPeers` entry is required instead.
			listPeersFor: (_group, self) => listPeersForGroup(brokerPeers, self),
		});
		brokerHostPromise.then(
			(h) => {
				brokerHost = h;
			},
			(err) => {
				brokerHostPromise = undefined; // never started — a later build gets another chance
				if (process.env.PI_PERSONA_DEBUG) {
					process.stderr.write(`[pi-persona] broker: host failed to start on ${endpoint}: ${err instanceof Error ? err.message : String(err)}\n`);
				}
			},
		);
	}

	// The `EngineAdapterBroker` handed to every child-engine build while the flag is on (spec
	// B1-B7's supervisor-side face — register/unregister run directly against the LOCAL bus +
	// peer map; a remote child is otherwise indistinguishable from an in-process one, by
	// construction). `steerFrame` degrades to a silent no-op before the host has finished
	// starting or after the target has disconnected — "sends report undelivered", never a throw.
	function makeBrokerDeps(ctx: ExtensionContext): EngineAdapterBroker {
		const endpoint = brokerEndpoint(ctx.sessionManager.getSessionId());
		ensureBrokerHost(endpoint);
		return {
			endpoint,
			register: (info) => {
				bus.register(info.handle);
				if (info.peers) brokerPeers.set(info.handle, { label: info.label ?? info.handle, group: info.group ?? "" });
			},
			unregister: (handle) => {
				brokerPeers.delete(handle);
				bus.unregister(handle);
			},
			steerFrame: (handle, text) => {
				brokerHost?.steer(handle, text);
			},
		};
	}

	function buildEngine(signal?: AbortSignal, onProgress?: (s: ProgressSnapshot) => void, engOpts?: { async?: boolean }): StrategyEngine {
		const resolveAgent = (n: string): AgentConfig | undefined => agents.find((a) => a.name === n);
		// A named contract file (contracts/<name>.contract.json) wins; "default" is the built-in.
		const contracts = (n: string): ContractDef | undefined => contractDefs[n] ?? (n === "default" ? DEFAULT_CONTRACT : undefined);
		const modelFor = (agent: string): string | undefined => {
			const persona = controller.activePersona?.name;
			return persona ? personaModels(personaConfigs, persona)[agent] : undefined;
		};
		// The main model thinks adaptively (it picks effort by difficulty); a spawned child
		// can't inherit "adaptive" if its model doesn't support it, so give children an
		// explicit level — the supervisor's (if concrete) or a sane default, overridable.
		const supLevel = host.getThinkingLevel();
		const childThinking = config.childThinking ?? (isThinkingLevel(supLevel) ? supLevel : "high");

		// Cross-process broker (spec B1-B7): lazily built on the FIRST actual child-engine
		// construction below (worktree leg OR `PI_PERSONA_ENGINE=child`) — NOT on every
		// `buildEngine` call, most of which build the (default) in-process engine and never
		// touch a child at all; starting a host for those would be neither lazy nor needed.
		// Memoized so both call sites below share ONE broker object (and its `peerGroup`
		// registration) per `buildEngine` invocation. `config.broker` off (default) or no live
		// `ctx` yet ⇒ stays undefined forever, so `deps.broker` is never set (the default-OFF pin).
		let brokerDepsMemo: EngineAdapterBroker | undefined;
		let brokerDepsBuilt = false;
		const getBrokerDeps = (): EngineAdapterBroker | undefined => {
			if (!brokerDepsBuilt) {
				brokerDepsBuilt = true;
				if (config.broker && lastCtx) brokerDepsMemo = makeBrokerDeps(lastCtx);
			}
			return brokerDepsMemo;
		};

		// A child-process engine pinned to a specific cwd — the seam worktree isolation runs
		// through (a worktree needs its own working dir, i.e. a separate process).
		const childEngineAt = (cwd: string): StrategyEngine => {
			const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking, cwd };
			if (signal) deps.signal = signal;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs };
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			return makeEngine(deps);
		};

		// v0.4: run sub-agents in-process (createAgentSession) instead of spawning `pi -p`.
		let base: StrategyEngine;
		if (config.engine === "inproc" && lastCtx) {
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=inproc\n");
			const ideps: InProcessDeps = { resolveAgent, contracts, modelFor, childThinking, modelRegistry: lastCtx.modelRegistry, cwd: lastCtx.cwd, agentDir: userAgentDir() };
			ideps.timeoutMs = RUN_LIMITS.timeoutMs; // idle watchdog — a hung session must settle, like the child engine's idle kill
			if (signal) ideps.signal = signal;
			if (onProgress) ideps.onProgress = onProgress;
			if (lastCtx.model) ideps.defaultModel = `${lastCtx.model.provider}/${lastCtx.model.id}`;
			// Comm plane: a `coaching: on` persona gives its children `contact_supervisor`.
			// Blocking asks are honoured only for async runs (a sync run holds the turn → it
			// can't answer, so blocking there would deadlock; the tool downgrades to one-way).
			ideps.bus = bus;
			ideps.supervisorHandle = SUPERVISOR;
			if (controller.activePersona?.coaching) ideps.coaching = true;
			// Peer messaging obeys the persona's bus capability (canUseBus; Task: sibling peer comm).
			const caps = controller.capabilities;
			if (caps) ideps.canUseBus = caps.canUseBus;
			if (engOpts?.async) ideps.allowBlocking = true;
			base = makeInProcessEngine(ideps);
		} else {
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=child\n");
			const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking };
			if (signal) deps.signal = signal;
			if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs }; // hard wall-clock cap on every child
			if (onProgress) deps.childOptions.onProgress = onProgress;
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			base = makeEngine(deps);
		}

		// Worktree isolation: an agent/leg marked `isolation: worktree` runs in a throwaway git
		// worktree via the child engine (its edits never touch the main tree), regardless of the
		// default backend. No repo / not requested ⇒ the base engine, unchanged.
		// Provider fallback (outermost): a run whose model PROVIDER fails at call time (auth,
		// outage, 5xx, model-not-supported) is retried on the same model id under another
		// authenticated provider — "priority to the supervisor's provider, but try others and
		// switch on error". No ctx (no registry) ⇒ pass through. Each attempt still runs through
		// worktree isolation + steering below.
		const wrapFallback = (eng: StrategyEngine): StrategyEngine => {
			if (!lastCtx) return eng;
			const prefer = lastCtx.model?.provider;
			return withModelFallback(eng, { models: configuredModels(lastCtx), ...(prefer ? { preferProvider: prefer } : {}) });
		};
		const root = lastCtx?.cwd;
		if (!root) return wrapFallback(base);
		return wrapFallback({
			async run(spec, perProgress, perSignal, perSteer) {
				const iso = spec.isolation ?? resolveAgent(spec.agent)?.isolation;
				if (iso === "worktree" && isGitRepo(root)) {
					try {
						return await withWorktree(root, defaultGitExec, (dir) =>
							childEngineAt(dir).run({ ...spec, isolation: "none" }, perProgress, perSignal, perSteer),
						);
					} catch {
						/* worktree unavailable → fall back to a normal (non-isolated) run */
					}
				}
				return base.run(spec, perProgress, perSignal, perSteer);
			},
		});
	}

	// The models the user actually has configured (authenticated) — NOT every model in
	// the registry. `getAvailable()` is the registry's "has auth configured" filter; we
	// fall back to `getAll()` only if it's unexpectedly empty, so a picker is never blank.
	// This is why the per-agent model popup lists only your providers, and why a loose
	// name like "sonnet" can't resolve to an unconfigured Bedrock look-alike.
	function configuredModels(ctx: ExtensionContext): Array<{ provider: string; id: string }> {
		const reg = ctx.modelRegistry;
		let list = reg.getAll();
		try {
			const avail = reg.getAvailable();
			if (avail.length > 0) list = avail;
		} catch {
			/* older pi without getAvailable() → keep getAll() */
		}
		return list.map((m) => ({ provider: m.provider, id: m.id }));
	}

	// Ask-on-first-run: a parallel ensemble is pointless if every core runs the same
	// model. The first time a persona runs one, prompt for a model per roster agent and
	// persist it (per-persona config); later runs reuse the saved assignment.
	async function ensurePersonaModels(ctx: ExtensionContext, roster: RosterMember[]): Promise<void> {
		const persona = controller.activePersona?.name;
		if (!persona || !ctx.hasUI) return;
		// A member that carries its own inline model needs no picked one; dedupe by agent name.
		const pickable = [...new Set(roster.map((m) => rosterSpec(m)).filter((s) => !s.model).map((s) => s.agent))];
		if (pickable.length < 2) return; // an ensemble of one distinct core can't be diversified
		if (modelsPrompted.has(persona)) return;
		const configured = personaConfigs[persona]?.models ?? {};
		const missing = pickable.filter((a) => !configured[a]);
		if (missing.length === 0) return;
		modelsPrompted.add(persona);
		const available = configuredModels(ctx);
		if (available.length < 2) return; // can't diversify with a single configured model
		const options = orderModelRefs(available.map((m) => `${m.provider}/${m.id}`), ctx.model?.provider);
		try {
			ctx.ui.notify(`${persona}: pick a model per agent so the ensemble is diverse (Esc keeps the session default).`, "info");
			const chosen: Record<string, string> = {};
			for (const agent of missing) {
				const title = `Model for "${agent}"  ·  ${persona}`;
				// In the TUI: a searchable picker (type to filter) whose viewport follows the
				// selection — the built-in select can't scroll a hundreds-long provider list
				// usefully. Outside the TUI (RPC), fall back to the built-in select.
				const pick =
					ctx.mode === "tui"
						? await ctx.ui.custom<string | undefined>(
								(tui, theme, _kb, done) =>
									new ModelPicker(tui, theme, title, options, ctx.model?.provider, (ref) => done(ref)),
								{ overlay: true },
							)
						: await ctx.ui.select(title, options);
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

	// Each core's model beside its name: per-persona assignment → agent default → session.
	function coreLabel(ctx: ExtensionContext, agent: string, key: string = agent): string {
		const persona = controller.activePersona?.name;
		const configured = persona ? personaModels(personaConfigs, persona) : {};
		const model =
			configured[agent] ?? agents.find((a) => a.name === agent)?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const short = shortModel(model);
		// `key` is the disambiguated node id (`agent` for a solo member, `agent · HINT` for a
		// roster-role one) — display that + the model, so three `reviewer` lenses read distinctly.
		return short ? `${key} · ${short}` : key;
	}

	// The SDK lifecycle callbacks that drive the unified tree for one strategy run rooted at
	// `rootId` — shared by /orchestrate, the council tool, and each flow phase. Seeds running
	// cores, flips ⏳ → ✓/✗ with usage, streams progress, and registers stop/steer handles.
	function strategyTreeDeps(ctx: ExtensionContext, rootId: string) {
		return {
			onAgentStart: (agent: string, abort: () => void, key?: string) => {
				stopRegistry.set(`${rootId}/${key ?? agent}`, abort);
			},
			onAgentSteerable: (agent: string, steer: SteerFn, key?: string) => {
				steerRegistry.set(`${rootId}/${key ?? agent}`, steer);
			},
			onAgentStatus: (agent: string, st: AgentStatus, result?: AgentResult, key?: string) => {
				const nodeKey = key ?? agent;
				const id = `${rootId}/${nodeKey}`;
				if (st === "running") {
					// detail "" clears the seeded "queued" marker — this core is actually live now.
					agentTree.add({ id, label: coreLabel(ctx, agent, nodeKey), parentId: rootId, status: "running", detail: "" });
					return;
				}
				stopRegistry.delete(id);
				steerRegistry.delete(id);
				const patch: { status: AgentNodeStatus; detail?: string; output?: string } = { status: st };
				if (result) {
					const u = formatUsage(result.usage);
					if (u) patch.detail = u;
					if (result.output) patch.output = result.output;
				}
				agentTree.update(id, patch);
			},
			onAgentProgress: (agent: string, p: AgentProgress, key?: string) => {
				const id = `${rootId}/${key ?? agent}`;
				const patch: { output?: string; detail?: string } = {
					detail: p.activity || (p.tokens ? `${p.tokens} tok` : ""),
				};
				if (p.output) patch.output = p.output;
				agentTree.update(id, patch);
			},
		};
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
		// Seed the whole roster at once (cores show by name immediately); "queued" until the
		// engine actually starts each one — an honest view under the concurrency limit.
		const seedKeys = rosterNodeKeys(roster);
		roster.forEach((m, i) => {
			const a = rosterSpec(m).agent;
			const key = seedKeys[i] ?? a;
			agentTree.add({ id: `${rootId}/${key}`, label: coreLabel(ctx, a, key), parentId: rootId, status: "running", detail: "queued" });
		});
		try {
			return await runPersonaStrategy(orch, task, { engine: buildEngine(signal), teams, limits: RUN_LIMITS, ...strategyTreeDeps(ctx, rootId) });
		} finally {
			clearStops(rootId);
			clearSteers(rootId);
			agentTree.remove(rootId);
		}
	}

	// ── flows (v0.5): a DAG over strategies, discovered as *.flow.json ────────────
	const flowDirs = (cwd: string): string[] => [
		join(BUNDLED_DIR, "flows"),
		join(userAgentDir(), "flows"),
		join(cwd, ".pi", "flows"),
	];
	function listFlows(cwd: string): string[] {
		const names = new Set<string>();
		for (const dir of flowDirs(cwd)) {
			try {
				for (const f of readdirSync(dir)) if (f.endsWith(".flow.json")) names.add(f.replace(/\.flow\.json$/, ""));
			} catch {
				/* dir absent */
			}
		}
		return [...names].sort();
	}
	function loadFlow(cwd: string, name: string): ReturnType<typeof parseFlow> | undefined {
		// Later dirs win (project > user > builtin) — keep the last readable file's content.
		let found: string | undefined;
		for (const dir of flowDirs(cwd)) {
			try {
				found = readFileSync(join(dir, `${name}.flow.json`), "utf8");
			} catch {
				/* not here */
			}
		}
		return found === undefined ? undefined : parseFlow(found);
	}

	// Run a flow's DAG with the unified tree (phases as nodes, cores beneath) + journaled
	// resume: a prior run's journal (keyed by flow@hash) skips already-done phases; the
	// journal is cleared on a fully-successful run.
	async function runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, baseTask: string, signal?: AbortSignal) {
		const hash = flowHash(spec);
		const journalDir = join(userAgentDir(), "flows");
		try {
			mkdirSync(journalDir, { recursive: true });
		} catch {
			/* best effort */
		}
		const journalPath = join(journalDir, `${spec.name}.${hash.slice(0, 8)}.journal.jsonl`);
		const resume = readJournal(journalPath, hash);

		const rosterMembers = spec.phases.flatMap((p) => (p.roster ? (teams[p.roster] ?? []) : []));
		await ensurePersonaModels(ctx, rosterMembers);

		const flowRoot = `flow:${spec.name}`;
		agentTree.add({ id: flowRoot, label: `flow ${spec.name}`, status: "running" });
		for (const p of spec.phases) {
			const pid = `${flowRoot}/${p.id}`;
			const node: AddNodeInput = { id: pid, label: `${p.id} · ${p.strategy}`, parentId: flowRoot, status: resume[p.id] ? "done" : "running" };
			if (resume[p.id]) node.detail = "resumed";
			agentTree.add(node);
		}
		try {
			const outcome = await runFlow(spec, baseTask, {
				hash,
				resume,
				...(signal ? { signal } : {}),
				journal: journalWriter(journalPath),
				onPhase: (id, status, result) => {
					const patch: { status: AgentNodeStatus; output?: string } = {
						status: status === "running" ? "running" : status === "done" ? "done" : "failed",
					};
					if (result?.output) patch.output = result.output;
					agentTree.update(`${flowRoot}/${id}`, patch);
				},
				runPhase: async ({ phase, task }) => {
					const pid = `${flowRoot}/${phase.id}`;
					const roster = phase.roster ? (teams[phase.roster] ?? []) : [];
					const seedKeys = rosterNodeKeys(roster);
					roster.forEach((m, i) => {
						const a = rosterSpec(m).agent;
						const key = seedKeys[i] ?? a;
						agentTree.add({ id: `${pid}/${key}`, label: coreLabel(ctx, a, key), parentId: pid, status: "running", detail: "queued" });
					});
					const orch: OrchestrationGrammar = { mode: "strategy", strategy: phase.strategy, params: phase.params ?? {} };
					if (phase.roster) orch.roster = phase.roster;
					const r = await runPersonaStrategy(orch, task, {
						engine: buildEngine(signal),
						teams,
						limits: RUN_LIMITS,
						...strategyTreeDeps(ctx, pid),
					});
					return r ?? { agent: phase.id, output: `unknown strategy: ${phase.strategy}`, usage: emptyUsage(), ok: false, error: "unknown strategy" };
				},
				// Checkpoint gate: pause for the user's approval before the gated phase's
				// dependents run. Headless/no-UI ⇒ auto-approve (informational). Approval is
				// journaled so a resume doesn't re-prompt.
				approveGate: async (phase, result) => {
					if (!ctx.hasUI) return true;
					const preview = result.output.replace(/\s+/g, " ").slice(0, 160);
					try {
						const pick = await ctx.ui.select(`Checkpoint "${phase.id}" — approve and continue the flow?\n${preview}`, ["Approve", "Reject"]);
						return pick !== "Reject";
					} catch {
						return true; // dismissed ⇒ don't wedge the flow
					}
				},
			});
			if (outcome.ok) {
				try {
					rmSync(journalPath, { force: true }); // clean journal once the whole flow succeeds
				} catch {
					/* ignore */
				}
			}
			return outcome;
		} finally {
			clearStops(flowRoot);
			clearSteers(flowRoot);
			agentTree.remove(flowRoot);
		}
	}

	// Search/list available models (provider/id), session provider first (★).
	function searchModels(ctx: ExtensionContext, query?: string): { lines: string[]; total: number; capped: boolean } {
		const session = ctx.model?.provider;
		const isSession = (ref: string): boolean => session !== undefined && ref.startsWith(`${session}/`);
		const all = configuredModels(ctx).map((m) => `${m.provider}/${m.id}`);
		const filtered = orderModelRefs(filterModels(all, query ?? ""), session);
		const cap = 40;
		const lines = filtered.slice(0, cap).map((r) => `${isSession(r) ? "★ " : "  "}${r}`);
		return { lines, total: filtered.length, capped: filtered.length > cap };
	}

	function doctorReport(): string {
		const lines: string[] = [];
		lines.push(`pi-persona — active: ${controller.activePersona?.label ?? "none"}`);
		lines.push(`engine backend: ${config.engine === "child" ? "child-process" : "in-process"}`);
		lines.push(`personas (${personas.length}): ${personas.map((p) => p.name).join(", ") || "—"}`);
		lines.push(`agents (${agents.length}): ${agents.map((a) => a.name).join(", ") || "—"}`);
		const teamNames = Object.keys(teams);
		lines.push(`teams (${teamNames.length}): ${teamNames.join(", ") || "—"}`);
		const flows = lastCtx ? listFlows(lastCtx.cwd) : [];
		lines.push(`flows (${flows.length}): ${flows.join(", ") || "—"}`);
		const contractNames = [...new Set(["default", ...Object.keys(contractDefs)])];
		lines.push(`contracts (${contractNames.length}): ${contractNames.join(", ")}`);
		if (shadowed.length > 0) {
			lines.push("shadowed (lower-precedence, overridden):");
			for (const s of shadowed) lines.push(`  - ${s.name} [${s.scope}] ${s.path}`);
		}
		const caps = controller.capabilities;
		if (caps) {
			lines.push(`effective-capabilities: tools=${caps.tools.size}, delegate-targets=${caps.delegateTargets.size}, canFanOut=${canFanOut(caps)}`);
		}
		lines.push(`run limits: children≤${RUN_LIMITS.maxChildren}, concurrency≤${RUN_LIMITS.maxConcurrency}, timeout=${RUN_LIMITS.timeoutMs}ms`);
		const coaching = controller.activePersona?.coaching ?? false;
		const peek = config.peekEveryMs > 0 ? `${config.peekEveryMs}ms` : "off";
		lines.push(`comm plane: coaching=${coaching ? "on (children get contact_supervisor)" : "off"}, periodic-peek=${peek}, bus-peers=${bus.participants().length}`);
		if (config.broker) {
			const status = brokerHost ? brokerHost.endpoint : brokerHostPromise ? "(starting…)" : "(not started — no child-engine build yet)";
			lines.push(`broker: on — endpoint ${status}, connected children: ${brokerHost?.connectedHandles().length ?? 0}`);
		}
		return lines.join("\n");
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// Opt-in only (PI_PERSONA_SEED=on): auto-install the bundled defaults once. Default is off —
		// a fresh install shows no personas until `/persona seed` or `/persona restore`.
		if (config.seed && !existsSync(seedMarker())) {
			try {
				const r = runSeed(false);
				if (ctx.hasUI && r.copied.length > 0) {
					ctx.ui.notify(`pi-persona: seeded ${r.copied.length} default(s) to ${userAgentDir()} — edit them freely; /persona restore brings back the originals.`, "info");
				}
			} catch {
				/* a copy failure (read-only dir, …) must never block session start */
			}
		}
		reload(ctx.cwd);
		personaConfigs = readPersonaConfigs(configFile);
		// Restore order: env pin > remembered-on-disk. Read-only — never writes here.
		const remembered = config.defaultPersona ?? (config.persist ? readLastPersona(stateFile) : undefined);
		const target = remembered ? personas.find((p) => p.name === remembered) : undefined;
		if (target) await controller.activate(target);
		else host.setStatus(controller.activePersona?.label);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		disposed = true; // gate any late async-run onComplete from touching the next session's instance
		stopPeek(); // reload-hygiene: never leak the idle-peek timer across sessions
		completionNotifier.cancel(); // …nor the coalesced-delivery flush timers
		intercomNotifier.cancel();
		// This instance is being torn down (a reload/new/resume rebinds a fresh one); abort in-flight
		// sub-agents and reset control state so nothing is left orphaned or rendered stale.
		for (const abort of [...stopRegistry.values()]) {
			try {
				abort();
			} catch {
				/* ignore */
			}
		}
		stopRegistry.clear();
		steerRegistry.clear();
		agentTree.clear();
		host.setStatus(undefined);
		// Broker teardown (spec B1/B5): idempotent — a session that never built a broker-backed
		// child engine (flag off, or on but unused) never started a host, so this is a no-op.
		if (brokerHostPromise) {
			try {
				const h = await brokerHostPromise;
				await h.close();
			} catch {
				/* best-effort — never block shutdown on a broker teardown error */
			}
			brokerHost = undefined;
			brokerHostPromise = undefined;
			brokerPeers.clear();
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		let prompt = controller.composePrompt(event.systemPrompt) ?? event.systemPrompt;
		if (pendingOrchestration) {
			// The result is sub-agent text entering the SYSTEM prompt — fence it (I-guardrail:
			// untrusted output must never reach the supervisor unfenced, least of all here).
			prompt = `${prompt}\n\n[orchestration: ${pendingOrchestration.label}] The mandated multi-agent orchestration was run on the user's request and produced the result below. Present and build on it as your answer — do not re-run it:\n\n${fenceUntrusted(pendingOrchestration.output)}`;
			pendingOrchestration = undefined;
		}
		return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
	});

	pi.on("tool_call", (event, ctx) => {
		lastCtx = ctx;
		return controller.gate(event.toolName, event.input);
	});

	// Mandatory orchestration: when the active persona declares a strategy/parallel/
	// pipeline mode (or a flow), run it on the user's turn (the LLM cannot skip it) and
	// fold the result into the prompt. Opportunistic personas (no orchestration) take the
	// normal turn.
	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension" || orchestrating) return undefined;
		const orch = controller.activePersona?.orchestration;
		const task = event.text?.trim();
		if (!orch || !task) return undefined;
		const flowName = orch.mode === "flow" ? orch.flow : undefined;
		if (!flowName && !resolveStrategyName(orch)) return undefined;
		const label = flowName ? `flow ${flowName}` : (resolveStrategyName(orch) ?? "strategy");
		orchestrating = true;
		try {
			let output: string;
			if (flowName) {
				const parsed = loadFlow(ctx.cwd, flowName);
				if (!parsed) output = `no flow named "${flowName}"`;
				else if (!parsed.ok) output = `flow "${flowName}" is invalid: ${parsed.error}`;
				else output = (await runFlowVisible(ctx, parsed.flow, task)).output || "(the flow returned no output)";
			} else {
				const result = await runStrategyVisible(ctx, orch, task, "strategy");
				output = result ? result.output : "(the orchestration returned no result)";
			}
			pendingOrchestration = { label, output };
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
	const RoleSchema = Type.String({
		description:
			"On-the-fly specialist persona: extra system-prompt text appended to the agent's own (e.g. 'You are a Rust unsafe-code auditor…') — combine with `skills` to shape a dynamic sub-agent without authoring a file",
	});
	const DelegateTaskItem = Type.Object({
		agent: Type.String({ description: 'Agent to run — use "operator" for a dynamic, skill-driven executor' }),
		task: Type.String({ description: "Self-contained packet: objective, scope, allowed tools, success signal, non-goals" }),
		name: Type.Optional(
			Type.String({ description: "Short HUMAN codename for this sub-agent (e.g. 'pippo', 'luna', 'kilo') — not a task description; tells several apart in the UI" }),
		),
		skills: Type.Optional(SkillsSchema),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(
			Type.String({ description: "Model override (exact provider/id — call the `models` tool to find one)" }),
		),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this sub-agent" })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run in an isolated git worktree (edits never touch the main tree)" }),
		),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		name: Type.Optional(Type.String({ description: "Short HUMAN codename for the sub-agent (e.g. 'pippo') — not a task description (single mode)" })),
		skills: Type.Optional(SkillsSchema),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override (single mode)" })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run the single sub-agent in an isolated git worktree" }),
		),
		tasks: Type.Optional(
			Type.Array(DelegateTaskItem, { description: "Independent tasks to run in parallel — give each a disjoint scope" }),
		),
		concurrency: Type.Optional(Type.Number({ description: "Max children to run at once (default 4)" })),
		async: Type.Optional(
			Type.Boolean({
				description:
					"Run in the background (single OR parallel) so YOU stay free to keep working / answer the user. Returns run ids immediately; each result arrives as a follow-up, /peek to watch.",
			}),
		),
	});

	// Canonicalise a delegate's requested model names to provider/id; return a clear
	// error (no spawn) when one is ambiguous/unknown so the supervisor retries with a
	// valid id instead of wasting a child on an unauthenticated provider.
	function resolveDelegateModels(params: Static<typeof DelegateParams>, ctx: ExtensionContext): string | undefined {
		const models = configuredModels(ctx);
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

	// The async launch pool: every background run passes through here, so a 20-task async
	// fan-out respects the same concurrency ceiling a sync delegate does, instead of opening
	// 20 model sessions at once. Queued runs show as "running" with no progress yet; stopping
	// a queued run works (the engine settles a pre-aborted signal without a model call).
	const asyncSlots = new Semaphore(RUN_LIMITS.maxConcurrency);

	// Runtime anti-loop guard: an identical (agent, model, task) delegation that failed
	// twice is vetoed BEFORE it spawns — the completion report's "don't re-issue" guidance
	// is advice; this is the enforcement (capabilities are never prompt-only).
	const ledger = new DelegationLedger();

	// Launch one agent in the background (tracked) and add its live async node to the tree.
	function launchAsyncRun(agent: string, task: string, runSpec: AgentRunSpec, label: string): string {
		const id = tracker.launch({ agent, task }, (onProgress, runId) => {
			const nodeId = `async:${runId}`;
			// A real, HARD stop for the async run (a steer is only a soft request the child may
			// ignore): aborting this signal makes the engine call the sub-agent's `agent.abort()`.
			const ac = new AbortController();
			stopRegistry.set(nodeId, () => ac.abort());
			return asyncSlots
				.with(() =>
					buildEngine(
						undefined,
						(snap) => {
							onProgress(snap);
							const patch: { output?: string; detail?: string } = {};
							if (snap.output) patch.output = snap.output;
							// Mirrors the main subscription's onAgentProgress fallback: activity (e.g. the
							// "✉ from …" transparency tick) wins over a bare token count.
							if (snap.activity) patch.detail = snap.activity;
							else if (snap.tokens) patch.detail = `${snap.tokens} tok`;
							if (patch.output !== undefined || patch.detail !== undefined) agentTree.update(nodeId, patch);
						},
						{ async: true },
						// STOP via `ac.signal` (hard abort) and STEER via the run-id key (soft redirect) —
						// both work for the supervisor (intercom `stop`/`steer`) and the f9 overlay (`x`/`s`),
						// for ANY persona (these are supervisor→child controls, not child tools).
					).run(runSpec, undefined, ac.signal, (steer) => {
						steerRegistry.set(nodeId, steer);
						agentTree.update(nodeId, { detail: "" }); // live now — clear the "queued" marker
					}),
				)
				.then((r) => {
					ledger.record({ agent, ...(runSpec.model ? { model: runSpec.model } : {}), task }, r.ok);
					return r;
				});
		});
		const nodeId = `async:${id}`;
		// "queued" until the semaphore grants a slot and the engine reports it steerable.
		agentTree.add({ id: nodeId, label: `${label} (async)`, status: "running", detail: "queued" });
		startPeek(); // arm the opt-in idle peek while this run is in flight (no-op if disabled)
		return id;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to a specialized sub-agent (single) or fan out across several in parallel.",
			"Reach for this whenever a task has independent parts, needs a fresh/isolated context, or",
			"benefits from a focused specialist — it runs them and returns their structured results to you.",
			"No fitting agent? Build one ON THE FLY: use `operator` (or any base agent) and shape it with",
			"`role` (an extra system prompt) + `skills` — no file needed.",
			"A sub-agent `model` may be a loose name (e.g. 'sonnet'): it auto-resolves to YOUR provider's",
			"matching id. If a name is ambiguous you get the candidates back — pick one, or call `models`.",
			"If the user may want to keep interacting (coach, ask, redirect) while this runs, prefer",
			"`async: true` so you stay free — results come back as follow-ups; /peek or intercom `wait`",
			"to collect them; sync only when you must have them before your very next step.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const modelErr = resolveDelegateModels(params, ctx);
			if (modelErr) return { content: [{ type: "text", text: modelErr }], details: {}, isError: true };
			// Anti-loop veto (after model canonicalisation, so keys match retries): an
			// identical delegation that already failed twice does not spawn again.
			const requested =
				params.tasks && params.tasks.length > 0
					? params.tasks.map((t) => ({ agent: t.agent, ...(t.model ? { model: t.model } : {}), task: t.task }))
					: params.agent && params.task
						? [{ agent: params.agent, ...(params.model ? { model: params.model } : {}), task: params.task }]
						: [];
			const veto = ledger.vet(requested);
			if (veto) return { content: [{ type: "text", text: veto }], details: {}, isError: true };
			// Async (single OR parallel): run in the background so YOU stay free to keep
			// working / answer the user — results arrive later as follow-ups; /peek to watch.
			if (params.async && params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks.slice(0, RUN_LIMITS.maxChildren);
				const dropped = params.tasks.length - tasks.length;
				const ids = tasks.map((t, i) => {
					const spec: AgentRunSpec = { agent: t.agent, task: t.task };
					if (t.model) spec.model = t.model;
					if (t.tools && t.tools.length > 0) spec.tools = t.tools;
					if (t.skills && t.skills.length > 0) spec.skills = t.skills;
					if (t.role?.trim()) spec.role = t.role.trim();
					if (t.isolation === "worktree") spec.isolation = "worktree";
					return launchAsyncRun(t.agent, t.task, spec, labelFor(t, i));
				});
				const droppedNote = dropped > 0 ? ` ${dropped} task(s) beyond the max-children limit (${RUN_LIMITS.maxChildren}) were dropped.` : "";
				return {
					content: [
						{
							type: "text",
							text: `Launched ${ids.length} async runs in the background (${ids.join(", ")}) — keep working; each notifies on completion. /peek to watch.${droppedNote}`,
						},
					],
					details: { runIds: ids },
					isError: false,
				};
			}
			if (params.async && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const runSpec: AgentRunSpec = { agent, task };
				if (params.model) runSpec.model = params.model;
				if (params.tools && params.tools.length > 0) runSpec.tools = params.tools;
				if (params.skills && params.skills.length > 0) runSpec.skills = params.skills;
				if (params.role?.trim()) runSpec.role = params.role.trim();
				if (params.isolation === "worktree") runSpec.isolation = "worktree";
				const labelArg = { agent, ...(params.name ? { name: params.name } : {}), ...(params.model ? { model: params.model } : {}) };
				const id = launchAsyncRun(agent, task, runSpec, labelFor(labelArg, 0));
				return {
					content: [
						{
							type: "text",
							text: `Launched async run ${id} (${agent}) — runs in the background; you'll be notified on completion. /peek ${id} to watch.`,
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
							if (!v.running) {
								stopRegistry.delete(id);
								steerRegistry.delete(id);
							}
							const status: AgentNodeStatus = v.running ? "running" : v.ok ? "done" : "failed";
							const node: AddNodeInput = { id, label: v.label, parentId: delRoot, status };
							node.detail = v.running ? v.activity : formatUsage(v.usage);
							if (v.output) node.output = v.output;
							agentTree.add(node);
						});
						const done = views.filter((v) => !v.running).length;
						onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
					},
					(i, abort) => stopRegistry.set(`${delRoot}/${i}`, abort),
					(i, steer) => steerRegistry.set(`${delRoot}/${i}`, steer),
				);
				// Feed the anti-loop ledger (results align with the requested tasks by index).
				outcome.results.forEach((r, i) => {
					const t = requested[i];
					if (t) ledger.record(t, r.ok);
				});
				return {
					// Sub-agent text is untrusted even as a tool result (guardrails §: fence
					// before it reaches the supervisor) — the async path already fences via
					// buildCompletionReport; the sync path must match.
					content: [{ type: "text", text: `${fenceUntrusted(outcome.text)}${drainBusBlock()}` }],
					details: { views: outcome.views },
					isError: !outcome.ok,
				};
			} finally {
				clearStops(delRoot);
				clearSteers(delRoot);
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
			// Safe: the delegate `execute` above always stores `{ views: DelegateView[] }` (sync,
			// single/parallel) or `{ runId }` (async) in `details`; the double cast just narrows
			// Pi's opaque `details` type to that known shape for rendering.
			const details = result.details as unknown as { views?: DelegateView[]; runId?: string } | undefined;
			const views = details?.views ?? [];
			if (views.length === 0) {
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : details?.runId ? `async run ${details.runId}` : "(no output)";
				return new Text(text, 0, 0);
			}
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			const running = views.filter((v) => v.running).length;
			// While running, render nothing — the live per-agent view is the tree widget
			// (and the f9 overlay). A sticky card here would just duplicate it. The full
			// per-leg cards below appear once the run completes.
			if (running > 0) return new Container();
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
	const cycleShortcut = {
		description: "Cycle persona (pi-persona)",
		handler: async (ctx: ExtensionContext) => {
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
	};
	type KeyId = Parameters<ExtensionAPI["registerShortcut"]>[0];
	// PI_PERSONA_KEY is user-supplied; an unrecognised key must not break extension load. Try it,
	// and fall back to the default "f8" if Pi rejects it.
	try {
		pi.registerShortcut(config.keybinding as KeyId, cycleShortcut);
	} catch {
		try {
			pi.registerShortcut("f8" as KeyId, cycleShortcut);
		} catch {
			/* no shortcut available — /persona still works */
		}
	}

	// ── intercom tool (supervisor side of the comm plane: read/answer children) ───
	const IntercomToolParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("peek"),
				Type.Literal("wait"),
				Type.Literal("steer"),
				Type.Literal("stop"),
				Type.Literal("list"),
				Type.Literal("inbox"),
				Type.Literal("reply"),
				Type.Literal("send"),
			],
			{
				description:
					"peek = watch your running async sub-agents · wait = BLOCK until async run(s) settle and collect their results (a join) · steer = soft redirect into one by run id (it may ignore it) · stop = HARD-abort one by run id · (all four for any persona, in-process) · list/inbox/reply/send = the coaching message bus (needs a coaching persona)",
			},
		),
		to: Type.Optional(Type.String({ description: "steer/stop/peek/wait: the async run id (e.g. 'run-1'; wait without it = all running) · send: the child bus handle (from `list`)" })),
		askId: Type.Optional(Type.String({ description: "reply: the message id of the child's pending question" })),
		message: Type.Optional(Type.String({ description: "steer/reply/send: the text to deliver" })),
		timeoutMs: Type.Optional(Type.Number({ description: "wait: max ms to hold your turn (default 180000, cap 600000) — on timeout you get what settled + what's still running" })),
	});
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: [
			"See, steer, message, and JOIN your running sub-agents.",
			"`peek` watches what your async sub-agents are doing; `wait` blocks until they settle and",
			"returns their results (use it when you now need an async result before your next step);",
			"`steer` injects a course-correction into one (by run id) mid-run — all for ANY persona on",
			"in-process async runs.",
			"`list`/`inbox`/`reply`/`send` are the message bus (a child reaching you via `contact_supervisor`)",
			"and need a `coaching: on` persona.",
		].join(" "),
		parameters: IntercomToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			// peek + wait + steer + stop are supervisor→child controls over the async tracker /
			// steer handles — available to EVERY persona (no dependency on the coaching bus).
			if (params.action === "peek") {
				const runs = params.to ? [tracker.peek(params.to)].filter((r): r is AsyncRun => !!r) : tracker.running();
				return { content: [{ type: "text", text: buildPeekDigest(runs) }], details: { action: "peek", ok: true }, isError: false };
			}
			if (params.action === "wait") {
				const ids = params.to ? [params.to] : tracker.running().map((r) => r.id);
				if (ids.length === 0) {
					return { content: [{ type: "text", text: "No async runs to wait for." }], details: { action: "wait", ok: true }, isError: false };
				}
				// Bounded join: never longer than a child's ask timeout, so a coaching child
				// blocking on OUR reply can't deadlock us past its own timeout.
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 180_000, 1_000), 600_000);
				const runs = await tracker.waitFor(ids, timeoutMs, _signal);
				const settled = runs.filter((r) => r.status !== "running");
				const still = runs.filter((r) => r.status === "running");
				// These results are delivered HERE — drop them from the pending follow-up
				// notifier so they aren't reported a second time.
				const settledIds = new Set(settled.map((r) => r.id));
				completionNotifier.discard((run) => settledIds.has(run.id));
				const report = settled.length > 0 ? buildCompletionReport(settled, fenceUntrusted) : "";
				const stillNote =
					still.length > 0 ? `⏳ still running after ${timeoutMs}ms: ${still.map((r) => r.id).join(", ")} — peek/steer/stop them, or wait again.` : "";
				const text = [report, stillNote].filter(Boolean).join("\n\n") || "Nothing to report (unknown run ids?).";
				return {
					content: [{ type: "text", text }],
					details: { action: "wait", ok: true, settled: [...settledIds], running: still.map((r) => r.id) },
					isError: false,
				};
			}
			if (params.action === "steer") {
				if (!params.to || params.message === undefined) {
					return { content: [{ type: "text", text: "intercom steer needs { to: <run id>, message }." }], details: { action: "steer", ok: false }, isError: true };
				}
				const nodeId = `async:${params.to}`;
				if (!steerRegistry.has(nodeId)) {
					return {
						content: [{ type: "text", text: `Cannot steer "${params.to}" — no steerable in-process async run by that id (it may have finished; the child engine can't be steered).` }],
						details: { action: "steer", ok: false },
						isError: true,
					};
				}
				// Routed through the guarded steerAgent so a just-finished/disposed handle can't throw.
				const steered = steerAgent(nodeId, params.message);
				return steered
					? { content: [{ type: "text", text: `Steered ${params.to}: "${params.message}" (note: steer is a soft request — use action "stop" to hard-abort).` }], details: { action: "steer", ok: true }, isError: false }
					: { content: [{ type: "text", text: `Could not steer "${params.to}" — it may have just finished, or the message was empty.` }], details: { action: "steer", ok: false }, isError: true };
			}
			if (params.action === "stop") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom stop needs { to: <run id> }." }], details: { action: "stop", ok: false }, isError: true };
				}
				// HARD stop: aborts the run's signal → the engine calls the sub-agent's agent.abort().
				const stopped = stopAgent(`async:${params.to}`);
				return stopped
					? { content: [{ type: "text", text: `Aborting ${params.to} — the sub-agent is being hard-stopped; its run will settle as aborted shortly.` }], details: { action: "stop", ok: true }, isError: false }
					: {
							content: [{ type: "text", text: `Cannot stop "${params.to}" — no running async run by that id (it may have already finished).` }],
							details: { action: "stop", ok: false },
							isError: true,
						};
			}

			// The message bus (coaching): list / inbox / reply / send.
			const out = runIntercom(params as IntercomParams, bus, SUPERVISOR);
			let text = out.text;
			if ((params.action === "list" || params.action === "inbox") && !controller.activePersona?.coaching) {
				const who = controller.activePersona?.name ?? "default";
				text += `\n\n(coaching is OFF for persona "${who}" — sub-agents get no contact_supervisor tool, so the message bus is empty. To just watch or redirect them use action "peek"/"steer"; to exchange messages, add \`coaching: true\` or switch to a coaching persona.)`;
			}
			return { content: [{ type: "text", text }], details: out.details, isError: !out.details.ok };
		},
	});

	// ── council tool (deliberate → vote → ruling; the executor then applies it) ───
	const CouncilParams = Type.Object({
		question: Type.String({ description: "The decision or problem to deliberate — specific and self-contained" }),
		strategy: Type.Optional(
			Type.String({ description: "Deliberation strategy (default: the persona's council strategy)" }),
		),
		roster: Type.Optional(Type.String({ description: "Council roster to convene (default: the persona's)" })),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					'Strategy params, merged over the persona\'s (e.g. { "reflect": false } to skip magi\'s reflection round, { "aggregate": "unanimity" }, { "rounds": 3 }). Reach for it when the user asks for a variant of the persona\'s default council this one time.',
			}),
		),
	});
	pi.registerTool({
		name: "council",
		label: "Council",
		description: [
			"Convene a council of specialists with controlled, complementary biases to deliberate a",
			"decision and vote — returns the ruling (winner, tally, each member's view, recorded dissent).",
			"Use it before any significant choice; then EXECUTE the ruling yourself and re-convene when",
			"execution surfaces a new decision. Pass `params` to vary the persona's default council for",
			'one call — e.g. { "reflect": false } to run magi as a pure independent poll (no reflection round).',
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
				// Per-call params override the persona's council defaults (e.g. reflect:false this once).
				const mergedParams = { ...(council?.params ?? {}), ...((params.params as Record<string, unknown> | undefined) ?? {}) };
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: mergedParams };
				const result = await runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				const s = (result?.structured ?? {}) as { headline?: string; status?: string; tally?: Record<string, number> };
				const ruling = result?.output ?? "(the council returned no ruling)";
				return {
					// The ruling is sub-agent (council member) text — fence it like every other
					// path that hands sub-agent output to the supervisor.
					content: [{ type: "text", text: `${fenceUntrusted(ruling)}${drainBusBlock()}` }],
					details: {
						headline: s.headline ?? s.status ?? "",
						status: s.status,
						tally: s.tally,
						body: result?.output ?? "",
						roster,
					},
					isError: !(result?.ok ?? false),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: { error: message }, isError: true };
			}
		},
		renderCall(args, theme) {
			// Keep the call line minimal — the question is long and gets truncated; the
			// verdict shows in the (collapsed) result instead.
			return new Text(`${theme.fg("toolTitle", theme.bold("council "))}${theme.fg("accent", args.roster ?? "magi")}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as { headline?: string; tally?: Record<string, number>; body?: string; roster?: string; error?: string };
			const head = theme.fg("toolTitle", theme.bold("council "));
			if (d.error) return new Text(`${head}${theme.fg("error", d.error)}`, 0, 0);
			const tallyStr = d.tally ? Object.entries(d.tally).map(([k, v]) => `${k}=${v}`).join(" ") : "";
			const tag = theme.fg("dim", `${d.roster ?? "magi"}${tallyStr ? ` · ${tallyStr}` : ""}`);
			const first = result.content[0];
			const body = d.body || (first && first.type === "text" ? first.text : "");
			// Collapsed by default (ctrl+o to expand): a one-line verdict, not the full ruling.
			if (!expanded) {
				const src = d.headline || body.split("\n").find((l) => l.trim()) || "(ruling)";
				const verdict = src.length > 80 ? `${src.slice(0, 80)}…` : src;
				return new Text(`${head}${tag}  ${theme.fg("accent", verdict)}${theme.fg("dim", "  · ctrl+o")}`, 0, 0);
			}
			const c = new Container();
			c.addChild(new Text(`${head}${tag}`, 0, 0));
			c.addChild(new Text(theme.fg("toolOutput", body), 0, 0));
			return c;
		},
	});

	// ── flow tool (run a *.flow.json DAG over strategies; the supervisor self-launches) ──
	const FlowToolParams = Type.Object({
		name: Type.String({ description: "The flow to run — a *.flow.json by name (see /doctor for the list)" }),
		task: Type.String({ description: "The objective to run the flow on" }),
	});
	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Run a named flow — a declarative DAG over strategies (`*.flow.json`): phases each run a",
			"strategy over a roster, wired by `needs`, fanning out where independent and threading each",
			"phase's output into its dependents. Journaled, so an interrupted flow resumes. Reach for it",
			"when a task has a fixed multi-stage shape (e.g. gather → critique → decide) you want run",
			"deterministically, end to end, rather than deciding each step yourself.",
		].join(" "),
		parameters: FlowToolParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const parsed = loadFlow(ctx.cwd, params.name);
			if (!parsed) {
				return { content: [{ type: "text", text: `no flow named "${params.name}" (see /doctor for the list)` }], details: {}, isError: true };
			}
			if (!parsed.ok) {
				return { content: [{ type: "text", text: `flow "${params.name}" is invalid: ${parsed.error}` }], details: {}, isError: true };
			}
			try {
				const outcome = await runFlowVisible(ctx, parsed.flow, params.task, signal);
				return { content: [{ type: "text", text: fenceUntrusted(outcome.output || "(flow produced no output)") }], details: { ok: outcome.ok }, isError: !outcome.ok };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `flow failed: ${message}` }], details: { error: message }, isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("flow "))}${theme.fg("accent", args.name ?? "?")}`, 0, 0);
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
		description: "Switch the active supervisor persona: /persona [name|off|list|reload|seed|restore]",
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
			// seed = copy any MISSING bundled defaults into the user dir (pull new ones);
			// restore = force-overwrite them back to the bundled originals (discards your edits).
			if (arg === "seed" || arg === "restore") {
				const force = arg === "restore";
				const r = runSeed(force);
				reload(ctx.cwd);
				// Re-apply the active persona so a restored definition takes effect immediately.
				const active = controller.activePersona?.name;
				const fresh = active ? personas.find((p) => p.name === active) : undefined;
				if (fresh) await controller.activate(fresh);
				const kept = r.skipped.length > 0 ? `, kept ${r.skipped.length} existing` : "";
				ctx.ui.notify(`persona: ${force ? "restored" : "seeded"} ${r.copied.length} default(s) to ${userAgentDir()}${kept}.`, "info");
				return;
			}
			if (arg === "" || arg === "list") {
				// Empty by design on a fresh install: personas load only from the user dir, which the
				// user populates on purpose. Point them at the install gesture rather than leaving a
				// bare "(none)" that reads like something is broken.
				if (personas.length === 0) {
					ctx.ui.notify(
						"No personas installed. pi-persona does not auto-install — run `/persona seed` to copy the bundled defaults into your agent dir (edit them freely; `/persona restore` re-installs the originals).",
						"info",
					);
					return;
				}
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
			// A flow persona (`mode: flow`) is just as runnable — run its flow, like the input hook does.
			if (orch?.mode === "flow" && orch.flow) {
				const parsed = loadFlow(ctx.cwd, orch.flow);
				if (!parsed) {
					ctx.ui.notify(`orchestrate: no flow named "${orch.flow}"`, "error");
					return;
				}
				if (!parsed.ok) {
					ctx.ui.notify(`orchestrate: flow "${orch.flow}" is invalid: ${parsed.error}`, "error");
					return;
				}
				try {
					const outcome = await runFlowVisible(ctx, parsed.flow, task);
					ctx.ui.notify(outcome.output || "(flow produced no output)", outcome.ok ? "info" : "warning");
				} catch (err) {
					ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
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

	// ── /flow (run a *.flow.json DAG over strategies; journaled resume) ───────────
	pi.registerCommand("flow", {
		description: "Run a flow (DAG over strategies): /flow <name> <task> — or /flow to list",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed || trimmed === "list") {
				const flows = listFlows(ctx.cwd);
				ctx.ui.notify(
					flows.length ? `flows: ${flows.join(", ")}  ·  /flow <name> <task>` : "no flows — add a *.flow.json under .pi/flows/",
					"info",
				);
				return;
			}
			const sp = trimmed.search(/\s/);
			const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
			const task = sp < 0 ? "" : trimmed.slice(sp + 1).trim();
			if (!task) {
				ctx.ui.notify(`flow: provide a task — /flow ${name} <task>`, "warning");
				return;
			}
			const parsed = loadFlow(ctx.cwd, name);
			if (!parsed) {
				ctx.ui.notify(`flow: no flow named "${name}" (try /flow to list)`, "warning");
				return;
			}
			if (!parsed.ok) {
				ctx.ui.notify(`flow "${name}" is invalid: ${parsed.error}`, "error");
				return;
			}
			try {
				const outcome = await runFlowVisible(ctx, parsed.flow, task);
				ctx.ui.notify(outcome.output || "(flow produced no output)", outcome.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`flow failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

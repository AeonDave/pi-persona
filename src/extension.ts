/**
 * pi-persona — the single ExtensionFactory wiring every layer to Pi.
 *
 * Loads personas/agents/teams on session_start; applies a persona (prompt +
 * model/thinking/tools) and gates delegation via the PersonaController; registers
 * the `delegate` and `council` tools, the unified agent tree + navigable overlay
 * (`f9` / `/agents`), the `f8` persona cycle, and the `/persona`, `/doctor`,
 * `/orchestrate`, `/peek` commands. Orchestration runs through the Strategy SDK on
 * one of two engine backends: InProcessEngine (the runtime default — steerable,
 * shares the session) or ChildProcessEngine (the correctness baseline — worktree
 * isolation; see docs/ARCHITECTURE.md).
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
import { buildDelegationBrief } from "./core/brief.ts";
import { canDelegateTo, canFanOut, type RunLimits } from "./core/capabilities.ts";
import { fenceUntrusted } from "./core/fence.ts";
import { DelegationNudge, PersistenceNudge } from "./core/nudge.ts";
import { type EngineAdapterBroker, type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { withModelFallback } from "./engine/fallback.ts";
import { defaultGitExec, isGitRepo, withWorktree } from "./engine/worktree.ts";
import { type InProcessDeps, makeInProcessEngine } from "./engine/inproc.ts";
import { type AsyncRun, AsyncRunTracker, buildCheckIn, buildPeekAlert, buildPeekDigest, dedupeRunsById, IdleCoalescingNotifier, PeekWatcher, renderCompletion } from "./engine/async.ts";
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
import { knownParams, strategyNames } from "./orchestration/strategy.ts";
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
import { DelegationLedger, type DelegateView, labelFor, runDelegate, shortModel, unknownAgentError, wantsAsyncRun } from "./tools/delegate.ts";
import { formatInbox, type IntercomParams, runIntercom } from "./tools/intercom.ts";
import { formatRemaining, renderTimerFire, TimerScheduler, type TimerEntry } from "./core/timer.ts";
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

// A running async child that hasn't ADVANCED (output/turns/tokens) for this long is flagged
// "possibly stuck" — the soft stall signal. It is deliberately patient: a long scan, a big
// generation, or a blocking command shows no visible progress yet is perfectly healthy, so we wake
// the supervisor only after a genuinely long quiet spell. Purely advisory (no auto-abort); the idle
// watchdog (RUN_LIMITS.timeoutMs, reset on progress) + token budget are the always-on enforcing
// backstops, with the OPT-IN hard cap (PI_PERSONA_AGENT_MAX_MS, off by default) as an extra ceiling.
const STALL_FLAG_MS = 90_000;

const BUNDLED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "persona";

/** The Pi global agent dir, overridable via PI_AGENT_DIR (handy for tests/sandboxes). */
function userAgentDir(): string {
	return process.env.PI_AGENT_DIR || getAgentDir();
}
function personaDataDir(): string {
	return join(userAgentDir(), DATA_DIR);
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
	// Delegation nudge: watches the supervisor's OWN tool-result stream and reminds it to hand off
	// when it grinds heavy work by hand (config.nudge; gated to delegating personas at the hook).
	const delegationNudge = new DelegationNudge();
	// Persistence nudge: the counterweight — when a delegated leg comes back BLOCKED/UNKNOWN, remind
	// the supervisor not to bank a premature surrender (same config.nudge gate + hook as above).
	const persistenceNudge = new PersistenceNudge();
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

	// Remembered selection lives in the persona data folder; only user gestures write it.
	const stateFile = config.stateFile ?? join(personaDataDir(), "state.json");
	const readRememberedPersona = (): string | undefined => {
		if (!config.persist) return undefined;
		return readLastPersona(stateFile);
	};
	const persist = (name: string | undefined): void => {
		if (config.persist) writeLastPersona(stateFile, name);
	};

	// Per-persona config (model assignments today, open-ended), indexed by persona name.
	const configFile = join(personaDataDir(), "config.json");
	const readConfigStore = (): PersonaConfigStore => {
		return readPersonaConfigs(configFile);
	};
	let personaConfigs: PersonaConfigStore = {};
	const modelsPrompted = new Set<string>(); // ask-once-per-session guard

	// Personas/agents load ONLY from the user dir (populated by `/persona seed|restore`) and the
	// project `.pi/agents`. The bundled defaults are a *seed source*, NOT a live discovery layer,
	// so a fresh install shows no personas until the user opts in — if you don't want them, or want
	// only your own, they simply aren't there. (Contracts/presets/teams keep a builtin layer below:
	// they aren't "personas" and are needed by strategies once personas are installed.)
	const defDirs = (cwd: string): ScopedDir[] => [
		{ path: join(personaDataDir(), "agents"), scope: "user" },
		{ path: join(cwd, ".pi", "agents"), scope: "project" },
		...config.extraDirs.map((p) => ({ path: p, scope: "env" })),
	];
	const teamFiles = (cwd: string): string[] => [
		join(BUNDLED_DIR, "teams.yaml"),
		join(personaDataDir(), "teams.yaml"),
		join(cwd, ".pi", "teams.yaml"),
	];
	const contractDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "contracts"), scope: "builtin" },
		{ path: join(personaDataDir(), "contracts"), scope: "user" },
		{ path: join(cwd, ".pi", "contracts"), scope: "project" },
	];
	const presetDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "presets"), scope: "builtin" },
		{ path: join(personaDataDir(), "presets"), scope: "user" },
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
	const seedMarker = (): string => join(personaDataDir(), ".pi-persona-seeded");
	function runSeed(force: boolean): SeedResult {
		const result = seedDefaults(BUNDLED_DIR, personaDataDir(), force);
		try {
			mkdirSync(personaDataDir(), { recursive: true });
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
				// `level` is our local ThinkingLevel — a SUPERSET that may include an upstream level
				// (e.g. `max`) the installed pi predates. Cast to pi's parameter type at the boundary:
				// we can't statically match every pi version's union, and pi clamps an unknown level.
				// (A wider level only ever reaches here on a pi that actually supports it, since it
				// originates from pi.getThinkingLevel() — so the cast is safe in practice, not just typed.)
				pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
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
	// With delegate now background-by-default (interactive), this is the COMMON delivery path, so the
	// premature-surrender counterweight must ride it too: a settled leg whose report carries a
	// [BLOCKED]/FLAG:UNKNOWN marker gets the persistence note appended (the sync tool_result hook can't
	// see a background run — its report arrives here as a fresh follow-up, not a delegate result).
	const completionNotifier = new IdleCoalescingNotifier<AsyncRun>({
		...idleDelivery,
		render: (runs) => renderCompletion(runs, fenceUntrusted, (t) => persistenceNudge.scan(t)),
	});
	// A child's blocking ask (decision/interview) — coalesced and idle-gated so it can't strand and
	// leave the child blocked until its 10-minute ask timeout (bus.ask default).
	const intercomNotifier = new IdleCoalescingNotifier<string>({
		...idleDelivery,
		render: (asks) => asks.join("\n\n"),
	});
	// Supervisor-armable alarms: when a timer expires it WAKES the session by routing the fire
	// through the same idle-delivery path (an idle delivery starts a fresh turn, so the supervisor
	// resumes on its own — no token-burning poll loop). Coalesced so several timers firing close
	// together arrive as one wake. The scheduler itself is the pure core kernel (src/core/timer.ts).
	const timerNotifier = new IdleCoalescingNotifier<TimerEntry>({
		...idleDelivery,
		render: (entries) => renderTimerFire(entries),
	});
	const timerScheduler = new TimerScheduler({
		now: () => Date.now(),
		setTimer: (fn, ms) => {
			const h = setTimeout(fn, ms);
			h.unref?.(); // never keep the host process alive just for a pending alarm
			return h;
		},
		clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		onFire: (entry) => timerNotifier.notify(entry),
	});
	const tracker = new AsyncRunTracker();
	// Turns the periodic peek from a poll into an exception signal: it surfaces a leg only when it
	// NEWLY crosses the stall window, so a healthy background run produces no wakeup at all.
	const peekWatcher = new PeekWatcher();
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

	// Peek watchdog (the timed supervisor wakeup, on by default — PI_PERSONA_PEEK_MS=0 opts out): while
	// async children run, a tick checks their progress but stays SILENT unless there is something to act
	// on, so a healthy background run never interrupts the supervisor. It wakes on two signals: a leg
	// that NEWLY looks stalled or an unread message (fast, PI_PERSONA_PEEK_MS granularity), and a routine
	// direction check-in (slow, PI_PERSONA_CHECKIN_MS) to catch a leg going off-track. Bounded: unref'd,
	// self-stops when no runs remain.
	let peekTimer: ReturnType<typeof setInterval> | undefined;
	// When the supervisor was last woken about a run (a stall alert, a message, or a routine check-in).
	// Gates the slow check-in cadence so it counts from the last time we actually surfaced something.
	let lastPeekAt = 0;
	function stopPeek(): void {
		if (peekTimer) {
			clearInterval(peekTimer);
			peekTimer = undefined;
		}
	}
	function startPeek(): void {
		// The two signals opt out independently: the fast stall/message wakeup follows PI_PERSONA_PEEK_MS,
		// the routine check-in follows PI_PERSONA_CHECKIN_MS. The carrier timer runs while EITHER is on and
		// ticks at the faster of the two (a disabled one is Infinity, so it never drives).
		const fastMs = config.peekEveryMs > 0 ? config.peekEveryMs : Number.POSITIVE_INFINITY;
		const checkMs = config.checkInEveryMs > 0 ? config.checkInEveryMs : Number.POSITIVE_INFINITY;
		const tickMs = Math.min(fastMs, checkMs);
		if (!Number.isFinite(tickMs) || peekTimer) return;
		lastPeekAt = Date.now(); // first routine check-in lands checkInEveryMs after the runs begin
		peekTimer = setInterval(() => {
			const runs = tracker.running();
			if (runs.length === 0) {
				stopPeek();
				return;
			}
			// Only peek a free, unqueued supervisor: an idle delivery triggers a clean turn, while a
			// busy one would pile up as a sticky follow-up. Skipping is safe — the next tick re-surfaces.
			if (lastCtx?.isIdle?.() !== true || lastCtx?.hasPendingMessages?.() === true) return;
			// The peek is NOT a poll. Two signals, two cadences: (1) the FAST wakeup (PI_PERSONA_PEEK_MS) —
			// a leg that NEWLY crossed the stall window, or an unread sub-agent message — the "is it dead or
			// wedged" check; (2) the SLOW routine check-in (PI_PERSONA_CHECKIN_MS) — a progress digest that
			// catches a leg going off-track (not stalled, just wrong) early. A healthy, quiet run between
			// check-ins produces no wakeup. Completions always arrive on their own (completionNotifier), and
			// the full status view stays on demand via `/peek`.
			const now = Date.now();
			const fast = config.peekEveryMs > 0;
			const stuck = fast ? peekWatcher.poll(runs, now, STALL_FLAG_MS) : [];
			// Drain only progress messages; blocking asks (expectsReply) are surfaced by the intercom
			// notifier and left for the `intercom inbox` tool — so peek never double-shows them.
			const unread = fast ? bus.takeWhere(SUPERVISOR, (e) => !e.expectsReply) : [];
			const dueCheckIn = config.checkInEveryMs > 0 && now - lastPeekAt >= config.checkInEveryMs;
			if (stuck.length === 0 && unread.length === 0 && !dueCheckIn) return; // healthy + quiet ⇒ stay silent
			const parts: string[] = [];
			if (stuck.length > 0) parts.push(buildPeekAlert(stuck, { now }));
			else if (dueCheckIn) parts.push(buildCheckIn(runs, { now, stallMs: STALL_FLAG_MS }));
			if (unread.length > 0) parts.push(`📨 from sub-agents:\n${fenceUntrusted(formatInbox(unread))}`);
			// Reset the check-in cadence only on a PROGRESS surfacing (a stall alert or a check-in), NOT on a
			// message-only wake — else a chatty child would postpone the routine off-track glance forever.
			if (stuck.length > 0 || dueCheckIn) lastPeekAt = now;
			try {
				pi.sendUserMessage(`[pi-persona] ${parts.join("\n\n")}`);
			} catch {
				/* ignore */
			}
		}, tickMs);
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
			deps.listAgents = () => agents.map((a) => a.name);
			if (signal) deps.signal = signal;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs, hardTimeoutMs: config.agentHardTimeoutMs, startupTimeoutMs: config.agentStartupTimeoutMs };
			// Feed progress here too (mirrors the plain-child branch): without it a worktree/mcp async leg
			// never advances its tracker snapshot, so lastAdvanceAt freezes at launch and the leg is falsely
			// flagged stalled while a genuine later wedge goes undetected.
			if (onProgress) deps.childOptions.onProgress = onProgress;
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
			// only for async runs — same guards as the inproc engine below (spec B7 / §4.9).
			const caps = controller.capabilities;
			if (caps) deps.canUseBus = caps.canUseBus;
			if (engOpts?.async) deps.allowBlocking = true;
			return makeEngine(deps);
		};

		// v0.4: run sub-agents in-process (createAgentSession) instead of spawning `pi -p`.
		let base: StrategyEngine;
		if (config.engine === "inproc" && lastCtx) {
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=inproc\n");
			const ideps: InProcessDeps = { resolveAgent, contracts, modelFor, childThinking, modelRegistry: lastCtx.modelRegistry, cwd: lastCtx.cwd, agentDir: userAgentDir() };
			ideps.listAgents = () => agents.map((a) => a.name);
			ideps.timeoutMs = RUN_LIMITS.timeoutMs; // idle watchdog — a hung session must settle, like the child engine's idle kill
			ideps.hardTimeoutMs = config.agentHardTimeoutMs; // hard lifetime ceiling — catches a busy loop the idle watchdog never would
			ideps.startupTimeoutMs = config.agentStartupTimeoutMs; // first-progress deadline — fast-fail a child that never started
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
			deps.listAgents = () => agents.map((a) => a.name);
			if (signal) deps.signal = signal;
			if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs, hardTimeoutMs: config.agentHardTimeoutMs, startupTimeoutMs: config.agentStartupTimeoutMs }; // idle watchdog + hard cap + startup deadline on every child
			if (onProgress) deps.childOptions.onProgress = onProgress;
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
			// only for async runs — same guards as the inproc engine above (spec B7 / §4.9).
			const caps = controller.capabilities;
			if (caps) deps.canUseBus = caps.canUseBus;
			if (engOpts?.async) deps.allowBlocking = true;
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
				// MCP-capable leg: the DEFAULT in-process engine never fires `session_start`, so
				// `pi-mcp-adapter` never initializes and the sub-agent's `mcp*`/direct tools come
				// back "MCP not initialized". Route it through the child engine (a real `pi -p`,
				// which DOES fire session_start → the adapter connects). Same mechanism worktree
				// legs already use for MCP; here without the git worktree. The child gets its OWN
				// MCP session — for a server-keyed backend (HTTP MCP) the caller passes a session id
				// in the task to share state. (No-op steering: the child engine is one-shot.)
				const wantsMcp = spec.mcp ?? resolveAgent(spec.agent)?.mcp;
				if (wantsMcp) return childEngineAt(root).run(spec, perProgress, perSignal, perSteer);
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
		join(personaDataDir(), "flows"),
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
		const journalDir = join(personaDataDir(), "flows");
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

	// The per-turn delegation brief (core/brief.ts): live roster + standing hand-off default,
	// appended to the TAIL of the system prompt each turn — where a decayed top-of-prompt
	// persona line has no force, and regenerated from the live registry so it cannot desync.
	// Capability-aware: a persona that denies `delegate` gets none, and the agent list is
	// filtered to the persona's allowed targets.
	function delegationBrief(ctx: ExtensionContext): string | undefined {
		const caps = controller.capabilities;
		if (caps && !canFanOut(caps)) return undefined;
		const targets = caps ? agents.filter((a) => canDelegateTo(caps, a.name)) : agents;
		const teamAgents: Record<string, string[]> = {};
		for (const [name, members] of Object.entries(teams)) teamAgents[name] = members.map((m) => rosterSpec(m).agent);
		return buildDelegationBrief({
			agents: targets.map((a) => (a.description ? { name: a.name, description: a.description } : { name: a.name })),
			teams: teamAgents,
			flows: listFlows(ctx.cwd),
			standing: controller.activePersona !== undefined,
			// Interactive sessions delegate in the background by default; headless (`pi -p`)
			// stays sync (the single turn must carry the result) — mirror that in the copy.
			asyncDefault: ctx.hasUI === true,
			// The FULL registry count (pre capability-filter): lets the brief tell "nothing installed
			// yet (seed)" from "this persona's allowlist filtered every target away (widen it)" when
			// `targets` came back empty — otherwise a restrictive persona gets the fresh-install lie.
			installedCount: agents.length,
		});
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
		lines.push("strategies:");
		for (const name of strategyNames()) {
			const schema = knownParams(name);
			const params = schema
				? Object.entries(schema)
						.map(([k, p]) => `${k} (${p.type}${p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : ""})`)
						.join(", ")
				: "(no params)";
			lines.push(`  - ${name}: ${params}`);
		}
		const coaching = controller.activePersona?.coaching ?? false;
		const peek = config.peekEveryMs > 0 ? `${config.peekEveryMs}ms` : "off";
		const checkIn = config.checkInEveryMs > 0 ? `${config.checkInEveryMs}ms` : "off";
		lines.push(`comm plane: coaching=${coaching ? "on (children get contact_supervisor)" : "off"}, peek-watchdog=${peek}, check-in=${checkIn}, bus-peers=${bus.participants().length}`);
		if (config.broker) {
			const status = brokerHost ? brokerHost.endpoint : brokerHostPromise ? "(starting…)" : "(not started — no child-engine build yet)";
			lines.push(`broker: on — endpoint ${status}, connected children: ${brokerHost?.connectedHandles().length ?? 0}`);
		}
		return lines.join("\n");
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		delegationNudge.reset(); // a fresh session starts with a clean by-hand run
		// Opt-in only (PI_PERSONA_SEED=on): auto-install the bundled defaults once. Default is off —
		// a fresh install shows no personas until `/persona seed` or `/persona restore`.
		if (config.seed && !existsSync(seedMarker())) {
			try {
				const r = runSeed(false);
				if (ctx.hasUI && r.copied.length > 0) {
					ctx.ui.notify(`pi-persona: seeded ${r.copied.length} default(s) to ${personaDataDir()} — edit them freely; /persona restore brings back the originals.`, "info");
				}
			} catch {
				/* a copy failure (read-only dir, …) must never block session start */
			}
		}
		reload(ctx.cwd);
		personaConfigs = readConfigStore();
		// Restore order: env pin > remembered-on-disk. Read-only — never writes here.
		const remembered = config.defaultPersona ?? readRememberedPersona();
		const target = remembered ? personas.find((p) => p.name === remembered) : undefined;
		if (target) await controller.activate(target);
		else host.setStatus(controller.activePersona?.label);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		disposed = true; // gate any late async-run onComplete from touching the next session's instance
		stopPeek(); // reload-hygiene: never leak the idle-peek timer across sessions
		peekWatcher.reset(); // …nor a stale "already surfaced this leg as stuck" set into the next session
		completionNotifier.cancel(); // …nor the coalesced-delivery flush timers
		intercomNotifier.cancel();
		timerScheduler.cancelAll(); // …nor any armed alarms (never wake the next session)
		timerNotifier.cancel();
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
		const brief = delegationBrief(ctx);
		if (brief) prompt = `${prompt}\n\n${brief}`;
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

	// Delegation nudge (config.nudge; delegating personas only): when the supervisor grinds a RUN of
	// hands-on commands by hand — a by-hand sweep with no hand-off — append a reminder to the
	// offending tool's result. It lands in RECENT context, on the very command that tripped it, where
	// a top-of-prompt persona directive has already lost its pull. Sub-agents run in their own
	// sessions, so this hook only ever sees the SUPERVISOR's own tools. A `delegate`/`council` result
	// resets the run.
	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		if (!config.nudge) return undefined;
		// Only a supervisor that CAN delegate is nudged to — a persona without the tool can't act on it.
		if (!controller.capabilities?.tools.has("delegate")) return undefined;
		const notes: string[] = [];
		// Grinding-by-hand reminder: a RUN of substantive hands-on commands on the supervisor's own
		// tools (delegate/council reset the run). `size` classifies substantive vs glue + fat dump.
		const size = event.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
		const sweepNote = delegationNudge.observe(event.toolName, size);
		if (sweepNote) notes.push(sweepNote);
		// Premature-surrender reminder: a delegated leg that came back BLOCKED/UNKNOWN (delegate/council
		// results only; because delegate/council reset the run the two never fire on one event).
		const text = event.content.reduce((s, c) => (c.type === "text" ? s + c.text : s), "");
		const surrender = persistenceNudge.observe(event.toolName, text);
		if (surrender) notes.push(surrender);
		if (notes.length === 0) return undefined;
		return { content: [...event.content, { type: "text", text: notes.join("\n\n") }] };
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
			Type.String({ description: "Short codename for this sub-agent, `<call-sign>-<purpose>`: a distinctive call-sign you invent + what the leg does — e.g. 'orion-recon', 'hermes-debug', 'atlas-fuzz'. Pick a DIFFERENT call-sign for EVERY leg so two of the same kind stay apart (orion-recon vs vega-recon). A UI label only — not a task description." }),
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
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give this sub-agent working MCP tools (runs it on the child engine so pi-mcp-adapter initializes; the default engine leaves MCP tools 'not initialized'). Pass any server session id in the task to share a server-keyed backend's state." }),
		),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		name: Type.Optional(Type.String({ description: "Short codename for the sub-agent, `<call-sign>-<purpose>`: a distinctive call-sign you invent + what the leg does — e.g. 'orion-recon', 'hermes-debug'. A UI label, not a task description (single mode)." })),
		skills: Type.Optional(SkillsSchema),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override (single mode)" })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run the single sub-agent in an isolated git worktree" }),
		),
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give the single sub-agent working MCP tools (runs it on the child engine; the default engine leaves MCP tools 'not initialized')" }),
		),
		tasks: Type.Optional(
			Type.Array(DelegateTaskItem, { description: "Independent tasks to run in parallel — give each a disjoint scope" }),
		),
		concurrency: Type.Optional(Type.Number({ description: "Max children to run at once (default 4)" })),
		async: Type.Optional(
			Type.Boolean({
				description:
					"Explicitly run in the background (already the DEFAULT in interactive sessions) — returns run ids at once; each result comes back to you automatically as a follow-up. Set false to force blocking.",
			}),
		),
		sync: Type.Optional(
			Type.Boolean({
				description:
					"Block this turn until the sub-agent(s) finish and return their results inline — only when you need them before your very next step. (Headless sessions already default to sync.)",
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
		startPeek(); // arm the timed supervisor wakeup while this run is in flight (no-op if PI_PERSONA_PEEK_MS=0)
		return id;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to sub-agents — your default move whenever a task has independent, heavy, or parallel parts.",
			'Minimum call: { agent: "operator", task: "<self-contained brief: objective, scope, success signal>" } — everything else is optional.',
			"Fan out with tasks: [{ agent, task }, ...] (disjoint scopes), then synthesize the returns yourself.",
			"In interactive sessions it runs in the BACKGROUND by default: you get run ids at once, stay free,",
			"and each result returns to you automatically as a follow-up — do NOT poll (`intercom wait` only when",
			"you need a result before your very next step; `sync: true` to block instead; headless runs default to sync).",
			"No fitting agent? Shape one on the fly: `operator` + `role` (extra system prompt) + `skills`.",
			"A `model` may be a loose name ('sonnet') — it resolves to YOUR provider's id; ambiguous names return",
			"candidates (or call `models`). Advanced knobs: name, tools, isolation: \"worktree\", mcp, concurrency.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const modelErr = resolveDelegateModels(params, ctx);
			if (modelErr) return { content: [{ type: "text", text: modelErr }], details: {}, isError: true };
			// Pre-spawn agent validation (mirrors the model path): a wrong name returns the
			// installed list instead of spawning into a bare engine failure, and a typo never
			// counts toward the ledger's 2-strike veto.
			const agentErr = unknownAgentError(
				params.tasks && params.tasks.length > 0 ? params.tasks.map((t) => t.agent) : params.agent ? [params.agent] : [],
				agents.map((a) => a.name),
			);
			if (agentErr) return { content: [{ type: "text", text: agentErr }], details: {}, isError: true };
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
			// Background by default in interactive sessions: the supervisor stays free and results
			// return as follow-ups (the idle-gated push path). Headless (`pi -p`) defaults to sync —
			// the single turn must carry the result, and nothing drains a follow-up after the
			// process exits. An explicit `async` always wins; `sync: true` opts one call out.
			const wantsAsync = wantsAsyncRun(params, ctx.hasUI === true);
			// Async (single OR parallel): run in the background so YOU stay free to keep
			// working / answer the user — results arrive later as follow-ups; /peek to watch.
			if (wantsAsync && params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks.slice(0, RUN_LIMITS.maxChildren);
				const dropped = params.tasks.length - tasks.length;
				const ids = tasks.map((t, i) => {
					const spec: AgentRunSpec = { agent: t.agent, task: t.task };
					if (t.model) spec.model = t.model;
					if (t.tools && t.tools.length > 0) spec.tools = t.tools;
					if (t.skills && t.skills.length > 0) spec.skills = t.skills;
					if (t.role?.trim()) spec.role = t.role.trim();
					if (t.isolation === "worktree") spec.isolation = "worktree";
					if (t.mcp === true) spec.mcp = true;
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
			if (wantsAsync && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const runSpec: AgentRunSpec = { agent, task };
				if (params.model) runSpec.model = params.model;
				if (params.tools && params.tools.length > 0) runSpec.tools = params.tools;
				if (params.skills && params.skills.length > 0) runSpec.skills = params.skills;
				if (params.role?.trim()) runSpec.role = params.role.trim();
				if (params.isolation === "worktree") runSpec.isolation = "worktree";
				if (params.mcp === true) runSpec.mcp = true;
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
			// renderCall only fires in an interactive UI, where delegate runs in the BACKGROUND by
			// default — pass hasUI:true to the same wantsAsyncRun the execute path uses, so the common
			// (defaulted) background run still shows the tag; `sync: true` drops it.
			const asyncTag = wantsAsyncRun(args, true) ? theme.fg("warning", " async") : "";
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
		timeoutMs: Type.Optional(Type.Number({ description: "wait: max ms to hold your turn (default 600000, cap 600000) — on timeout you get what settled + what's still running" })),
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
				// No `to` → running legs PLUS any settled-but-not-yet-delivered ones (the settle→deliver
				// gap), so a peek right after a leg finishes shows its result instead of "No async runs".
				const runs = params.to
					? [tracker.peek(params.to)].filter((r): r is AsyncRun => !!r)
					: dedupeRunsById([...tracker.running(), ...completionNotifier.peekPending()]);
				return { content: [{ type: "text", text: buildPeekDigest(runs, { now: Date.now(), stallMs: STALL_FLAG_MS }) }], details: { action: "peek", ok: true }, isError: false };
			}
			if (params.action === "wait") {
				// No `to` → wait on running legs AND collect settled legs still queued for follow-up
				// delivery, so a wait in the settle→deliver gap returns their results (not "nothing").
				const ids = params.to
					? [params.to]
					: dedupeRunsById([...tracker.running(), ...completionNotifier.peekPending()]).map((r) => r.id);
				if (ids.length === 0) {
					return { content: [{ type: "text", text: "No async runs to wait for." }], details: { action: "wait", ok: true }, isError: false };
				}
				// Bounded join: never longer than a child's ask timeout (bus `ask` default 600s),
				// so a coaching child blocking on OUR reply can't deadlock us past its own timeout.
				// Default matches that ceiling — heavy sub-agents (30+ turns) routinely outlast a
				// short window, and a premature "still running" forces a needless re-wait.
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 600_000, 1_000), 600_000);
				const runs = await tracker.waitFor(ids, timeoutMs, _signal);
				const settled = runs.filter((r) => r.status !== "running");
				const still = runs.filter((r) => r.status === "running");
				// These results are delivered HERE — drop them from the pending follow-up
				// notifier so they aren't reported a second time. Render through the SAME
				// renderCompletion the passive path uses, so a leg that came back BLOCKED still
				// carries the premature-surrender note when it is collected via `wait`.
				const settledIds = new Set(settled.map((r) => r.id));
				completionNotifier.discard((run) => settledIds.has(run.id));
				const report = settled.length > 0 ? renderCompletion(settled, fenceUntrusted, (t) => persistenceNudge.scan(t)) : "";
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
				// HARD stop: aborts the run's signal → the engine calls the sub-agent's agent.abort()
				// (child.ts escalates SIGTERM → force tree-kill, so this DOES kill a child-engine process).
				const stopped = stopAgent(`async:${params.to}`);
				if (stopped) {
					return { content: [{ type: "text", text: `Aborting ${params.to} — the sub-agent is being hard-stopped; its run will settle as aborted shortly.` }], details: { action: "stop", ok: true }, isError: false };
				}
				// No live stop handle. The handle registry and the tracker can DISAGREE: a prior abort
				// consumes the handle (or a queued/never-steerable run never registered one) while the
				// tracker still shows the run running — a ghost that keeps surfacing in every check-in and
				// burns the budget. Consult the tracker (the source of truth for check-ins) and force-clear
				// it, instead of falsely reporting "already finished".
				if (tracker.forceSettle(params.to, "force-stopped by supervisor: no live stop handle (a prior abort was likely already in flight, or the run could not be signalled)")) {
					return {
						content: [{ type: "text", text: `Force-cleared ${params.to} — it had no live stop handle (a prior abort was likely already in flight, or it couldn't be signalled), but the tracker still showed it running. It will no longer be tracked as running; if the underlying process lingers it exits on its own.` }],
						details: { action: "stop", ok: true },
						isError: false,
					};
				}
				return {
					content: [{ type: "text", text: `Cannot stop "${params.to}" — no such running run (it already finished).` }],
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

	// ── timer tool (arm a wall-clock alarm that WAKES the session when it fires) ───
	// Solves the "wait N minutes for a release / rate-limit window" problem WITHOUT a poll loop:
	// arm an alarm, end your turn, and when it expires the extension injects a follow-up that
	// resumes you (idle-gated so it starts a fresh turn instead of stranding). Arm as many as you
	// want; cancel/list them. In-memory per session (a reload/new session clears armed alarms).
	const TimerToolParams = Type.Object({
		action: Type.Union([Type.Literal("arm"), Type.Literal("cancel"), Type.Literal("list")], {
			description: "arm = schedule a wakeup · cancel = drop one by id · list = show armed alarms",
		}),
		message: Type.Optional(
			Type.String({ description: "arm: the follow-up injected into the session when the timer fires (what to do on wake, e.g. 'spawn Paperwork and start nmap'). Required for arm." }),
		),
		delaySeconds: Type.Optional(Type.Number({ description: "arm: fire this many seconds from now. Give this OR atIso, not both." })),
		atIso: Type.Optional(Type.String({ description: "arm: fire at this absolute time, ISO-8601 (e.g. '2026-07-11T19:00:00Z'). Give this OR delaySeconds, not both." })),
		label: Type.Optional(Type.String({ description: "arm: a short human label for the alarm (e.g. 'Paperwork release')." })),
		id: Type.Optional(Type.String({ description: "cancel: the timer id to cancel (e.g. 'timer-1')." })),
	});
	pi.registerTool({
		name: "timer",
		label: "Timer",
		description: [
			"Arm a wall-clock ALARM that wakes you when it fires — the token-cheap way to wait for a",
			"fixed moment (a machine release, a rate-limit reset, a scheduled re-check) instead of a",
			"poll loop. `arm` with { message, delaySeconds } or { message, atIso }; end your turn; when",
			"it expires a follow-up carrying your message is injected and you resume. `cancel` by id,",
			"`list` the armed ones. Arm as many as you need. Alarms are per-session (cleared on reload).",
		].join(" "),
		parameters: TimerToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (params.action === "list") {
				const timers = timerScheduler.list();
				const text =
					timers.length === 0
						? "(no armed timers)"
						: `Armed timers:\n${timers
								.map((t) => `• ${t.id} (${t.label}) — fires in ${formatRemaining(t.remainingMs)} [${new Date(t.fireAtEpochMs).toISOString()}]: ${t.message}`)
								.join("\n")}`;
				return { content: [{ type: "text", text }], details: { action: "list", count: timers.length, ok: true }, isError: false };
			}
			if (params.action === "cancel") {
				if (!params.id) {
					return { content: [{ type: "text", text: "timer cancel needs { id } (see `list`)." }], details: { action: "cancel", ok: false }, isError: true };
				}
				const cancelled = timerScheduler.cancel(params.id);
				return cancelled
					? { content: [{ type: "text", text: `Cancelled ${params.id}.` }], details: { action: "cancel", ok: true }, isError: false }
					: { content: [{ type: "text", text: `No armed timer with id "${params.id}" (it may have already fired or been cancelled).` }], details: { action: "cancel", ok: false }, isError: true };
			}
			// action === "arm"
			const arm: { message: string; label?: string; delayMs?: number; atEpochMs?: number } = { message: params.message ?? "" };
			if (params.label !== undefined) arm.label = params.label;
			if (params.atIso !== undefined) {
				const at = Date.parse(params.atIso);
				if (!Number.isFinite(at)) {
					return { content: [{ type: "text", text: `timer atIso "${params.atIso}" is not a valid ISO-8601 time.` }], details: { action: "arm", ok: false }, isError: true };
				}
				arm.atEpochMs = at;
			}
			if (params.delaySeconds !== undefined) arm.delayMs = Math.round(params.delaySeconds * 1000);
			const r = timerScheduler.arm(arm);
			if (!r.ok || !r.entry) {
				return { content: [{ type: "text", text: r.error ?? "timer arm failed." }], details: { action: "arm", ok: false }, isError: true };
			}
			const e = r.entry;
			const text = `Armed ${e.id} (${e.label}) — fires in ${formatRemaining(e.fireAtEpochMs - Date.now())} [${new Date(e.fireAtEpochMs).toISOString()}]. On fire I'll be woken with: "${e.message}". You can end this turn now.`;
			return { content: [{ type: "text", text }], details: { action: "arm", id: e.id, fireAtEpochMs: e.fireAtEpochMs, ok: true }, isError: false };
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
			"execution surfaces a new decision. Patterns: adversarial vote (magi, council-rounds), best-of-N",
			"with an impartial arbiter (judge, compete), batch map, merged synthesis (synthesize).",
			`Strategies: ${strategyNames()
				.map((n) => {
					const p = knownParams(n);
					const keys = p ? Object.keys(p) : [];
					return keys.length > 0 ? `${n}(${keys.join(", ")})` : n;
				})
				.join(" · ")}.`,
			'Pass `params` to vary the persona\'s default council for one call — e.g. { "reflect": false }.',
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
				// Lenient by design (I2: strategies are trusted project code) — an unknown param key
				// only warns, it never blocks or alters the run. A correct call is untouched.
				let paramNote = "";
				const schema = knownParams(strategy);
				if (schema) {
					const unknown = Object.keys(mergedParams).filter((k) => !(k in schema));
					if (unknown.length > 0) {
						const note = `council: ignoring unknown param(s) [${unknown.join(", ")}] for "${strategy}" — known: ${Object.keys(schema).join(", ") || "(none)"}`;
						if (process.env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] ${note}\n`);
						ctx.ui.notify(note, "warning");
						paramNote = `\n\n(${note})`;
					}
				}
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: mergedParams };
				const result = await runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				const s = (result?.structured ?? {}) as { headline?: string; status?: string; tally?: Record<string, number> };
				const ruling = result?.output ?? "(the council returned no ruling)";
				return {
					// The ruling is sub-agent (council member) text — fence it like every other
					// path that hands sub-agent output to the supervisor.
					content: [{ type: "text", text: `${fenceUntrusted(ruling)}${paramNote}${drainBusBlock()}` }],
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
		name: Type.String({ description: "The flow to run — a *.flow.json by name (installed flows are listed in your sub-agents brief; the user can run /flow to list them)" }),
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
				const installed = listFlows(ctx.cwd);
				const hint = installed.length > 0 ? `Installed flows: ${installed.join(", ")}.` : "No flows are installed — add a *.flow.json under .pi/flows/.";
				return { content: [{ type: "text", text: `no flow named "${params.name}". ${hint}` }], details: {}, isError: true };
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
				ctx.ui.notify(run ? buildPeekDigest([run], { now: Date.now(), stallMs: STALL_FLAG_MS }) : `peek: no run "${id}"`, run ? "info" : "warning");
			} else {
				ctx.ui.notify(buildPeekDigest(tracker.list(), { now: Date.now(), stallMs: STALL_FLAG_MS }), "info");
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

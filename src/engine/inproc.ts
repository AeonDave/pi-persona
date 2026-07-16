/**
 * InProcessEngine (v0.4) — a second `StrategyEngine` backend that runs a sub-agent
 * IN THIS PROCESS via Pi's `createAgentSession`, instead of spawning `pi --mode
 * json -p`. Same seam (`run` → `AgentResult`), same stream parser (`stream.ts`
 * folds the session's `AgentEvent`s), same contract validation. This is what
 * unlocks live **steering** (`agent.steer`) and drops the per-child spawn.
 *
 * Fork-bomb guard: the sub-session must NOT re-activate pi-persona (which would give
 * the child the `delegate`/`council` tools + turn interception → recursion). We set
 * `PI_PERSONA_DISABLE` for the duration of session creation (the same flag the child
 * path passes via env) and exclude the orchestration tools defensively.
 *
 * The session factory is injectable (`deps.createSession`) — exactly like the child
 * engine's `resolveInvocation` — so the whole path is deterministically testable with
 * a fake session, without a live model. The default builds a real `createAgentSession`.
 *
 * This is the DEFAULT backend; `PI_PERSONA_ENGINE=child` opts back to the spawn-based
 * `ChildProcessEngine`. It drops in behind the seam without touching strategies/UI.
 */

import { createAgentSession, DefaultResourceLoader, type ModelRegistry, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/agent.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import { makeContactSupervisorTool } from "../bus/contact.ts";
import { makeContactPeerTool } from "../bus/peers.ts";
import { type ContractDef, contractInstructions, parseAndValidate, pinContract, type PinnedContract } from "../core/contract.ts";
import { attributeInbound } from "../core/fence.ts";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
import { roleHint } from "../orchestration/roster.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { combineSignals } from "./signals.ts";
import { applyEvent, createStreamState, emptyUsage, type ProgressSnapshot, snapshot } from "./stream.ts";

/** The minimal slice of Pi's AgentSession the engine drives — also the test seam. */
export interface InProcSession {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(input: string): Promise<void>;
	agent: { abort(): void; waitForIdle(): Promise<void>; steer(message: unknown): void };
	dispose(): void;
}

export interface CreateSessionOptions {
	model: unknown;
	modelRegistry: ModelRegistry;
	cwd: string;
	/** Pi's global agent dir (~/.pi/agent) for the sub-agent's resource loader. */
	agentDir: string;
	tools?: string[];
	thinkingLevel?: ThinkingLevel;
	/** The agent's persona (its .md) — appended to the base system prompt. */
	systemPrompt?: string;
	/** Extra tools injected into the child session (e.g. `contact_supervisor`). */
	customTools?: ToolDefinition[];
}

export type CreateInProcSession = (opts: CreateSessionOptions) => Promise<InProcSession>;

export interface InProcessDeps {
	resolveAgent: (name: string) => AgentConfig | undefined;
	contracts?: (name: string) => ContractDef | undefined;
	/** The host session's registry — shared so the sub-agent reuses the loader's auth. */
	modelRegistry: ModelRegistry;
	cwd: string;
	/** Pi's global agent dir (~/.pi/agent); defaults to cwd if omitted (tests). */
	agentDir?: string;
	/** Per-agent model override (e.g. a persona's configured ensemble models). */
	modelFor?: (agent: string) => string | undefined;
	/** The session/loader model — the last-resort fallback when an agent declares none
	 *  (the child engine gets this for free from `pi -p`'s default; inproc must pass it). */
	defaultModel?: string;
	/** Explicit thinking level for the sub-agent (the supervisor's, or a default). */
	childThinking?: string;
	/** Whole-run abort signal (combined with each call's own signal). */
	signal?: AbortSignal;
	/** Construction-time progress sink (used when `run` is called without its own). */
	onProgress?: (snap: ProgressSnapshot) => void;
	/** Known agent names, for self-correcting unknown-agent errors (mirrors the model path). */
	listAgents?: () => string[];
	/** Session factory — defaults to a real `createAgentSession`; injected in tests. */
	createSession?: CreateInProcSession;
	/** The semantic comm plane: when present + `coaching`, each child gets a
	 *  `contact_supervisor` tool bound to this bus so it can reach the supervisor mid-run. */
	bus?: InProcessBus;
	/** The supervisor's bus handle (default `"supervisor"`). */
	supervisorHandle?: string;
	/** Inject `contact_supervisor` into children (persona `coaching: on`). Default off. */
	coaching?: boolean;
	/** Allow a child's `decision`/`interview` to BLOCK for a reply — async runs only.
	 *  Sync runs hold the supervisor's turn, so blocking would deadlock: keep this false. */
	allowBlocking?: boolean;
	/** Persona-level bus capability (`EffectiveCapabilities.canUseBus`). Default true.
	 *  When false, a spec's `peers` request is ignored (no `contact_peer` tool is bound). */
	canUseBus?: boolean;
	/** IDLE window (ms): a session that emits NO events for this long is treated as hung
	 *  and aborted (mirrors the child engine's idle kill). 0/absent = no watchdog.
	 *  Ignored when `coaching` + `allowBlocking` — a child legitimately blocked on a
	 *  supervisor reply (bus ask, 10-minute timeout) emits nothing and must not be killed. */
	timeoutMs?: number;
	/** HARD wall-clock cap (ms): a definite lifetime ceiling, armed ONCE and never reset by
	 *  events — so it catches a busy-but-non-converging child (a loop that keeps emitting) that
	 *  the idle watchdog, which any event re-arms, never would. 0/absent = no cap. Also skipped
	 *  for a `coaching` + `allowBlocking` child (it may legitimately block a long time on a reply). */
	hardTimeoutMs?: number;
	/** STARTUP deadline (ms): a session that never makes PROGRESS (no completed turn, no tokens,
	 *  no streamed output) within this window is aborted as a stalled start — the "never started"
	 *  case the idle window is too generous for. The FIRST progress cancels it permanently, so a
	 *  slow-but-streaming turn is never touched. 0/absent = no startup deadline. Skipped for a
	 *  `coaching` + `allowBlocking` child (it may legitimately block before emitting anything). */
	startupTimeoutMs?: number;
}

// The sub-agent must never re-enter the supervisor's orchestration surface.
const ORCHESTRATION_TOOLS = ["delegate", "council", "orchestrate", "flow"];

/** Default factory: a real in-process Pi session. The resource loader appends the
 *  agent's persona to the base system prompt (the in-process `--append-system-prompt`).
 *  Extensions DO load (so auth providers like pi-claude work) — the fork-bomb guard is
 *  that pi-persona self-disables under `PI_PERSONA_DISABLE` (set around creation), with
 *  the orchestration tools excluded as a second line of defense. */
const createPiSession: CreateInProcSession = async (opts) => {
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		...(opts.systemPrompt ? { appendSystemPrompt: [opts.systemPrompt] } : {}),
	});
	await loader.reload();
	// If a `tools` allowlist is set, the injected custom tools must be allowed too,
	// otherwise the allowlist would filter them out of the child's active set.
	const customNames = (opts.customTools ?? []).map((t) => t.name);
	const tools = opts.tools && opts.tools.length > 0 ? [...opts.tools, ...customNames] : undefined;
	// Forward-compat with the model-runtime migration (pi > 0.80.7). pi ≤ 0.80.7 reads
	// `CreateAgentSessionOptions.modelRegistry` to share the host's auth/model registry with the
	// sub-session; the migration DROPS that create option in favour of an async `modelRuntime`, where
	// the sub-session self-builds a ModelRuntime from `agentDir/{auth,models}.json`. Two moves keep
	// this correct on BOTH SDKs: (1) pass `agentDir` (a valid option on both) so the self-built runtime
	// resolves the SAME on-disk credentials the host uses — disk-configured delegation stays correct
	// after the migration; (2) attach the legacy `modelRegistry` OFF the object literal, so the newer
	// SDK types (which no longer declare it) don't turn it into an excess-property compile error. On
	// older pi the key is still read (full host-registry sharing); on newer pi it is simply ignored
	// (only host-only in-memory providers — not persisted to auth.json — would not be inherited).
	const sessionOptions: NonNullable<Parameters<typeof createAgentSession>[0]> = {
		model: opts.model as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>,
		sessionManager: SessionManager.inMemory(opts.cwd),
		resourceLoader: loader,
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		excludeTools: ORCHESTRATION_TOOLS,
		...(tools ? { tools } : {}),
		...(opts.customTools && opts.customTools.length > 0 ? { customTools: opts.customTools } : {}),
		// `opts.thinkingLevel` is our local ThinkingLevel superset — cast to pi's field type at the
		// boundary (same rationale as PersonaHost.setThinkingLevel: a `max`-style level only reaches
		// here on a pi that supports it, and pi clamps an unknown level regardless).
		...(opts.thinkingLevel
			? { thinkingLevel: opts.thinkingLevel as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]> }
			: {}),
	};
	(sessionOptions as { modelRegistry?: unknown }).modelRegistry = opts.modelRegistry;
	const { session } = await createAgentSession(sessionOptions);
	return {
		subscribe: (l) => session.subscribe(l as Parameters<typeof session.subscribe>[0]),
		prompt: async (input) => {
			await session.prompt(input);
		},
		agent: {
			abort: () => session.agent.abort(),
			waitForIdle: () => session.agent.waitForIdle(),
			steer: (message) => session.agent.steer(message as Parameters<typeof session.agent.steer>[0]),
		},
		dispose: () => session.dispose(),
	};
};

/** Resolve a model ref (`provider/id`, or a bare id) to a registry Model. */
function resolveModel(reg: ModelRegistry, ref: string | undefined): unknown {
	if (!ref) return undefined;
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const m = reg.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (m) return m;
	}
	return reg.getAll().find((m) => m.id === ref);
}

// Module-level (NOT per-engine) so concurrent engine instances and parallel sub-agent builds
// share them. `buildEngine` makes a fresh engine per delegate/council/flow-phase/async-launch,
// so a per-closure counter would restart at 0 and collide bus handles across concurrent runs.
let globalChildSeq = 0;
// Ref-counted fork-bomb guard: PI_PERSONA_DISABLE stays "1" while ANY sub-session is being
// built (a parallel strategy builds several at once), restored only when the LAST one finishes.
// A per-call save/restore around the async `createSession` races: it can clear the guard
// mid-build (fork-bomb window) or leave it stuck. Increment/decrement never cross the await.
//
// PI_PERSONA_LEG rides alongside it as a DEDICATED "this session is a delegated worker leg" marker.
// PI_PERSONA_DISABLE alone is ambiguous — a user can set it as a kill switch — so a companion
// extension (e.g. pi-persona-mind) cannot tell a real leg from a disabled supervisor by DISABLE
// alone. LEG is set ONLY here (and in the child engine), never by a user, so it names a leg exactly.
let disableDepth = 0;
let savedDisable: string | undefined;
let savedLeg: string | undefined;
function pushDisableGuard(): void {
	if (disableDepth === 0) {
		savedDisable = process.env.PI_PERSONA_DISABLE;
		savedLeg = process.env.PI_PERSONA_LEG;
	}
	disableDepth += 1;
	process.env.PI_PERSONA_DISABLE = "1";
	process.env.PI_PERSONA_LEG = "1";
}
function popDisableGuard(): void {
	disableDepth -= 1;
	if (disableDepth === 0) {
		if (savedDisable === undefined) delete process.env.PI_PERSONA_DISABLE;
		else process.env.PI_PERSONA_DISABLE = savedDisable;
		if (savedLeg === undefined) delete process.env.PI_PERSONA_LEG;
		else process.env.PI_PERSONA_LEG = savedLeg;
	}
}

export function makeInProcessEngine(deps: InProcessDeps): StrategyEngine {
	const createSession = deps.createSession ?? createPiSession;
	const supervisorHandle = deps.supervisorHandle ?? "supervisor";
	// Per-run contract pinning (I3), mirroring the child adapter.
	const pinned = new Map<string, PinnedContract>();
	const pinnedDef = (name: string): ContractDef | undefined => {
		const cached = pinned.get(name);
		if (cached) return cached.def;
		const def = deps.contracts?.(name);
		if (!def) return undefined;
		const fresh = pinContract(def);
		pinned.set(name, fresh);
		return fresh.def;
	};

	// Peer registry — PER ENGINE INSTANCE. buildEngine makes a fresh engine per
	// delegate/council/flow-phase/async-launch, so this map naturally scopes `contact_peer`
	// to the members of ONE run: concurrent runs on the same bus never see each other.
	const peerLabels = new Map<string, string>();

	return {
		async run(spec: AgentRunSpec, onProgress?, callSignal?, onSteerable?): Promise<AgentResult> {
			const cfg = deps.resolveAgent(spec.agent);
			if (!cfg) {
				const known = deps.listAgents?.() ?? [];
				const hint = known.length > 0 ? ` — installed agents: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}` : "";
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `[${spec.agent}] unknown agent (not found in registry)${hint}`, failureKind: "unknown-agent" };
			}

			const ref = spec.model ?? deps.modelFor?.(spec.agent) ?? cfg.model ?? deps.defaultModel;
			const model = resolveModel(deps.modelRegistry, ref);
			if (!model) {
				const src = spec.model ? "spec" : deps.modelFor?.(spec.agent) ? "agent picker" : cfg.model ? "agent config" : "default";
				// Make the failure self-correcting: name a few real registry refs (nearest
				// matches first) so the supervisor's retry can pick a valid model at once.
				const all = deps.modelRegistry.getAll().map((m) => `${m.provider}/${m.id}`);
				const frag = (ref ?? "").split("/").pop()?.split(":")[0]?.toLowerCase() ?? "";
				const near = frag ? all.filter((r) => r.toLowerCase().includes(frag)) : [];
				const hint = (near.length > 0 ? near : all).slice(0, 5);
				return {
					agent: spec.agent,
					output: "",
					usage: emptyUsage(),
					ok: false,
					error: `[${spec.agent} · ${ref ?? "(no model)"}] model not found in registry (from ${src})${hint.length > 0 ? ` — try e.g.: ${hint.join(", ")}` : ""}`,
						failureKind: "unknown-model",
				};
			}
			// The canonical provider/id this run resolved to — surfaced on every result (for the
			// UI/cost) and, on a provider failure, used as the seed of the fallback chain.
			const rm = model as { provider?: string; id?: string };
			const resolvedRef = rm.provider && rm.id ? `${rm.provider}/${rm.id}` : ref;
			const thinkingLevel = isThinkingLevel(deps.childThinking) ? deps.childThinking : undefined;
			const tools = spec.tools ?? cfg.tools;

			// Diagnostic tag: which agent + which model ref + whether it was dynamically
			// specialised (skills / model / tools override on the spec). Users need this
			// to tell "the delegate typo'd the model" from "the provider rejected it".
			const overrides: string[] = [];
			if (spec.model) overrides.push("model");
			if (spec.skills && spec.skills.length > 0) overrides.push("skills");
			if (spec.tools && spec.tools.length > 0) overrides.push("tools");
			const dyn = overrides.length > 0 ? ` +dyn(${overrides.join(",")})` : "";
			const tag = `[${spec.agent} · ${ref ?? "(no model)"}${dyn}]`;

			const state = createStreamState();
			const signal = combineSignals(deps.signal, callSignal);

			// Already cancelled (e.g. a queued async run stopped before its slot came up):
			// don't build a session or burn a model call — settle as aborted right away.
			if (signal?.aborted) {
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `${tag} agent aborted`, ...(resolvedRef ? { modelUsed: resolvedRef } : {}), failureKind: "abort" };
			}

			const sessionOpts: CreateSessionOptions = {
				model,
				modelRegistry: deps.modelRegistry,
				cwd: deps.cwd,
				agentDir: deps.agentDir ?? deps.cwd,
			};
			if (tools && tools.length > 0) sessionOpts.tools = tools;
			if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
			// The agent's own persona + any on-the-fly `role` specialisation from the spec.
			const personaPrompt = [cfg.systemPrompt?.trim(), spec.role?.trim()].filter(Boolean).join("\n\n");
			if (personaPrompt) sessionOpts.systemPrompt = personaPrompt;

			// Comm plane: give this child a `contact_supervisor` tool bound to a unique handle
			// (persona coaching, §4.9), and/or a `contact_peer` tool when the STRATEGY opted the
			// run into sibling messaging (`spec.peers`, gated by the persona's `canUseBus`).
			let childHandle: string | undefined;
			const wantsPeers = spec.peers === true && (deps.canUseBus ?? true) && deps.bus !== undefined;
			if (spec.peers === true && !wantsPeers && process.env.PI_PERSONA_DEBUG) {
				process.stderr.write(`[pi-persona] peers requested for ${spec.agent} but bus/capability unavailable — running without contact_peer\n`);
			}
			if (deps.bus && (deps.coaching || wantsPeers)) {
				globalChildSeq += 1;
				childHandle = `${spec.agent}#${globalChildSeq}`;
				deps.bus.register(supervisorHandle);
				deps.bus.register(childHandle);
				const customTools: ToolDefinition[] = [];
				if (deps.coaching) {
					customTools.push(
						makeContactSupervisorTool(deps.bus, childHandle, supervisorHandle, { allowBlocking: deps.allowBlocking ?? false }),
					);
				}
				if (wantsPeers) {
					peerLabels.set(childHandle, spec.role ? `${childHandle} (${roleHint(spec.role)})` : childHandle);
					const self = childHandle;
					customTools.push(
						makeContactPeerTool(deps.bus, self, {
							listPeers: () => [...peerLabels.entries()].filter(([h]) => h !== self).map(([h, l]) => ({ handle: h, label: l })),
						}),
					);
				}
				sessionOpts.customTools = customTools;
			}

			// Fork-bomb guard (ref-counted, concurrency-safe): disable pi-persona inside the
			// sub-session while it's built; the guard survives concurrent parallel builds.
			pushDisableGuard();
			let session: InProcSession;
			try {
				session = await createSession(sessionOpts);
			} finally {
				popDisableGuard();
			}

			// Idle watchdog (mirrors the child engine's idle kill): a session that emits no
			// events for `timeoutMs` is hung (e.g. a stuck provider stream) — without this the
			// DEFAULT engine would await `waitForIdle()` forever and the run would never settle.
			// Any event re-arms the clock, so a long-but-active agent is never killed. Disabled
			// for coaching children that may block on a supervisor reply (see InProcessDeps).
			const blockingChild = deps.coaching && (deps.allowBlocking ?? false);
			const watchdogMs = blockingChild ? 0 : (deps.timeoutMs ?? 0);
			let timedOut = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const disarmIdle = (): void => {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = undefined;
				}
			};
			const armIdle = (): void => {
				if (watchdogMs <= 0) return;
				disarmIdle();
				idleTimer = setTimeout(() => {
					timedOut = true;
					session.agent.abort();
				}, watchdogMs);
				idleTimer.unref?.();
			};

			// Hard wall-clock cap: armed ONCE, never reset by events — a definite lifetime ceiling
			// that settles a busy-but-non-converging child (a loop that keeps emitting) the idle
			// watchdog above never catches. Unlike the idle watchdog it is NOT exempted for a
			// blocking child: it caps total lifetime, not silence, so a child that never returns
			// (even one stuck waiting on a reply that never comes) still settles by a known deadline.
			const hardMs = deps.hardTimeoutMs ?? 0;
			let hardTimedOut = false;
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			const armHard = (): void => {
				if (hardMs <= 0) return;
				hardTimer = setTimeout(() => {
					hardTimedOut = true;
					session.agent.abort();
				}, hardMs);
				hardTimer.unref?.();
			};
			const disarmHard = (): void => {
				if (hardTimer) {
					clearTimeout(hardTimer);
					hardTimer = undefined;
				}
			};

			// Startup deadline (mirrors the child engine): a session that never makes PROGRESS
			// (no completed turn / tokens / streamed output) within `startupMs` is aborted as a
			// stalled start — the fast-fail for a child that never began, which the generous idle
			// window is too slow for. The first real progress cancels it; bare lifecycle events do
			// not. Skipped for a blocking coaching child (it may legitimately wait before emitting).
			const startupMs = blockingChild ? 0 : (deps.startupTimeoutMs ?? 0);
			let startupTimedOut = false;
			let startupProgressed = false;
			let startupTimer: ReturnType<typeof setTimeout> | undefined;
			const disarmStartup = (): void => {
				if (startupTimer) {
					clearTimeout(startupTimer);
					startupTimer = undefined;
				}
			};
			const armStartup = (): void => {
				if (startupMs <= 0) return;
				startupTimer = setTimeout(() => {
					if (startupProgressed) return;
					startupTimedOut = true;
					session.agent.abort();
				}, startupMs);
				startupTimer.unref?.();
			};
			const noteStartupProgress = (): void => {
				if (startupProgressed) return;
				const s = snapshot(state);
				if (s.turns > 0 || s.tokens > 0 || s.output.length > 0) {
					startupProgressed = true;
					disarmStartup();
				}
			};

			const unsub = session.subscribe((ev) => {
				armIdle(); // any event = activity → reset the idle clock
				applyEvent(state, ev);
				noteStartupProgress(); // first real progress cancels the startup deadline
				const snap = snapshot(state);
				if (onProgress) onProgress({ output: snap.output, tokens: snap.tokens, ...(snap.activity ? { activity: snap.activity } : {}) });
				else if (deps.onProgress) deps.onProgress(snap);
			});

			let aborted = false;
			const onAbort = (): void => {
				aborted = true;
				session.agent.abort();
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			// Steering: the in-process engine can inject a user message into the running
			// agent — the v0.4 payoff the one-shot child engine can't do.
			onSteerable?.((text) => {
				const trimmed = text.trim();
				if (trimmed) session.agent.steer({ role: "user", content: [{ type: "text", text: trimmed }] });
			});

			// Delivery bridge: bus messages addressed to this child are steered into its live
			// session as fenced, attributed user turns — attribution stays OUTSIDE the fence so
			// a malicious payload cannot spoof its sender. Serves sibling `contact_peer` sends
			// AND the supervisor's `intercom send` (previously a dead letter: nothing ever
			// drained a child inbox). Flush once on subscribe to catch a message that raced
			// registration (the handle registers before the session finishes building).
			let unsubBridge: (() => void) | undefined;
			if (childHandle && deps.bus) {
				const b = deps.bus;
				const self = childHandle;
				const deliver = (): void => {
					for (const env of b.takeWhere(self, (e) => !e.expectsReply)) {
						const from = env.from === supervisorHandle ? "your supervisor" : `peer ${peerLabels.get(env.from) ?? env.from}`;
						// deliver() runs on the initial flush (BEFORE the run's try/finally below) and
						// inside the bus.onMessage listener (a SENDER's bus.send call stack) — an
						// uncaught steer() throw here would leak the bus registration/observer, skip
						// engine.run cleanup, or propagate into the sender's contact_peer call. Drop the
						// envelope instead; it is lost, not redelivered (mirrors "gone" semantics).
						try {
							session.agent.steer({ role: "user", content: [{ type: "text", text: attributeInbound(from, env.text) }] });
						} catch (e) {
							if (process.env.PI_PERSONA_DEBUG) {
								process.stderr.write(`[pi-persona] delivery bridge steer failed for ${self} (envelope from ${env.from} dropped): ${e instanceof Error ? e.message : String(e)}\n`);
							}
							continue;
						}
						// Transparency tick: surface the delivery on the run's progress line (agent tree).
						// Mirrors the main subscription's fallback (line ~332): per-call onProgress wins
						// (AgentProgress — no `turns`), else the construction-time deps.onProgress
						// (ProgressSnapshot — built from snapshot(state), `turns` included) — the async
						// launch path (extension.ts) only has the latter.
						const snap = snapshot(state);
						const activity = `✉ from ${env.from}`;
						if (onProgress) onProgress({ output: snap.output, tokens: snap.tokens, activity });
						else if (deps.onProgress) deps.onProgress({ ...snap, activity });
					}
				};
				unsubBridge = b.onMessage((env) => {
					if (env.to === self && !env.expectsReply) deliver();
				});
				deliver();
			}

			// The agent's persona is now the session's appended system prompt (see the
			// resource loader); the user turn carries just the task (+ any skills to load,
			// + the output-contract format when one is requested — resolved and pinned HERE
			// so the def that instructs the member is the def that validates it below).
			const skillsPreamble =
				spec.skills && spec.skills.length > 0
					? `Load these skills before starting (use the nearest affine if one is missing): ${spec.skills.join(", ")}.\n\n`
					: "";
			const contractDef = spec.outputContract && deps.contracts ? pinnedDef(spec.outputContract) : undefined;
			const contractTail = contractDef ? `\n\n${contractInstructions(contractDef)}` : "";
			const task = `${skillsPreamble}Task: ${spec.task}${contractTail}`;

			// Capture a thrown error (e.g. provider API 400 before any stream event fires,
			// like model_not_supported) so it survives the finally-cleanup and can be
			// folded into the AgentResult below. Otherwise the stream state stays empty
			// and the user sees an opaque "agent failed (unknown)".
			let thrownError: string | undefined;
			try {
				armIdle(); // start the idle clock (reset on every session event)
				armHard(); // start the lifetime ceiling (never reset)
				armStartup(); // start the first-progress deadline (cancelled by the first real progress)
				await session.prompt(task);
				await session.agent.waitForIdle();
			} catch (e) {
				thrownError = e instanceof Error ? e.message : String(e);
			} finally {
				disarmIdle();
				disarmHard();
				disarmStartup();
				if (signal) signal.removeEventListener("abort", onAbort);
				unsubBridge?.();
				if (childHandle) peerLabels.delete(childHandle);
				if (childHandle) deps.bus?.unregister(childHandle);
				unsub();
				session.dispose();
			}

			const ok =
				!aborted && !timedOut && !hardTimedOut && !startupTimedOut && !thrownError && state.stopReason !== "error" && state.stopReason !== "aborted";
			const result: AgentResult = { agent: spec.agent, output: state.output, usage: state.usage, ok, ...(resolvedRef ? { modelUsed: resolvedRef } : {}) };
			// A timeout/abort is the *cause of death* — label it first (mirrors the child engine).
			if (timedOut) result.error = `${tag} agent timed out — no events for ${watchdogMs}ms${state.errorMessage ? ` (last error: ${state.errorMessage})` : ""}`;
			else if (startupTimedOut)
				result.error = `${tag} agent produced no output within the ${startupMs}ms startup window — it never started (a stalled init; tune with PI_PERSONA_AGENT_STARTUP_MS, 0 disables)${state.errorMessage ? ` (last error: ${state.errorMessage})` : ""}`;
			else if (hardTimedOut) result.error = `${tag} agent exceeded the ${hardMs}ms hard cap${state.errorMessage ? ` (last error: ${state.errorMessage})` : ""}`;
			else if (aborted) result.error = `${tag} agent aborted`;
			else if (state.errorMessage) result.error = `${tag} ${state.errorMessage}`;
			else if (thrownError) result.error = `${tag} ${thrownError}`;
			else if (!ok) result.error = `${tag} agent failed (${state.stopReason ?? "unknown"})`;
			// Classify the failure so the fallback decorator can reroute ONLY provider errors
			// (a thrown API rejection or a stream `error`), never an abort/timeout/hard-cap/agent miss.
			if (!ok)
				result.failureKind =
					timedOut || hardTimedOut || startupTimedOut ? "timeout" : aborted ? "abort" : thrownError || state.stopReason === "error" ? "provider" : "agent";

			if (contractDef) {
				const v = parseAndValidate(state.output, contractDef);
				if (v.value) result.structured = v.value;
				if (!v.ok) {
					result.ok = false;
					if (v.error) result.error = v.error;
					if (result.failureKind === undefined) result.failureKind = "contract";
				}
			}
			return result;
		},
	};
}

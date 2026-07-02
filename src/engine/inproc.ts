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
import { type ContractDef, parseAndValidate, pinContract, type PinnedContract } from "../core/contract.ts";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
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
	/** IDLE window (ms): a session that emits NO events for this long is treated as hung
	 *  and aborted (mirrors the child engine's idle kill). 0/absent = no watchdog.
	 *  Ignored when `coaching` + `allowBlocking` — a child legitimately blocked on a
	 *  supervisor reply (bus ask, 10-minute timeout) emits nothing and must not be killed. */
	timeoutMs?: number;
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
	const { session } = await createAgentSession({
		model: opts.model as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>,
		modelRegistry: opts.modelRegistry,
		sessionManager: SessionManager.inMemory(opts.cwd),
		resourceLoader: loader,
		cwd: opts.cwd,
		excludeTools: ORCHESTRATION_TOOLS,
		...(tools ? { tools } : {}),
		...(opts.customTools && opts.customTools.length > 0 ? { customTools: opts.customTools } : {}),
		...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
	});
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
let disableDepth = 0;
let savedDisable: string | undefined;
function pushDisableGuard(): void {
	if (disableDepth === 0) savedDisable = process.env.PI_PERSONA_DISABLE;
	disableDepth += 1;
	process.env.PI_PERSONA_DISABLE = "1";
}
function popDisableGuard(): void {
	disableDepth -= 1;
	if (disableDepth === 0) {
		if (savedDisable === undefined) delete process.env.PI_PERSONA_DISABLE;
		else process.env.PI_PERSONA_DISABLE = savedDisable;
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

	return {
		async run(spec: AgentRunSpec, onProgress?, callSignal?, onSteerable?): Promise<AgentResult> {
			const cfg = deps.resolveAgent(spec.agent);
			if (!cfg) {
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `[${spec.agent}] unknown agent (not found in registry)` };
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
				};
			}
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
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `${tag} agent aborted` };
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

			// Comm plane: give this child a `contact_supervisor` tool bound to a unique handle,
			// so its progress/decisions reach the supervisor over the bus while it runs (§4.9).
			let childHandle: string | undefined;
			if (deps.bus && deps.coaching) {
				globalChildSeq += 1;
				childHandle = `${spec.agent}#${globalChildSeq}`;
				deps.bus.register(supervisorHandle);
				deps.bus.register(childHandle);
				sessionOpts.customTools = [
					makeContactSupervisorTool(deps.bus, childHandle, supervisorHandle, { allowBlocking: deps.allowBlocking ?? false }),
				];
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
			const watchdogMs = deps.coaching && (deps.allowBlocking ?? false) ? 0 : (deps.timeoutMs ?? 0);
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

			const unsub = session.subscribe((ev) => {
				armIdle(); // any event = activity → reset the idle clock
				applyEvent(state, ev);
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

			// The agent's persona is now the session's appended system prompt (see the
			// resource loader); the user turn carries just the task (+ any skills to load).
			const skillsPreamble =
				spec.skills && spec.skills.length > 0
					? `Load these skills before starting (use the nearest affine if one is missing): ${spec.skills.join(", ")}.\n\n`
					: "";
			const task = `${skillsPreamble}Task: ${spec.task}`;

			// Capture a thrown error (e.g. provider API 400 before any stream event fires,
			// like model_not_supported) so it survives the finally-cleanup and can be
			// folded into the AgentResult below. Otherwise the stream state stays empty
			// and the user sees an opaque "agent failed (unknown)".
			let thrownError: string | undefined;
			try {
				armIdle(); // start the idle clock (reset on every session event)
				await session.prompt(task);
				await session.agent.waitForIdle();
			} catch (e) {
				thrownError = e instanceof Error ? e.message : String(e);
			} finally {
				disarmIdle();
				if (signal) signal.removeEventListener("abort", onAbort);
				if (childHandle) deps.bus?.unregister(childHandle);
				unsub();
				session.dispose();
			}

			const ok = !aborted && !timedOut && !thrownError && state.stopReason !== "error" && state.stopReason !== "aborted";
			const result: AgentResult = { agent: spec.agent, output: state.output, usage: state.usage, ok };
			// A timeout/abort is the *cause of death* — label it first (mirrors the child engine).
			if (timedOut) result.error = `${tag} agent timed out — no events for ${watchdogMs}ms${state.errorMessage ? ` (last error: ${state.errorMessage})` : ""}`;
			else if (aborted) result.error = `${tag} agent aborted`;
			else if (state.errorMessage) result.error = `${tag} ${state.errorMessage}`;
			else if (thrownError) result.error = `${tag} ${thrownError}`;
			else if (!ok) result.error = `${tag} agent failed (${state.stopReason ?? "unknown"})`;

			if (spec.outputContract && deps.contracts) {
				const def = pinnedDef(spec.outputContract);
				if (def) {
					const v = parseAndValidate(state.output, def);
					if (v.value) result.structured = v.value;
					if (!v.ok) {
						result.ok = false;
						if (v.error) result.error = v.error;
					}
				}
			}
			return result;
		},
	};
}

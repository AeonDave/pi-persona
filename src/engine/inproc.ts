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

import { createAgentSession, DefaultResourceLoader, type ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/agent.ts";
import { type ContractDef, parseAndValidate, pinContract, type PinnedContract } from "../core/contract.ts";
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
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
	const { session } = await createAgentSession({
		model: opts.model as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>,
		modelRegistry: opts.modelRegistry,
		sessionManager: SessionManager.inMemory(opts.cwd),
		resourceLoader: loader,
		cwd: opts.cwd,
		excludeTools: ORCHESTRATION_TOOLS,
		...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
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

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return undefined;
	if (live.length === 1) return live[0];
	return AbortSignal.any(live);
}

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

export function makeInProcessEngine(deps: InProcessDeps): StrategyEngine {
	const createSession = deps.createSession ?? createPiSession;
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
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `unknown agent: ${spec.agent}` };
			}

			const ref = spec.model ?? deps.modelFor?.(spec.agent) ?? cfg.model ?? deps.defaultModel;
			const model = resolveModel(deps.modelRegistry, ref);
			if (!model) {
				return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: `model not found: ${ref ?? "(none)"}` };
			}
			const thinkingLevel = isThinkingLevel(deps.childThinking) ? deps.childThinking : undefined;
			const tools = spec.tools ?? cfg.tools;

			const state = createStreamState();
			const signal = combineSignals(deps.signal, callSignal);

			const sessionOpts: CreateSessionOptions = {
				model,
				modelRegistry: deps.modelRegistry,
				cwd: deps.cwd,
				agentDir: deps.agentDir ?? deps.cwd,
			};
			if (tools && tools.length > 0) sessionOpts.tools = tools;
			if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
			if (cfg.systemPrompt?.trim()) sessionOpts.systemPrompt = cfg.systemPrompt.trim();

			// Fork-bomb guard: disable pi-persona inside the sub-session while it's built.
			const prevDisable = process.env.PI_PERSONA_DISABLE;
			process.env.PI_PERSONA_DISABLE = "1";
			let session: InProcSession;
			try {
				session = await createSession(sessionOpts);
			} finally {
				if (prevDisable === undefined) delete process.env.PI_PERSONA_DISABLE;
				else process.env.PI_PERSONA_DISABLE = prevDisable;
			}

			const unsub = session.subscribe((ev) => {
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

			try {
				await session.prompt(task);
				await session.agent.waitForIdle();
			} catch {
				/* the run failed mid-flight; state carries any errorMessage/stopReason */
			} finally {
				if (signal) signal.removeEventListener("abort", onAbort);
				unsub();
				session.dispose();
			}

			const ok = !aborted && state.stopReason !== "error" && state.stopReason !== "aborted";
			const result: AgentResult = { agent: spec.agent, output: state.output, usage: state.usage, ok };
			if (aborted) result.error = "agent aborted";
			else if (state.errorMessage) result.error = state.errorMessage;
			else if (!ok) result.error = `agent failed (${state.stopReason ?? "unknown"})`;

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

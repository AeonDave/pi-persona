/**
 * The Strategy SDK — the constrained surface a strategy is given. Strategies
 * call only these primitives (the engine seam is injected), so they are
 * backend-agnostic and testable with a stub engine. Built-in strategies use the
 * exact same surface as future user-authored strategy files.
 */

import type { RunLimits } from "../core/capabilities.ts";
import { emptyUsage, type ToolEvent } from "../engine/stream.ts";
import { type JudgePrep, prepareJudge } from "./judge.ts";
import { planModelRecovery } from "./model-retry.ts";
import { mapWithConcurrency, Semaphore } from "./parallel.ts";
import { aggregateResults, sumUsage } from "./reducers.ts";
import { roleHint, type RosterMember } from "./roster.ts";
import type { AgentResult, ModelRecovery } from "./types.ts";
import { type ReducerResult, type VoteOpts, voteReduce } from "./voting.ts";

export interface AgentRunSpec {
	agent: string;
	/** Supervisor-assigned display identity for this run. This is metadata only; handles and
	 * routing continue to use the configured agent name and the engine-minted child handle. */
	name?: string;
	task: string;
	model?: string;
	tools?: string[];
	/** Skills the sub-agent must load first (dynamic specialisation). */
	skills?: string[];
	/** Extra system-prompt text appended to the agent's own prompt — an on-the-fly
	 *  specialist persona. Prompt-level only; capabilities remain the enforced gate. */
	role?: string;
	outputContract?: string;
	/** Run this leg in an isolated git worktree (overrides the agent's own setting). */
	isolation?: "none" | "worktree";
	/** Route this leg through the CHILD engine so `pi-mcp-adapter` initializes and the
	 *  sub-agent's `mcp*`/direct tools actually work (the in-process engine never fires
	 *  `session_start`, so they come back "MCP not initialized"). Overrides the agent's own
	 *  `mcp` setting. The child gets its OWN MCP session — pass a server session id in the
	 *  task to share a server-keyed (HTTP) backend's state. */
	mcp?: boolean;
	/** Per-leg override (ms) of the run's shared idle-timeout ceiling (`RunLimits.timeoutMs`) —
	 *  lets ONE legitimately slow leg raise its own wall-clock budget without raising the default
	 *  for its siblings. Engine adapters consume this ONLY when it is a finite, positive number;
	 *  absent or junk (≤0/NaN/Infinity) ⇒ the run's existing `RunLimits.timeoutMs`, untouched. */
	timeoutMs?: number;
	/** Opt this run into sibling messaging: the child gets a `contact_peer` tool (list/send,
	 *  ONE-WAY) scoped to the other peers-enabled members of the SAME engine run. Set by
	 *  strategies (e.g. `debate`). In-process engine only — the child engine ignores it;
	 *  gated at bind time by the persona's `canUseBus` capability. */
	peers?: boolean;
	/** Declared ownership (from delegate `writeSet`), used only to annotate the files-changed report. */
	writeSet?: string[];
}

/** Is `x` a genuine positive, finite `timeoutMs` override — vs. absent/junk (undefined, NaN,
 *  Infinity, ≤0), which means "no override, fall back to the run's existing default"? The
 *  ONE predicate every `timeoutMs` site gates on (`specOf`, the single-async delegate path,
 *  and both engine adapters), so they can't drift into checking it differently. */
export function isPositiveFiniteMs(x: number | undefined): x is number {
	return x !== undefined && Number.isFinite(x) && x > 0;
}

/** A live snapshot of an agent's progress (for streaming UI). */
export interface AgentProgress {
	/** The agent's rolling output so far. */
	output: string;
	/** Tokens consumed so far (best-effort). */
	tokens?: number;
	/** The tool the agent is currently running (e.g. "grep src/…"), if any. */
	activity?: string;
	/** One authoritative runtime tool lifecycle transition; never contains tool args or output. */
	toolEvent?: ToolEvent;
}

/** Inject a steering message into a running agent (in-process engine only).
 *  Returning `false` means the message was not delivered (disposed session, unknown broker
 *  handle). `void` is treated as success so in-process steers that fire-and-forget stay honest. */
export type SteerFn = ((text: string) => boolean | void) & {
	/** Live runtime view: true only while this exact child has an outstanding supervisor ask. */
	isWaitingForSupervisor?: () => boolean;
};

/** The engine seam the SDK runs agents through (real child engine or a stub). */
export interface StrategyEngine {
	run(
		spec: AgentRunSpec,
		onProgress?: (progress: AgentProgress) => void,
		signal?: AbortSignal,
		/** Called once the agent is live with a handle to steer it (in-process only). */
		onSteerable?: (steer: SteerFn) => void,
	): Promise<AgentResult>;
}

export interface Roster {
	/** A team's ordered members — bare agent names, or inline `{ agent, role, … }`
	 *  specialisations (see roster.ts). Normalise each with `rosterSpec`. */
	team(name: string): RosterMember[];
}

export interface AgentCallOptions {
	/** Leave admission slots for mandatory work after this leg; consulted only for optional recovery. */
	reserveChildren?: number | (() => number);
}

export interface StrategySDK {
	agent(spec: AgentRunSpec, options?: AgentCallOptions): Promise<AgentResult>;
	parallel<T>(thunks: Array<() => Promise<T>>, opts?: { concurrency?: number }): Promise<T[]>;
	reduce: {
		aggregate(results: AgentResult[]): AgentResult;
		vote(candidates: AgentResult[], opts: VoteOpts): ReducerResult;
		/** Anonymise + label candidates for an impartial judge (run `agent(judge, …)` on
		 *  the returned ballot, then map the verdict via `pick`). */
		judge(candidates: AgentResult[], order?: number[]): JudgePrep;
	};
	roster: Roster;
	signal: AbortSignal | undefined;
	/** The MAIN model (`provider/id`) — the user's own session model, read LIVE: a `/model` pick
	 *  mid-run must be what a recovery lands on, not the snapshot taken when the run started. A
	 *  leg whose own model is unreachable is re-run once on it (`model-retry.ts`); it is never a
	 *  default for a run — members get their roster/persona model. */
	readonly sessionModel: string | undefined;
	log(message: string): void;
	limits: RunLimits;
}

export interface StrategyInput {
	task: string;
	roster?: string;
	params: Record<string, unknown>;
}

/** A declared strategy param — name/type/default/doc, for discovery (`/doctor`) and the
 *  council tool's lenient unknown-key warning (I2: strategies are trusted project code —
 *  this schema documents and warns, it never validates or blocks a run). `"agent"` names another
 *  agent (an auxiliary selector — arbiter/critic), with an optional real-agent default or roster index. */
export interface StrategyParam {
	type: "string" | "number" | "boolean" | "agent";
	/** An omitted agent-valued selector uses this roster member before its static default. */
	rosterIndex?: number;
	/** A bare agent selector inherits a matching roster member's specialization (not arbiters). */
	inheritRoster?: boolean;
	default?: string | number | boolean;
	doc: string;
}

export interface Strategy {
	name: string;
	/** Declared, discoverable params (name → type/default/doc). Consumed by the council tool
	 *  (warn on unknown keys) and `/doctor`. A strategy with no params omits this. */
	params?: Record<string, StrategyParam>;
	run(input: StrategyInput, sdk: StrategySDK): Promise<AgentResult>;
}

export type AgentStatus = "running" | "done" | "failed";

export interface SDKDeps {
	engine: StrategyEngine;
	roster: Roster;
	limits: RunLimits;
	signal?: AbortSignal;
	/** See `StrategySDK.sessionModel`. */
	sessionModel?: string;
	/** The LIVE main model. Preferred over `sessionModel` wherever both are set: the user can
	 *  change models while a run is in flight, and recovery must follow the CURRENT one. */
	getSessionModel?: () => string | undefined;
	log?: (message: string) => void;
	/** Per-agent lifecycle, for live UI. The result is passed on done/failed so the
	 *  UI can capture each agent's output/usage. `key` is a run-unique display id (the
	 *  `agent` name for a solo member, disambiguated by role/occurrence when the same agent
	 *  runs several times in one roster) — key the UI node by it, not by `agent`, or three
	 *  same-agent roster-role members collapse into one node. Falls back to `agent`. */
	onAgentStatus?: (agent: string, status: AgentStatus, result?: AgentResult, key?: string) => void;
	/** Per-agent streaming progress (rolling output), for live UI. See `onAgentStatus.key`. */
	onAgentProgress?: (agent: string, progress: AgentProgress, key?: string) => void;
	/** Called as each agent starts with a handle to abort just that agent (for UI stop). */
	onAgentStart?: (agent: string, abort: () => void, key?: string) => void;
	/** Called once an agent is live with a handle to steer it (in-process engine only). */
	onAgentSteerable?: (agent: string, steer: SteerFn, key?: string) => void;
	/** Emitted immediately BEFORE a leg is re-run on the main model after a model-caused failure,
	 *  so live UI can say so while it happens (`key` is the same logical node as the attempt it
	 *  replaces). Purely cosmetic: a throw here is contained and can never discard the billed
	 *  result the recovery produced. */
	onModelFallback?: (info: { agent: string; from?: string; to: string; key: string }) => void;
	/** Capability gate for every `sdk.agent()` spawn (council/flow/judge arbiter included).
	 *  Denied BEFORE the child-slot is consumed and without calling the engine. Absent ⇒ no gate. */
	canSpawn?: (agent: string) => boolean;
}

/**
 * An `ok:false` SYNTHESISED from an engine rejection rather than reported by the engine itself.
 * Both engines settle a genuine agent failure, so a rejection means the HARNESS broke — a full temp
 * dir, an adapter crash — which is no evidence about the delegation that provoked it. Consumers
 * that punish failure (the delegate ledger's 2-strike permanent veto) must skip these, or a local
 * disk problem silently blacklists a task that was never actually attempted. `failureKind` cannot
 * carry the distinction: it answers "why did the AGENT stop", where an infra rejection is
 * indistinguishable from a model-side failure.
 */
export interface InfrastructureFailure extends AgentResult {
	infrastructure: true;
}

/** Was this `ok:false` synthesised from an engine rejection? See {@link InfrastructureFailure}. */
export function isInfrastructureFailure(result: Partial<InfrastructureFailure>): boolean {
	return result.infrastructure === true;
}

/**
 * Turn an engine REJECTION into that leg's own `ok:false` result. Both engines normally settle a
 * failed run (`ok:false` + `failureKind`); one that throws instead used to take the whole fan-out
 * down with it, discarding the siblings' completed — and already billed — work. Converting here,
 * where the value type is known, keeps the batch's "N members ⇒ N results" contract intact.
 * `aborted` preserves the stopped-vs-failed distinction callers key off (`failureKind === "abort"`).
 */
export function legFailure(agent: string, error: unknown, aborted: boolean): InfrastructureFailure {
	return {
		agent,
		output: "",
		usage: emptyUsage(),
		ok: false,
		error: `[${agent}] ${error instanceof Error ? error.message : String(error)}`,
		failureKind: aborted ? "abort" : "agent",
		infrastructure: true,
	};
}

/** A run-level cancellation that arrived while this leg was waiting for an SDK slot. */
function abortedLeg(agent: string): AgentResult {
	return { agent, output: "", usage: emptyUsage(), ok: false, error: "agent aborted", failureKind: "abort" };
}

export function makeSDK(deps: SDKDeps): StrategySDK {
	// Run-scoped enforcement of the declared limits — applied here so NO strategy can
	// exceed them, however it calls agent() (I2: safety from runtime limits, not isolation).
	let childrenSpawned = 0;
	let tokensSpent = 0;
	// One gate per SDK/run. This covers direct Promise.all callers as well as sdk.parallel's
	// batch gate; a strategy cannot bypass maxConcurrency by choosing a different topology.
	const maxConcurrency = Math.max(1, Number.isFinite(deps.limits.maxConcurrency) ? Math.floor(deps.limits.maxConcurrency) : 1);
	const agentSlots = new Semaphore(maxConcurrency);
	// Optional recovery must not spend slots already needed by queued logical legs or thunks.
	const pendingAgents = new Set<symbol>();
	const pendingThunks = new Set<symbol>();
	// Run-unique UI keys: the base is the agent name, or `agent · HINT` when the member
	// carries a role — so an ensemble of one agent under several roles shows as distinct
	// nodes. A `#N` suffix guards the degenerate case of an identical base twice. This
	// mirrors `rosterNodeKeys`, so the seeded "queued" nodes line up with the live ones.
	const uiSeen = new Map<string, number>();
	/** The MAIN model, read LIVE (`getSessionModel` wins) so a `/model` pick made while the run is
	 *  in flight is what recovery lands on; the snapshot is used only without a live getter. */
	const currentMain = (): string | undefined => deps.getSessionModel ? deps.getSessionModel() : deps.sessionModel;
	const uiKeyFor = (spec: AgentRunSpec): string => {
		const base = spec.role ? `${spec.agent} · ${roleHint(spec.role)}` : spec.agent;
		const n = (uiSeen.get(base) ?? 0) + 1;
		uiSeen.set(base, n);
		return n === 1 ? base : `${base}#${n}`;
	};

	return {
		agent: async (spec, options) => {
			if (deps.canSpawn && !deps.canSpawn(spec.agent)) {
				return {
					agent: spec.agent,
					output: "",
					usage: emptyUsage(),
					ok: false,
					error: `persona may not spawn "${spec.agent}"`,
					failureKind: "contract",
				};
			}
			const key = uiKeyFor(spec);
			const pending = Symbol();
			pendingAgents.add(pending);
			let started = false;
			const run = async (): Promise<AgentResult> => {
				pendingAgents.delete(pending);
				// These checks intentionally happen AFTER waiting for a slot. A queued leg must see
				// the current child/token totals, not the stale snapshot from when it was enqueued.
				if (childrenSpawned >= deps.limits.maxChildren) {
					throw new Error(`run exceeded maxChildren (${deps.limits.maxChildren})`);
				}
				if (deps.limits.budgetTokens > 0 && tokensSpent >= deps.limits.budgetTokens) {
					throw new Error(`run exceeded token budget (${deps.limits.budgetTokens})`);
				}
				childrenSpawned += 1;
				started = true;
				// One logical node and abort controller across attempts: a local stop remains sticky
				// across the recovery seam. The SAME UI key repairs the node in place.
				let current: AbortController | undefined;
				const detachRoot: Array<() => void> = [];
				let announcedStart = false;
				const attempt = async (aSpec: AgentRunSpec): Promise<AgentResult> => {
					const ac = current ?? new AbortController();
					current = ac;
					if (deps.signal) {
						const onRootAbort = () => ac.abort();
						detachRoot.push(() => deps.signal?.removeEventListener("abort", onRootAbort));
						if (deps.signal.aborted) ac.abort();
						else deps.signal.addEventListener("abort", onRootAbort, { once: true });
					}
					if (!announcedStart) {
						announcedStart = true;
						deps.onAgentStart?.(aSpec.agent, () => current?.abort(), key);
					}
					deps.onAgentStatus?.(aSpec.agent, "running", undefined, key);
					// A slot grant is not an engine start. Root or local cancellation in a lifecycle
					// callback must prevent the engine invocation, not merely hand it an aborted signal.
					if (ac.signal.aborted) {
						return abortedLeg(aSpec.agent);
					}
					const onProgress = deps.onAgentProgress;
					// The try covers the ENGINE CALL AND NOTHING ELSE. Widened over the bookkeeping below it,
					// a throw from the HOST's own status callback — which formats the member's OUTPUT, so it
					// can fail on a completed leg while the empty synthesised failure sails through — would
					// launder a finished, already-billed result into an `ok:false` carrying the UI's error
					// message: the exact loss this containment exists to prevent, with a lie attached.
					let result: AgentResult;
					try {
						result = await deps.engine.run(
							aSpec,
							onProgress ? (p) => onProgress(aSpec.agent, p, key) : undefined,
							ac.signal,
							deps.onAgentSteerable ? (steer) => deps.onAgentSteerable?.(aSpec.agent, steer, key) : undefined,
						);
					} catch (err) {
						// PER-LEG failure — contained, never rethrown: one blown engine call must not discard
						// the fan-out's completed (already billed) sibling results. The RUN-FATAL breaches
						// above (maxChildren, token budget) are thrown BEFORE this try, so they still stop
						// the run instead of degrading into a "failed member" the strategy fans out past.
						// Such a failure is `infrastructure`: the HARNESS broke, which is no evidence about
						// the model, so it never reaches the recovery below.
						const failed = legFailure(aSpec.agent, err, ac.signal.aborted || (deps.signal?.aborted ?? false));
						return failed;
					}
					tokensSpent += result.usage.input + result.usage.output;
					return result;
				};
				try {
					const first = await attempt(spec);
					deps.onAgentStatus?.(spec.agent, first.ok ? "done" : "failed", first, key);

					// ── Main-only model recovery ──────────────────────────────────────────────
					// A model-caused failure (`provider`/`unknown-model`) gets exactly ONE re-run on the
					// session's own model — resolved NOW, so a `/model` switch mid-run is followed. Nothing
					// else qualifies: a stop, a timeout, a contract violation, an agent error, or a harness
					// rejection reproduces on any model, and a retried abort would be a stop that does not
					// stop. Everything here is BOUNDED and non-fatal: an optional recovery that cannot be
					// afforded is skipped with a stated reason and the ORIGINAL cause is returned, because
					// throwing would turn a leg that merely lost its model into a run-fatal breach.
					const main = currentMain();
					const plan = isInfrastructureFailure(first)
						? null
						: planModelRecovery(first, { ...(main ? { sessionModel: main } : {}), ...(spec.model ? { requested: spec.model } : {}) });
					if (!plan) return first;
					// A stop never resurrects: neither the ROOT signal nor the per-leg stop the UI handed
					// out. `current` is the controller this attempt ran under.
					if (deps.signal?.aborted || current?.signal.aborted) return first;
					const skip = (why: string): AgentResult => {
						deps.log?.(`${spec.agent} stays failed — ${why}`);
						return first;
					};
					const requestedReserve = typeof options?.reserveChildren === "function" ? options.reserveChildren() : options?.reserveChildren;
					const reserve = requestedReserve !== undefined && Number.isFinite(requestedReserve) ? Math.max(0, Math.floor(requestedReserve)) : 0;
					const queued = pendingAgents.size + pendingThunks.size;
					if (childrenSpawned + reserve + queued >= deps.limits.maxChildren) {
						return skip(`no child budget left to recover it (maxChildren ${deps.limits.maxChildren}, ${reserve + queued} reserved for remaining work)`);
					}
					if (deps.limits.budgetTokens > 0 && tokensSpent >= deps.limits.budgetTokens) {
						return skip(`token budget exhausted (${deps.limits.budgetTokens})`);
					}
					const recovery: ModelRecovery = { ...(plan.from ? { from: plan.from } : {}), to: plan.to };
					deps.log?.(`${spec.agent} failed on ${plan.from ?? "its model"} — retrying once on the session model ${plan.to}`);
					try {
						deps.onModelFallback?.({ agent: spec.agent, ...recovery, key });
					} catch {
						// Cosmetic hook only: a broken toast must not discard a billed leg.
					}
					// The notification can cancel this logical leg too. Do not replace that intent with
					// a fresh controller or spend another child slot after it has been stopped.
					if (deps.signal?.aborted || current?.signal.aborted) {
						const stopped = { ...abortedLeg(spec.agent), usage: first.usage };
						deps.onAgentStatus?.(spec.agent, "failed", stopped, key);
						return stopped;
					}
					// The retry is a REAL attempt: admitted and charged like any other child, but inside
					// the slot this call already holds — never a recursive agent() (that would deadlock on
					// maxConcurrency 1), and never raising the ceiling.
					childrenSpawned += 1;
					const second = await attempt({ ...spec, model: plan.to });
					// Both attempts are billed once. The LAST attempt supplies model/cause metadata:
					// a main timeout or abort must not be relabelled as the initial provider failure.
					// Keep both diagnostic causes so an unavailable saved assignment is still actionable.
					const settled: AgentResult = {
						...second,
						usage: sumUsage([first.usage, second.usage]),
						modelRecovery: recovery,
						...(!second.ok ? { error: `Initial model ${plan.from ?? "(unresolved)"} failed: ${first.error ?? first.failureKind ?? "unknown cause"}; main model ${plan.to} failed: ${second.error ?? second.failureKind ?? "unknown cause"}` } : {}),
					};
					deps.onAgentStatus?.(spec.agent, settled.ok ? "done" : "failed", settled, key);
					return settled;
				} finally {
					for (const detach of detachRoot) detach();
				}
			};
			try {
				return await agentSlots.with(run, deps.signal);
			} catch (error) {
				// A queued leg has no engine result to report. Settle it as an abort when the
				// run signal removed its waiter; all other errors retain their terminal semantics.
				if (!started && deps.signal?.aborted) return abortedLeg(spec.agent);
				throw error;
			} finally {
				pendingAgents.delete(pending);
			}
		},
		parallel: (thunks, opts) => {
			// `agent()` already contains ENGINE failures per leg, so a rejection reaching here is
			// run-fatal by construction — a limit breach, a host callback that threw, or a thunk that
			// threw on its own. All three are the run's bug, not a member's; let them stop the run.
			// The generic `T` is why containment can't live in `mapWithConcurrency`: only the caller
			// knows what a failed member of its own value type looks like. Clamp arbitrary thunk
			// batches too, so the public parallel surface has the same ceiling as agent().
			const requested = opts?.concurrency ?? maxConcurrency;
			const queued = thunks.map((thunk) => ({ thunk, token: Symbol() }));
			for (const { token } of queued) pendingThunks.add(token);
			return mapWithConcurrency(queued, Math.min(requested, maxConcurrency), ({ thunk, token }) => {
				pendingThunks.delete(token);
				return thunk();
			}).finally(() => {
				for (const { token } of queued) pendingThunks.delete(token);
			});
		},
		reduce: { aggregate: aggregateResults, vote: voteReduce, judge: prepareJudge },
		roster: deps.roster,
		signal: deps.signal,
		get sessionModel() {
			return currentMain();
		},
		log: deps.log ?? (() => {}),
		limits: deps.limits,
	};
}

/**
 * Async run tracking (v0.3). A supervisor can launch a child in the background,
 * keep working, peek its live progress, and be notified on completion — without
 * blocking the turn. Backend-agnostic: the `run` thunk is injected (real engine
 * or stub), so this is fully unit-testable.
 *
 * NOTE: live *steering* of a running child-process agent (resume/redirect) needs
 * the cross-process broker (v0.5) or the InProcessEngine (v0.4). This module
 * covers launch + peek + completion-notify.
 */

import type { ProgressSnapshot, ToolEvent } from "./stream.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { resultReceiptHint, type ResultReceipt } from "../results/retrieval.ts";
import { DEFAULT_ASYNC_RETAIN } from "../core/config.ts";
import { MAX_DISPLAY_LABEL_CHARS, sanitizeDisplayLabel, sanitizeStatusLabel } from "../core/display-label.ts";
import { compactTokens } from "../core/format.ts";
import { isThinkingLevel } from "../core/types.ts";
import { formatDuration } from "../core/time.ts";

/** "possibly stuck" — the soft stall signal shared by the operator card, the peek digest and the UI
 *  badge. It is deliberately patient: a long scan, a big generation, or a blocking command shows no
 *  visible progress yet is perfectly healthy, so every surface flags a leg only after a genuinely long quiet
 *  spell. Purely advisory (no auto-abort); the idle watchdog + token budget are the enforcing backstops. */
export const STALL_FLAG_MS = 90_000;

const PROGRESS_TOKEN_NOTE = "Cumulative tokens show total input + output so far, not current context occupancy.";

export interface AsyncRun {
	id: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed" | "stopped";
	progress: ProgressSnapshot;
	result?: AgentResult;
	resultReceipt?: ResultReceipt;
	error?: string;
	/** The codename the launcher gave this run (e.g. "atlas-static") — the SAME name shown on the
	 *  agent-tree node for this run. When set, it's the canonical display name (over the bare
	 *  `agent` type); absent for call sites that don't carry one (falls back to `agent`). */
	label?: string;
	/** The already-shortened model (e.g. "sonnet") this run was launched with — kept pre-shortened
	 *  so this module needs no import from delegate.ts just to render it. */
	model?: string;
	/** Clock (ms) this run started executing (launch, or admission for a queued one), and the clock it
	 *  settled at — the pair the supervisor's "that leg took 2m 5s" reading is computed from. Both
	 *  come from the tracker's INJECTED clock,
	 *  so a test can settle a two-hour run without waiting. Optional because runs also reach the
	 *  renderers from call sites that never stamped them; absent ⇒ no duration is claimed. */
	startedAt?: number;
	settledAt?: number;
	/** Clock (ms) of the last time the run made {@link madeHeadway} — NOT merely the last event. A worker
	 *  looping without headway, or a tool streaming output forever, keeps emitting but never bumps this,
	 *  so `now - lastAdvanceAt` is what tells "working" from "stuck". */
	lastAdvanceAt?: number;
	/** Waiting for semaphore admission; queued time is not agent execution time. */
	queued?: boolean;
	/** Internal bookkeeping: true once the completion listeners have fired for this entry. Guards a
	 *  force-settle racing the run thunk's natural resolution so listeners fire exactly once. Lives on
	 *  the entry (not a side Set) so it survives pruning and the `launch` closure still sees it. */
	settled?: boolean;
	/** True once the supervisor has explicitly fetched this run's FULL payload. Retention then treats
	 *  the retained copy as spare and evicts it before a result nobody has read yet. */
	collected?: boolean;
	/** True when the launcher classified this leg as a potential workspace MUTATION (its tool grant is
	 *  not provably read-only) — what a persona's fresh-verification policy gates on. Carried on the
	 *  entry rather than in a side Set at the call site: a thunk that throws synchronously settles the
	 *  run INSIDE {@link AsyncRunTracker.launch}, before the caller holds the id, so a registration
	 *  performed after launch() returns would re-insert an already-dead run and leak it. */
	mutates?: boolean;
	/** The id of the one `tasks` call this leg was launched by. Its members are delivered together, once the
	 *  last of them settles (see {@link AsyncRunTracker.batchSettled}); a single-leg launch has none. */
	batch?: string;
	/** What a running run is blocked on, when it is the OPERATOR (a flow checkpoint modal): shown in the
	 *  digest instead of a stall verdict, because silence while a human decides is not a wedge. */
	awaiting?: string;
}

/** What {@link madeHeadway} reads of one progress reading: a tracker snapshot, or a leg's `AgentProgress`
 *  (which carries no turns). */
export interface ProgressReading {
	output?: string | undefined;
	tokens?: number | undefined;
	turns?: number | undefined;
	toolEvent?: ToolEvent | undefined;
}

/**
 * The ONE rule for "this run advanced": the assistant produced more (output grew, tokens or turns rose) or a
 * tool call just COMPLETED. Raw tool output is deliberately not headway - a straggler that streams text
 * forever (`npm run dev`, `--watch`, `tail -f`) must still read as stalled, so the operator-only card can
 * flag it. Nothing is killed and the model is not woken; a legitimately noisy tool earns an advisory only.
 * A completion counts once: the transient `toolEvent` rides the one snapshot it was emitted on, so
 * replaying that snapshot credits nothing. Pure.
 */
export function madeHeadway(prev: ProgressReading | undefined, next: ProgressReading): boolean {
	return (next.output?.length ?? 0) > (prev?.output?.length ?? 0)
		|| (next.tokens ?? 0) > (prev?.tokens ?? 0)
		|| (next.turns ?? 0) > (prev?.turns ?? 0)
		|| (next.toolEvent?.phase === "end" && next.toolEvent !== prev?.toolEvent);
}

/** The run's id is passed in so the launcher can wire a steer handle keyed by it. */
export type RunThunk = (onProgress: (snapshot: ProgressSnapshot) => void, runId: string) => Promise<AgentResult>;

/** How many uncollected evictions the tracker remembers, so a later `result` can answer "dropped
 *  under pressure" instead of an indistinguishable "never existed". Bounded: a session that drops
 *  thousands of runs only ever needs to explain the recent ones. */
export const MAX_DROPPED_IDS = 256;

export class AsyncRunTracker {
	private readonly runs = new Map<string, AsyncRun>();
	/** Ids of settled runs in SETTLE order — the eviction queue {@link prune} drains from the front.
	 *  `runs` is keyed in LAUNCH order, which stops matching once legs finish out of order. */
	private readonly settledOrder: string[] = [];
	/** Ids whose payload was evicted while STILL UNCOLLECTED, oldest first (insertion-ordered Set). */
	private readonly droppedIds = new Set<string>();
	private readonly completeListeners: Array<(run: AsyncRun) => void> = [];
	private readonly createListeners: Array<(run: AsyncRun) => void> = [];
	private seq = 0;
	private readonly maxRetained: number;
	private readonly now: () => number;

	/** `now` is injected so the stall clock is deterministic under test (real time by default).
	 *  `maxRetained` (default {@link DEFAULT_ASYNC_RETAIN}; the extension passes `config.asyncRetain`) is the config-driven
	 *  PI_PERSONA_ASYNC_RETAIN knob's landing spot: how many settled-but-uncollected runs survive before FIFO-eviction. */
	constructor(opts?: { now?: () => number; maxRetained?: number }) {
		this.now = opts?.now ?? ((): number => Date.now());
		this.maxRetained = opts?.maxRetained ?? DEFAULT_ASYNC_RETAIN;
	}

	/** How many run ids this lineage has issued: what a restored instance must continue from. */
	get issued(): number {
		return this.seq;
	}

	/** Continue the id counter from a previous instance of the same session so ids never repeat within
	 *  one history. Monotonic: anything that would rewind it, or is not a whole number, is ignored. */
	continueFrom(issued: number): void {
		if (Number.isSafeInteger(issued) && issued > this.seq) this.seq = issued;
	}

	launch(meta: { agent: string; task: string; label?: string; model?: string; mutates?: boolean; queued?: boolean; batch?: AsyncRun["batch"] }, run: RunThunk): string {
		this.seq += 1;
		const id = `run-${this.seq.toString(36)}`;
		const startedAt = this.now(); // one clock read, so the launch and stall stamps cannot disagree
		const entry: AsyncRun = {
			id,
			agent: meta.agent,
			task: meta.task,
			status: "running",
			progress: { output: "", turns: 0, tokens: 0 },
			startedAt,
			...(meta.queued ? { queued: true } : { lastAdvanceAt: startedAt }),
		};
		if (meta.mutates) entry.mutates = true;
		if (meta.batch) entry.batch = meta.batch;
		// Labels/models are rendered as trusted status metadata on several compact surfaces. Normalize
		// once at the tracker boundary so a caller cannot smuggle multiline instructions into any of
		// those views; renderers still sanitize defensively when they compose a label.
		if (meta.label !== undefined) entry.label = sanitizeDisplayLabel(meta.label);
		if (meta.model !== undefined) entry.model = sanitizeDisplayLabel(meta.model, "model");
		this.runs.set(id, entry);
		for (const cb of [...this.createListeners]) {
			try { cb(entry); } catch { /* archival observation cannot prevent launch */ }
		}

		const settle = (): void => this.settleOnce(entry);
		// `Promise.resolve(run(...))` routes BOTH a returned rejection AND a SYNCHRONOUS throw from
		// the thunk (e.g. the engine throwing before it returns its promise) through the same failure
		// path, so onComplete always fires — otherwise the entry would be stuck "running" forever and
		// its stop/steer handle would leak.
		try {
			Promise.resolve(
				run((s) => {
					// The injected clock stamps the advance, never an event's own timestamp.
					if (!entry.queued && madeHeadway(entry.progress, s)) entry.lastAdvanceAt = this.now();
					entry.progress = s;
				}, id),
			)
				.then((result) => {
					if (entry.settled) return; // force-settled by the supervisor — drop the late natural result
					entry.status = result.ok ? "done" : result.failureKind === "abort" ? "stopped" : "failed";
					// Retain scalar metadata by value: an engine reusing/mutating its result object
					// after settlement must not rewrite this run's requested/observed effort.
					entry.result = { ...result, usage: { ...result.usage }, ...(result.resultReceipt ? { resultReceipt: { ...result.resultReceipt } } : {}) };
					if (!result.ok && result.error) entry.error = result.error;
				})
				.catch((err: unknown) => {
					if (entry.settled) return;
					entry.status = "failed";
					entry.error = err instanceof Error ? err.message : String(err);
				})
				.finally(settle);
		} catch (err) {
			entry.status = "failed";
			entry.error = err instanceof Error ? err.message : String(err);
			settle();
		}

		return id;
	}

	/** Fire the completion listeners for `entry` exactly once. Both the natural resolution of the run
	 *  thunk and a supervisor {@link forceSettle} route through here, so a race between them never
	 *  double-notifies (which would double-clean handles and duplicate the completion report). */
	private settleOnce(entry: AsyncRun): void {
		if (entry.settled) return;
		entry.settled = true;
		// Stamped HERE, not on the result: this is the one point both the natural resolution and a
		// forceSettle pass through, so every settled run gets a duration by the same rule.
		entry.settledAt = this.now();
		this.settledOrder.push(entry.id);
		this.prune();
		// Iterate a SNAPSHOT: a listener may unsubscribe from inside its own callback, and
		// splicing the live array under the cursor would shift the next listener past it.
		// A listener's throw must likewise not skip the ones after it — and on the natural-settle
		// path this runs inside an unobserved promise chain, where an escaping throw becomes a
		// process-killing unhandled rejection.
		for (const cb of [...this.completeListeners]) {
			try {
				cb(entry);
			} catch (e) {
				if (process.env.PI_PERSONA_DEBUG) {
					process.stderr.write(`[pi-persona] async completion listener threw for ${entry.id}: ${e instanceof Error ? e.message : String(e)}\n`);
				}
			}
		}
	}

	/** A queued run acquired its concurrency slot: execution, and its stall window, start now. */
	markAdmitted(id: string): boolean {
		const entry = this.runs.get(id);
		if (!entry || entry.status !== "running" || entry.settled || entry.queued !== true) return false;
		delete entry.queued;
		entry.startedAt = entry.lastAdvanceAt = this.now();
		return true;
	}

	/** Mark a running run as waiting on the operator (`label`), or release it (`undefined`). The clock
	 *  restarts on release, so the human's think time is never counted as the run's own silence. */
	setAwaiting(id: string, label: string | undefined): boolean {
		const entry = this.runs.get(id);
		if (!entry || entry.status !== "running" || entry.settled) return false;
		if (label === undefined) {
			delete entry.awaiting;
			this.advance(id);
		} else {
			entry.awaiting = sanitizeStatusLabel(label, "waiting for operator", 120);
		}
		return true;
	}

	/** Credit headway to a running run whose own snapshot cannot show it: a council or flow aggregates its
	 *  legs' progress, so one leg's advance is invisible in the sum. Queued, settled and unknown runs are left alone. */
	advance(id: string): void {
		const entry = this.runs.get(id);
		if (entry && entry.status === "running" && !entry.settled && !entry.queued) entry.lastAdvanceAt = this.now();
	}

	/**
	 * Force a still-"running" run to settle as stopped and fire its completion listeners. Escape hatch
	 * for a run whose hard-stop handle is gone (consumed by a prior abort, or never registered) while
	 * the tracker still shows it running — otherwise the supervisor's `stop` reports "no running async
	 * run" for a run its own check-in reports as running (an unkillable ghost that keeps burning the
	 * check-in budget). Idempotent; a no-op on an unknown or already-settled run. The late natural
	 * result from the underlying thunk is then dropped (guarded in {@link launch}).
	 */
	forceSettle(id: string, error: string): boolean {
		const entry = this.runs.get(id);
		if (!entry || entry.status !== "running" || entry.settled) return false;
		entry.status = "stopped";
		entry.error = error;
		this.settleOnce(entry);
		return true;
	}

	/**
	 * Keep the RETAINED (settled) runs bounded, evicting the least recently settled first.
	 *
	 * Two invariants this must not violate. A still-running entry is never evictable — its
	 * stop/steer handles and live peek hang off it — so bounding the WHOLE map would make the run
	 * that just settled the only eviction candidate whenever more legs are in flight than
	 * `maxRetained`, destroying its payload before {@link settleOnce} has even told the supervisor
	 * to fetch it. And "oldest" means oldest SETTLED, not oldest launched: legs finish out of launch
	 * order, so launch-order eviction can drop a run seconds after its completion follow-up pointed
	 * the supervisor at it. The run settling right now is appended last, hence evicted last.
	 *
	 * A bound this small cannot promise every payload survives: a fan-out wider than `maxRetained`
	 * settles more results than there is room for, whoever wins the ordering. So retention is
	 * preference plus honesty — a run the supervisor has already READ is evicted before one nobody
	 * has, and an eviction that does destroy an uncollected payload is recorded ({@link wasDropped})
	 * so the tool can say the result was dropped instead of reporting the id as unknown.
	 */
	private prune(): void {
		while (this.settledOrder.length > this.maxRetained) {
			const collectedAt = this.settledOrder.findIndex((id) => this.runs.get(id)?.collected === true);
			const at = collectedAt >= 0 ? collectedAt : 0;
			const [id] = this.settledOrder.splice(at, 1) as [string];
			if (collectedAt < 0) this.recordDrop(id);
			this.runs.delete(id);
		}
	}

	private recordDrop(id: string): void {
		this.droppedIds.add(id);
		// Insertion-ordered, so the first key is the oldest drop we still remember.
		if (this.droppedIds.size > MAX_DROPPED_IDS) this.droppedIds.delete(this.droppedIds.values().next().value as string);
	}

	/** Record that the supervisor has read this run's full payload (an explicit `intercom result`).
	 *  Its retained copy becomes the cheapest thing to evict when the bound is next hit. */
	markCollected(id: string): void {
		const entry = this.runs.get(id);
		if (entry) entry.collected = true;
	}

	/** Did this id name a run whose payload was evicted before anyone collected it? Distinguishes a
	 *  result lost to retention pressure from an id that never existed — the two are the same
	 *  `peek() === undefined` otherwise, and only one of them deserves an explanation. */
	wasDropped(id: string): boolean {
		return this.droppedIds.has(id);
	}

	/** The retention bound in force, quoted back to the supervisor when a payload is dropped. */
	get retention(): number {
		return this.maxRetained;
	}

	/** The still-running legs that may MUTATE the workspace (what a persona's cross-call
	 *  fresh-verification gate holds a declared verifier against). Derived from live status on every
	 *  call, so a settled leg can never linger as a phantom writer. */
	writers(): AsyncRun[] {
		return this.running().filter((r) => r.mutates === true);
	}

	peek(id: string): AsyncRun | undefined {
		return this.runs.get(id);
	}

	list(): AsyncRun[] {
		return [...this.runs.values()];
	}

	running(): AsyncRun[] {
		return this.list().filter((r) => r.status === "running");
	}

	/** True when `run` may be reported: it belongs to no batch, or no member of its batch is still
	 *  running. Asked of the live tracker, never counted from a delivered set, so a member collected
	 *  early (`intercom result`), stopped, or failed inside launch() can never keep its batch waiting. */
	batchSettled(run: AsyncRun): boolean {
		const batch = run.batch;
		return batch === undefined || !this.running().some((r) => r.batch === batch);
	}

	onCreate(cb: (run: AsyncRun) => void): () => void {
		this.createListeners.push(cb);
		return () => {
			const i = this.createListeners.indexOf(cb);
			if (i >= 0) this.createListeners.splice(i, 1);
		};
	}

	onComplete(cb: (run: AsyncRun) => void): () => void {
		this.completeListeners.push(cb);
		return () => {
			const i = this.completeListeners.indexOf(cb);
			if (i >= 0) this.completeListeners.splice(i, 1);
		};
	}
}

/** First occurrence of each run id, in order. */
export function dedupeRunsById(runs: AsyncRun[]): AsyncRun[] {
	const byId = new Map<string, AsyncRun>();
	for (const r of runs) if (!byId.has(r.id)) byId.set(r.id, r);
	return [...byId.values()];
}

/** A terminal engine observation supersedes the launch choice; running/launch rows retain their snapshot. */
export function observedRunModel(run: Partial<Pick<AsyncRun, "status" | "result">>): string | undefined {
	const model = run.status !== undefined && run.status !== "running" ? run.result?.modelUsed : undefined;
	return model?.trim() ? model.split("/").map((part) => sanitizeDisplayLabel(part, "model", 256)).join("/").slice(0, 256) : undefined;
}

/** One identity everywhere a tracked run is rendered: the launcher's codename when present,
 *  otherwise the agent type, with the observed terminal model or launch model appended once. */
export function runDisplayName(run: Pick<AsyncRun, "agent" | "label" | "model"> & Partial<Pick<AsyncRun, "status" | "result">>): string {
	const observed = observedRunModel(run);
	const selected = observed ? (observed.split("/").pop() ?? observed).replace(/^claude-/, "") : run.model;
	const model = selected === undefined ? undefined : sanitizeDisplayLabel(selected, "model", 24);
	if (model === undefined) return sanitizeDisplayLabel(run.label ?? run.agent);
	const suffix = ` · ${model}`;
	const nameLimit = Math.max(1, MAX_DISPLAY_LABEL_CHARS - suffix.length);
	return `${sanitizeDisplayLabel(run.label ?? run.agent, "agent", nameLimit)}${suffix}`;
}

/**
 * How long a settled leg actually took, or undefined when this run carries no usable stamps.
 *
 * Wall time is the supervisor's cheapest signal about a delegation — whether the leg it is reading
 * came back in seconds or ground for two hours changes what to do next — and no completion surface
 * used to say it. Undefined (rather than "?" or "0s") when the pair is missing, inverted or not finite, so an
 * unstamped run renders exactly as it did before instead of gaining a fabricated reading.
 */
export function runDurationLabel(run: AsyncRun): string | undefined {
	const { startedAt, settledAt } = run;
	if (startedAt === undefined || settledAt === undefined) return undefined;
	const span = settledAt - startedAt;
	return Number.isFinite(span) && span >= 0 ? formatDuration(span) : undefined;
}

/** The " in 2m 5s" / " after 2m 5s" fragment for a settled leg, or "" when it has no duration. */
function durationSuffix(run: AsyncRun, preposition: "in" | "after"): string {
	const label = runDurationLabel(run);
	return label === undefined ? "" : ` ${preposition} ${label}`;
}

// Completion reports are automatic follow-ups, so they must remain bounded even when a healthy
// child returns a very large report. The full payload stays available through the result action;
// these limits only govern the notification/digest surface.
export const MAX_PARTIAL_OUTPUT_CHARS = 12_000;
export const MAX_COMPLETION_REPORT_CHARS = 12_000;
export const MAX_COMPLETION_RUN_CHARS = Math.min(MAX_PARTIAL_OUTPUT_CHARS, 4_000);
export const MAX_ASYNC_STATUS_ROWS = 64;

/**
 * Hard-cap a completion surface without cutting through a line. Fenced sub-agent payload lines
 * start with `> `; slicing one mid-line would turn the suffix back into apparently trusted prose.
 * Keeping only complete head/tail lines preserves that trust boundary while retaining useful
 * status metadata and the most recent guidance.
 */
export function boundCompletionSurface(
	text: string,
	omission = `completion report truncated at ${MAX_COMPLETION_REPORT_CHARS} characters; open individual runs with intercom { action:"result", to:"<run-id>" }`,
): string {
	if (text.length <= MAX_COMPLETION_REPORT_CHARS) return text;
	const normalizedOmission = omission
		.replace(/\r\n?/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const maxOmissionChars = 512;
	const boundedOmission = normalizedOmission.length > maxOmissionChars
		? `${normalizedOmission.slice(0, maxOmissionChars - 1)}…`
		: normalizedOmission || "content truncated";
	const marker = `\n\n[... ${boundedOmission} ...]\n\n`;
	const contentBudget = Math.max(0, MAX_COMPLETION_REPORT_CHARS - marker.length);
	const headBudget = Math.floor(contentBudget * 0.65);
	const tailBudget = Math.max(0, contentBudget - headBudget);

	const headBreak = text.lastIndexOf("\n", headBudget);
	const head = headBreak >= 0 ? text.slice(0, headBreak) : "";
	const tailWindowStart = Math.max(0, text.length - tailBudget);
	const tailBreak = text.indexOf("\n", tailWindowStart);
	const tail = tailBreak >= 0 ? text.slice(tailBreak + 1) : "";
	return `${head}${marker}${tail}`;
}

const resultActionHint = (id: string): string => `intercom { action:"result", to:"${id}" }`;

/**
 * The explicit overflow signal for the one case retention cannot cover: more runs settled than the
 * tracker keeps, so some of the ids this very report names can no longer be fetched. Saying it here,
 * where the results are still in front of the supervisor, is what keeps "each result returns to you"
 * honest — the alternative is a bare "no such run" later, when the payload is unrecoverable.
 */
export function buildRetentionOverflowNote(droppedIds: readonly string[], retention: number): string {
	if (droppedIds.length === 0) return "";
	const visible = droppedIds.slice(0, MAX_ASYNC_STATUS_ROWS);
	const omitted = droppedIds.length - visible.length;
	const idSummary = `${visible.join(", ")}${omitted > 0 ? `, … +${omitted} more` : ""}`;
	return (
		`⚠ ${droppedIds.length} of these run${droppedIds.length === 1 ? "" : "s"} can no longer be fetched by id (${idSummary}): ` +
		`more runs settled than the ${retention}-run retention bound keeps, so their full payloads were dropped. ` +
		"Work from the summaries above. To keep more, raise PI_PERSONA_ASYNC_RETAIN or fan out in narrower waves and collect as you go."
	);
}

/** Return the complete text for one run for an explicit/on-demand result action. */
export function getFullRunOutput(run: AsyncRun): string {
	if (run.result?.output?.trim()) return run.result.output;
	if (run.progress.output.trim()) return run.progress.output;
	if (run.error?.trim()) return run.error;
	return "(no output)";
}

export function clipRunOutput(text: string, id: string, maxChars: number, label = "result output"): string {
	const budget = Math.max(0, Math.floor(maxChars));
	if (text.length <= budget) return text;
	const marker = `\n\n[... ${label} truncated; ${text.length - budget} characters omitted for ${id}. Full output: ${resultActionHint(id)} ...]\n\n`;
	// A hostile/oversized id can make the drill-down marker longer than the entire
	// budget. Keep the hard cap absolute; callers may still retrieve the full output
	// through the internal run id, while this notification surface stays bounded.
	if (marker.length >= budget) return marker.slice(0, budget);
	const contentBudget = budget - marker.length;
	const headChars = Math.ceil(contentBudget / 2);
	const tailChars = Math.max(0, contentBudget - headChars);
	return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

export function isAsyncRunStalled(run: AsyncRun, now: number, stallMs: number): boolean {
	return run.status === "running" && run.queued !== true && stallMs > 0
		&& run.lastAdvanceAt !== undefined && Number.isFinite(run.lastAdvanceAt) && run.lastAdvanceAt >= 0
		&& now - run.lastAdvanceAt >= stallMs;
}

/**
 * A compact ProgressView digest of async runs — the full on-demand `/peek` view, and the body the
 * routine check-in wraps ({@link buildCheckIn}). When `opts` carries the current clock + a stall
 * window, a RUNNING run that hasn't advanced within that window is flagged "possibly stuck". The
 * periodic stall check never wakes the model with this digest; it files it as an operator-only card.
 */
export function buildPeekDigest(runs: AsyncRun[], opts?: { now?: number; stallMs?: number; waitingForSupervisor?: ReadonlySet<string> }): string {
	if (runs.length === 0) return "No async runs.";
	const running = runs.filter((r) => r.status === "running").length;
	const now = opts?.now;
	const stallMs = opts?.stallMs;
	const visibleRuns = runs.slice(0, MAX_ASYNC_STATUS_ROWS);
	const lines = visibleRuns.map((r) => {
		// Canonical display name: the codename the launcher gave it (the SAME name the agent-tree
		// node shows) + its short model, e.g. "atlas-static · sonnet" — never the bare agent TYPE,
		// which reads as a different sub-agent than the one the tree shows. Falls back to `agent`
		// for call sites that never carried a label (keeps this back-compat).
		const name = runDisplayName(r);
		const head = `[${r.id}] ${name} — ${r.status}`;
		if (r.status === "running") {
			// A tracked council/flow reports tokens only (its legs carry no turn count): "0 turns" would be false.
			let line = `${head} (${r.progress.turns > 0 ? `${r.progress.turns} turns, ` : ""}${compactTokens(r.progress.tokens)} cumulative input + output tokens)`;
			// Queued time is not execution time, so a queued run claims no "running for".
			const ran = r.queued ? undefined : runDurationLabel({ ...r, ...(now !== undefined ? { settledAt: now } : {}) });
			if (ran) line += ` · running for ${ran}`;
			if (r.queued) line += " · queued (waiting for concurrency slot)";
			else if (r.awaiting) line += ` · ${r.awaiting}`;
			else if (opts?.waitingForSupervisor?.has(r.id)) line += " · waiting for supervisor";
			else if (now !== undefined && stallMs !== undefined && isAsyncRunStalled(r, now, stallMs)) {
				const stalledFor = now - r.lastAdvanceAt!;
				line += ` ⚠ possibly stuck (no progress for ${Math.round(stalledFor / 1000)}s)`;
			}
			return line;
		}
		// Peek is a ProgressView that can be returned directly as a tool result or injected into a
		// routine follow-up. Never put child-authored output or error text on this path: even a short
		// preview is an untrusted prompt-injection carrier. The explicit result action is the fenced,
		// on-demand surface for details.
		const took = durationSuffix(r, "in");
		if (r.status === "failed") return `${head}${took}: failure details available via intercom result (to: ${r.id})`;
		if (r.result) return `${head}${took}: full result available via intercom result (to: ${r.id})`;
		return `${head}${took}`;
	});
	const omitted = runs.length - visibleRuns.length;
	if (omitted > 0) lines.push(`… ${omitted} additional async runs omitted from this bounded status view.`);
	if (running > 0) lines.push(PROGRESS_TOKEN_NOTE);
	return [`Async runs: ${runs.length} (${running} running)`, ...lines].join("\n");
}

/**
 * Turns the periodic peek from a poll into an EXCEPTION signal. Tracks which running legs have already
 * been surfaced as stalled, so the operator is told ONCE when a leg crosses the stall window — never
 * every tick while it stays stalled, and never at all while it is making progress. A leg that advances
 * again (its `lastAdvanceAt` moves) re-arms, so a later stall re-alerts; legs that leave the list are
 * forgotten. Pure w.r.t. the injected `now`, so it is unit-tested without a real clock.
 */
export class PeekWatcher {
	/** runId → the `lastAdvanceAt` value at which the operator episode was reported. */
	private readonly reportedAt = new Map<string, number>();

	/** The running legs that have NEWLY crossed the stall window since we last reported them. */
	poll(runs: AsyncRun[], now: number, stallMs: number, waitingForSupervisor: ReadonlySet<string> = new Set()): AsyncRun[] {
		const live = new Set<string>();
		const newlyStuck: AsyncRun[] = [];
		for (const r of runs) {
			if (r.status !== "running") continue;
			live.add(r.id);
			if (r.queued) {
				this.reportedAt.delete(r.id);
				continue;
			}
			if (waitingForSupervisor.has(r.id) || r.awaiting) {
				this.reportedAt.delete(r.id); // a live ask or an operator decision is not a stall; re-evaluate when it settles
				continue;
			}
			if (r.lastAdvanceAt === undefined) continue;
			const prev = this.reportedAt.get(r.id);
			if (prev !== undefined && r.lastAdvanceAt > prev) this.reportedAt.delete(r.id); // advanced ⇒ re-arm
			if (isAsyncRunStalled(r, now, stallMs) && !this.reportedAt.has(r.id)) {
				this.reportedAt.set(r.id, r.lastAdvanceAt);
				newlyStuck.push(r);
			}
		}
		for (const id of [...this.reportedAt.keys()]) if (!live.has(id)) this.reportedAt.delete(id);
		return newlyStuck;
	}

	/** Forget all tracked state (session start / reload hygiene). */
	reset(): void {
		this.reportedAt.clear();
	}
}

/** The operator-only periodic status card. It carries the progress digest without model instructions. */
export function buildCheckIn(runs: AsyncRun[], opts: { now: number; stallMs: number; waitingForSupervisor?: ReadonlySet<string>; reason?: "routine" | "stall" }): string {
	const reason = opts.reason ?? "routine";
	return `Async activity · ${reason === "stall" ? "possible stall" : "routine check-in"}\n\n${buildPeekDigest(runs, opts)}`;
}

/**
 * Build ONE consolidated supervisor notice for a batch of settled async runs. Coalescing a
 * burst into a single message is what keeps completions from piling up as separate queued
 * follow-ups (pi renders one sticky line per queued message); the explicit guidance keeps the
 * supervisor from blindly re-issuing a delegation that just failed. `fence` wraps untrusted
 * sub-agent text so the supervisor treats it as data, never as instructions. `bounded: false` lifts
 * every cap, for the headless inline return where the caller is parked in the call and nothing is injected.
 */
export function buildCompletionReport(runs: AsyncRun[], fence: (text: string) => string, opts: { bounded?: boolean } = {}): string {
	const done = runs.filter((r) => r.status === "done");
	const failed = runs.filter((r) => r.status === "failed");
	const stopped = runs.filter((r) => r.status === "stopped");
	// Share the notification budget across every leg that can contribute payload. This keeps a
	// large fan-out fair: the first result cannot consume the whole follow-up while later statuses
	// are still waiting to be rendered. The final report cap remains a hard backstop for metadata.
	const bounded = opts.bounded !== false;
	const cap = (chars: number): number => (bounded ? chars : Number.POSITIVE_INFINITY);
	const payloadRuns = runs.filter((r) => r.status === "done" || r.progress.output.trim());
	const fairRunChars = cap(Math.min(
		MAX_COMPLETION_RUN_CHARS,
		Math.max(256, Math.floor(MAX_COMPLETION_REPORT_CHARS / Math.max(1, payloadRuns.length * 2))),
	));
	// Each failed leg is clipped on its own line, from a budget of its own: every id and cause stays
	// listed however wide the fan-out, and the drill-down names a real run.
	const failureChars = cap(Math.min(
		MAX_COMPLETION_RUN_CHARS,
		Math.max(200, Math.floor(MAX_COMPLETION_REPORT_CHARS / (4 * Math.max(1, failed.length)))),
	));
	// Failures are always reported — the supervisor must know so it can adjust or tell
	// the user. Blind retry loops are prevented at RUNTIME by the DelegationLedger
	// (an identical delegation that failed twice is vetoed before it spawns), not by
	// hiding information.
	// First line stays short and informative — pi's queued-message UI shows only this line, truncated.
	const stoppedCount = stopped.length > 0 ? `, ${stopped.length} stopped` : "";
	const head = `[pi-persona] ${runs.length} async run${runs.length === 1 ? "" : "s"} settled — ${done.length} done, ${failed.length} failed${stoppedCount}`;
	const blocks: string[] = [head];
	const models = runs.flatMap((run) => {
		const model = observedRunModel(run);
		return model ? [`${run.id}: Observed model: ${model}`] : [];
	});
	if (models.length > 0) blocks.push(`\n${models.join("\n")}`);
	const receipts = runs.slice(0, MAX_ASYNC_STATUS_ROWS).flatMap((run) => {
		const hint = resultReceiptHint(run.resultReceipt);
		return hint ? [`${run.id}: ${hint}`] : [];
	});
	if (receipts.length > 0) blocks.push(`\nTerminal reports (intercom results lists all retained references):\n${receipts.join("\n")}`);
	// Common result metadata, outside untrusted worker prose, on inline and background paths.
	// A host effort observation is a Pi request setting, not a measure of provider cognition.
	const efforts = runs.flatMap((r) => {
		const requested = r.result?.thinkingRequested;
		const observed = r.result?.thinkingEffective;
		if (!isThinkingLevel(requested) && !isThinkingLevel(observed)) return [];
		return [`${r.id}: requested ${isThinkingLevel(requested) ? requested : "unknown"}; observed Pi effort ${isThinkingLevel(observed) ? observed : "unknown"}`];
	});
	if (efforts.length > 0) blocks.push(`\nThinking (not provider cognition):\n${efforts.join("\n")}`);
	for (const r of done) {
		// Only fence REAL output — an empty/whitespace result gets a plain "(no output)", never an
		// empty <fence></fence> shell (there's nothing untrusted to guard, and the empty block reads
		// as clutter).
		const full = getFullRunOutput(r);
		const body = full !== "(no output)" ? fence(clipRunOutput(full, r.id, fairRunChars)) : "(no output)";
		blocks.push(`\n✅ ${r.id} (${runDisplayName(r)}) done${durationSuffix(r, "in")}:\n${body}`);
	}
	if (stopped.length > 0) {
		const reasons = stopped.map((r) => `• ${r.id} (${runDisplayName(r)})${durationSuffix(r, "after")}: ${r.error ?? "stopped by supervisor"}`).join("\n");
		blocks.push(`\n⏹ ${stopped.length} stopped:\n${fence(reasons)}`);
		// A deliberate stop is not a failure and must not trigger retry guidance. Its accumulated
		// output is still valuable, so preserve the same bounded, fenced salvage guarantee.
		for (const r of stopped) {
			const partial = r.progress.output.trim();
			if (partial) {
				blocks.push(`\n↩ ${r.id} (${runDisplayName(r)}) partial output before it was stopped:\n${fence(clipRunOutput(partial, r.id, fairRunChars, "partial output"))}`);
			}
		}
	}
	if (failed.length > 0) {
		const reasons = failed.map((r) => `• ${r.id} (${runDisplayName(r)})${durationSuffix(r, "after")}: ${clipRunOutput(r.error ?? "(no detail)", r.id, failureChars, "failure detail")}`).join("\n");
		blocks.push(
			`\n❌ ${failed.length} failed:\n${fence(reasons)}\n\n` +
				"Handle each failure deliberately: retry ONCE with a different model or approach, or report it to the user. " +
				"If a failed/aborted leg left partial output below, salvage what's usable instead of re-running from scratch. " +
				"Do not re-issue the same failing delegation repeatedly.",
		);
		// Salvage: a failed leg's partial output (its last progress snapshot) is NOT lost — surface it
		// fenced so real work can be reused rather than thrown away. Only when there's something to show.
		for (const r of failed) {
			const partial = r.progress.output.trim();
			if (partial) {
				blocks.push(`\n↩ ${r.id} (${runDisplayName(r)}) partial output before it failed:\n${fence(clipRunOutput(partial, r.id, fairRunChars, "partial output"))}`);
			}
		}
	}
	const report = blocks.join("\n");
	if (!bounded) return report;
	// The cap cuts whole legs from the middle of a wide fan-out. Name every run in the tail, which the
	// cut keeps, so a cut leg is still fetchable by id instead of silently missing.
	const named = report.length > MAX_COMPLETION_REPORT_CHARS
		? `${report}\n\nRun ids in this report: ${runs.slice(0, MAX_ASYNC_STATUS_ROWS).map((r) => r.id).join(", ")}. Saved reports: intercom { action:"results" }; use result { ref, offset, limit } even if live handles were dropped.`
		: report;
	return boundCompletionSurface(named);
}

/**
 * The completion report PLUS the premature-surrender counterweight. When a settled DONE leg's report
 * carries a surrender marker, `scan` returns the note to append (else undefined). The background
 * completion notifier renders through this, so a blocked leg gets the counterweight on the
 * automatic follow-up — the sync `tool_result` hook never sees a background run. Only DONE legs
 * are scanned: a FAILED leg is already surfaced as a failure by {@link buildCompletionReport},
 * so the guard and the append agree (no done-vs-all mismatch). `scan` is injected
 * (PersistenceNudge.scan) to keep this module decoupled from the nudge.
 */
export function renderCompletion(
	runs: AsyncRun[],
	fence: (text: string) => string,
	scan: (text: string) => string | undefined,
): string {
	const report = buildCompletionReport(runs, fence);
	const doneOutput = runs
		.filter((r) => r.status === "done")
		.map((r) => getFullRunOutput(r))
		.join("\n");
	const note = scan(doneOutput);
	return boundCompletionSurface(note ? `${report}\n\n${note}` : report);
}

/** How many consecutive empty renders of the SAME batch are retried before it is released. A
 *  renderer returning "" for a non-empty batch is a bug, so the batch is put back — but the retry
 *  timer is deliberately ref'd, so an unbounded requeue would spin (and hold the host process open)
 *  for the rest of the session. */
export const MAX_EMPTY_RENDER_RETRIES = 3;

export interface IdleNotifierDeps<T> {
	/** Whether the supervisor is idle (not streaming a turn). */
	isIdle: () => boolean;
	/** Deliver the coalesced message. Async rejection is treated exactly like a synchronous throw:
	 *  the batch is restored at the front of the queue and retried. */
	deliver: (message: string) => void | Promise<void>;
	/** Render a batch of buffered items into one message. */
	render: (items: T[]) => string;
	/** Schedule a callback; returns a handle. Injected so the clock is controllable in tests. */
	setTimer: (fn: () => void, ms: number) => unknown;
	/** Cancel a scheduled callback. */
	clearTimer: (handle: unknown) => void;
	/** Coalesce window for a burst of items (default 150ms). */
	debounceMs?: number;
	/** Re-poll cadence while the supervisor is busy (default 400ms). */
	retryMs?: number;
	/** Floor (ms) between successive deliveries — a flush due sooner re-arms for the remainder instead
	 *  of delivering, WITHOUT dropping what's buffered. Unset ⇒ no floor. */
	minIntervalMs?: number;
	/** Once this many deliveries have gone out, further flushes retain the buffer until
	 *  {@link IdleCoalescingNotifier.resetDeliveries} reopens the gate. Unset ⇒ no ceiling. */
	maxDeliveries?: number;
	/** Maximum queued items rendered into one delivery. Remaining items stay ordered in the queue
	 * and are scheduled for a later flush; unset preserves the normal whole-burst coalescing.
	 * A function receives the queue (in order) and returns how many LEADING items this delivery may
	 * carry — for a channel whose per-delivery budget is measured in content, not in items, so the
	 * drain keeps pace with small items instead of being pinned to the worst case. Either form is
	 * clamped to at least one item: a queue must always drain. */
	maxBatchItems?: number | ((pending: readonly T[]) => number);
	/** Whether a buffered item may be delivered yet. A held item stays buffered (peekable, discardable)
	 *  and is not polled: it ships on the first flush after the `notify()`/`kick()` that made it ready.
	 *  Unset ⇒ everything is ready. */
	isReady?: (item: T) => boolean;
	/** Clock hook, injected for deterministic tests (defaults to `Date.now`). */
	now?: () => number;
}

/**
 * Coalesces items into a single supervisor message, delivered only while the supervisor is idle.
 * A stale host follow-up is NOT a blocker: an idle delivery starts the clean turn that can drain it.
 * Self-healing: while busy it re-arms; sync throws and async rejections restore the whole batch.
 * Used for async-run completions (a batch's members held until the last one settles) and child
 * intercom asks.
 */
export class IdleCoalescingNotifier<T> {
	private readonly deps: IdleNotifierDeps<T>;
	private readonly pending: T[] = [];
	private handle: unknown;
	private readonly debounceMs: number;
	private readonly retryMs: number;
	private readonly minIntervalMs: number | undefined;
	private readonly maxDeliveries: number | undefined;
	private readonly maxBatchItems: ((pending: readonly T[]) => number) | undefined;
	private readonly now: () => number;
	private lastDeliveredAt = 0;
	private deliveries = 0;
	/** Consecutive empty renders since the last successful one — the {@link MAX_EMPTY_RENDER_RETRIES}
	 *  budget. Reset by any render that produces text, so a transient bug costs nothing later. */
	private emptyRenders = 0;
	/** One awaitable delivery at a time. Void deliveries stay on the synchronous fast path. */
	private flushing: Promise<void> | undefined;
	/** The batch currently handed to an async host delivery. Explicit collection can remove an item
	 *  from a later retry, even after the batch has left `pending` (the synchronous Pi delivery path
	 * has no interleaving window, but test/RPC hosts may return a promise). */
	private activeBatch: T[] | undefined;
	/** Invalidates an in-flight batch when cancel() tears down/reuses this notifier. */
	private generation = 0;

	constructor(deps: IdleNotifierDeps<T>) {
		this.deps = deps;
		this.debounceMs = deps.debounceMs ?? 150;
		this.retryMs = deps.retryMs ?? 400;
		this.minIntervalMs = deps.minIntervalMs;
		this.maxDeliveries = deps.maxDeliveries;
		const batchLimit = deps.maxBatchItems;
		this.maxBatchItems = typeof batchLimit === "function"
			? batchLimit
			: batchLimit !== undefined && Number.isFinite(batchLimit)
				? ((): number => Math.max(1, Math.floor(batchLimit)))
				: undefined;
		this.now = deps.now ?? Date.now;
	}

	/** Buffer an item and arm a coalesced flush. */
	notify(item: T): void {
		this.pending.push(item);
		this.arm(this.debounceMs);
	}

	/** Cancel any armed flush AND drop buffered items (reload hygiene — never leak a timer or a
	 *  previous session's undelivered items across sessions; the instance may be reused). */
	cancel(): void {
		this.generation += 1;
		this.clearArmedTimer();
		this.pending.length = 0;
	}

	/** A snapshot of the buffered-but-not-yet-delivered items (e.g. runs that SETTLED but whose
	 *  follow-up hasn't flushed yet). Lets `intercom peek` surface results in the
	 *  settle→deliver gap instead of reporting nothing. Peeking does not collect: only an explicit
	 *  `result` `discard`s the item so the pending flush won't re-deliver it. */
	peekPending(): T[] {
		return [...this.pending];
	}

	/** Drop buffered items matching `pred` — e.g. results the supervisor already collected
	 *  explicitly (intercom `result`), which must not be re-delivered as a follow-up. */
	discard(pred: (item: T) => boolean): void {
		for (let i = this.pending.length - 1; i >= 0; i--) {
			if (pred(this.pending[i] as T)) this.pending.splice(i, 1);
		}
		if (this.activeBatch) {
			for (let i = this.activeBatch.length - 1; i >= 0; i--) {
				if (pred(this.activeBatch[i] as T)) this.activeBatch.splice(i, 1);
			}
		}
		if (this.pending.length === 0) this.clearArmedTimer();
	}

	/** Clear the `maxDeliveries` ceiling and immediately retry anything held behind it. */
	resetDeliveries(): void {
		this.deliveries = 0;
		if (this.pending.length > 0) this.kick();
	}

	/** Public idle-transition hook. Safe to call repeatedly (e.g. from `agent_settled`): async
	 *  deliveries share one flight; synchronous deliveries complete before this method returns. */
	flushIfIdle(): Promise<void> {
		if (this.flushing) return this.flushing;
		this.clearArmedTimer();
		const ready = this.readyItems();
		if (ready.length === 0) return Promise.resolve();

		const generation = this.generation;
		let batch: T[] | undefined;
		try {
			// Do NOT gate an idle supervisor on its host queue. A stale follow-up can survive an
			// aborted/errored turn; starting this clean turn is what lets the host drain it.
			if (!this.deps.isIdle()) {
				this.arm(this.retryMs);
				return Promise.resolve();
			}
			// A delivery ceiling is a rate limit, never a drop policy. Keep the buffer alive until
			// resetDeliveries() reopens the gate (the retry is also a liveness fallback).
			if (this.maxDeliveries !== undefined && this.deliveries >= this.maxDeliveries) {
				this.arm(this.retryMs);
				return Promise.resolve();
			}
			if (this.minIntervalMs !== undefined && this.deliveries > 0) {
				const elapsed = this.now() - this.lastDeliveredAt;
				if (elapsed < this.minIntervalMs) {
					this.arm(this.minIntervalMs - elapsed);
					return Promise.resolve();
				}
			}

			const take = this.maxBatchItems === undefined ? ready.length : Math.max(1, Math.floor(this.maxBatchItems(ready)));
			batch = ready.slice(0, take);
			for (const item of batch) this.pending.splice(this.pending.indexOf(item), 1);
			const message = this.deps.render(batch);
			if (!message) {
				// Empty text from a non-empty batch is a renderer failure, not an acknowledgement: put the
				// batch back at the front so a TRANSIENT formatter bug cannot silently discard comms. A
				// persistently empty renderer is a different problem — retry a bounded number of times,
				// then let the batch go rather than re-arm forever against a bug no retry will fix.
				this.emptyRenders += 1;
				if (this.emptyRenders <= MAX_EMPTY_RENDER_RETRIES) {
					this.pending.unshift(...batch);
				} else {
					this.emptyRenders = 0;
					if (process.env.PI_PERSONA_DEBUG) {
						process.stderr.write(`[pi-persona] notifier released ${batch.length} item(s): renderer returned empty text ${MAX_EMPTY_RENDER_RETRIES + 1}x\n`);
					}
				}
				this.arm(this.retryMs);
				return Promise.resolve();
			}
			this.emptyRenders = 0;
			this.activeBatch = batch;
			const delivery = this.deps.deliver(message);
			if (!delivery || typeof (delivery as PromiseLike<void>).then !== "function") {
				this.activeBatch = undefined;
				if (generation === this.generation) {
					this.lastDeliveredAt = this.now();
					this.deliveries += 1;
					if (this.pending.length > 0) this.arm(this.retryMs);
				}
				return Promise.resolve();
			}

			let flight!: Promise<void>;
			flight = Promise.resolve(delivery)
				.then(() => {
					if (generation !== this.generation) return;
					this.lastDeliveredAt = this.now();
					this.deliveries += 1;
				})
				.catch(() => {
					const retryBatch = this.activeBatch === batch ? this.activeBatch : batch;
					this.activeBatch = undefined;
					if (generation !== this.generation) return;
					this.pending.unshift(...(retryBatch as T[]));
					this.arm(this.retryMs);
				})
				.finally(() => {
					if (this.activeBatch === batch) this.activeBatch = undefined;
					if (this.flushing === flight) this.flushing = undefined;
					if (this.pending.length > 0 && this.handle === undefined) this.arm(this.retryMs);
				});
			this.flushing = flight;
			return flight;
		} catch {
			const retryBatch = this.activeBatch === batch ? this.activeBatch : batch;
			this.activeBatch = undefined;
			if (generation === this.generation) {
				if (retryBatch) this.pending.unshift(...retryBatch);
				this.arm(this.retryMs);
			}
			return Promise.resolve();
		}
	}

	/** Fire-and-forget alias for event hooks and timer callbacks. */
	kick(): void {
		void this.flushIfIdle();
	}

	private clearArmedTimer(): void {
		if (this.handle === undefined) return;
		this.deps.clearTimer(this.handle);
		this.handle = undefined;
	}

	/** The buffered items that may be delivered now, in order. */
	private readyItems(): T[] {
		const { isReady } = this.deps;
		return isReady ? this.pending.filter(isReady) : [...this.pending];
	}

	private arm(ms: number): void {
		if (this.handle !== undefined || this.readyItems().length === 0) return;
		let scheduled!: unknown;
		scheduled = this.deps.setTimer(() => {
			if (this.handle !== scheduled) return; // cancelled/replaced timer racing its callback
			this.handle = undefined;
			this.kick();
		}, ms);
		this.handle = scheduled;
		// Delivery is an outstanding obligation. Re-ref a host timer that the wiring created
		// unref'd; cancel() remains the explicit lifecycle escape hatch.
		const ref = (scheduled as { ref?: () => void } | null | undefined)?.ref;
		if (typeof ref === "function") ref.call(scheduled);
	}
}

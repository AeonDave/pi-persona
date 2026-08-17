/**
 * Async run tracking (v0.3). A supervisor can launch a child in the background,
 * keep working, peek its live progress, and be notified on completion — without
 * blocking the turn. Backend-agnostic: the `run` thunk is injected (real engine
 * or stub), so this is fully unit-testable.
 *
 * NOTE: live *steering* of a running child-process agent (resume/redirect) needs
 * the cross-process broker (v0.5) or the InProcessEngine (v0.4). This module
 * covers launch + peek + completion-notify (the parts that work on `pi -p`).
 */

import type { ProgressSnapshot } from "./stream.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { MAX_DISPLAY_LABEL_CHARS, sanitizeDisplayLabel } from "../core/display-label.ts";

export { MAX_DISPLAY_LABEL_CHARS } from "../core/display-label.ts";

export interface AsyncRun {
	id: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed" | "stopped";
	progress: ProgressSnapshot;
	result?: AgentResult;
	error?: string;
	/** The codename the launcher gave this run (e.g. "atlas-static") — the SAME name shown on the
	 *  agent-tree node for this run. When set, it's the canonical display name (over the bare
	 *  `agent` type); absent for call sites that don't carry one (falls back to `agent`). */
	label?: string;
	/** The already-shortened model (e.g. "sonnet") this run was launched with — kept pre-shortened
	 *  so this module needs no import from delegate.ts just to render it. */
	model?: string;
	/** Clock (ms) of the last time `progress` actually *advanced* (output grew, or turns/tokens
	 *  rose) — NOT merely the last event. A worker looping without headway keeps emitting but
	 *  never bumps this, so `now - lastAdvanceAt` is what tells "working" from "stuck". */
	lastAdvanceAt?: number;
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
	private seq = 0;
	private readonly maxRetained: number;
	private readonly now: () => number;

	/** `now` is injected so the stall clock is deterministic under test (real time by default).
	 *  `maxRetained` (default 25 — today's hardcoded bound) is the config-driven PI_PERSONA_ASYNC_RETAIN
	 *  knob's landing spot: how many settled-but-uncollected runs survive before FIFO-eviction. */
	constructor(opts?: { now?: () => number; maxRetained?: number }) {
		this.now = opts?.now ?? ((): number => Date.now());
		this.maxRetained = opts?.maxRetained ?? 25;
	}

	launch(meta: { agent: string; task: string; label?: string; model?: string; mutates?: boolean }, run: RunThunk): string {
		this.seq += 1;
		const id = `run-${this.seq.toString(36)}`;
		const entry: AsyncRun = {
			id,
			agent: meta.agent,
			task: meta.task,
			status: "running",
			progress: { output: "", turns: 0, tokens: 0 },
			lastAdvanceAt: this.now(),
		};
		if (meta.mutates) entry.mutates = true;
		// Labels/models are rendered as trusted status metadata on several compact surfaces. Normalize
		// once at the tracker boundary so a caller cannot smuggle multiline instructions into any of
		// those views; renderers still sanitize defensively when they compose a label.
		if (meta.label !== undefined) entry.label = sanitizeDisplayLabel(meta.label);
		if (meta.model !== undefined) entry.model = sanitizeDisplayLabel(meta.model, "model");
		this.runs.set(id, entry);

		const settle = (): void => this.settleOnce(entry);
		// `Promise.resolve(run(...))` routes BOTH a returned rejection AND a SYNCHRONOUS throw from
		// the thunk (e.g. the engine throwing before it returns its promise) through the same failure
		// path, so onComplete always fires — otherwise the entry would be stuck "running" forever and
		// its stop/steer handle would leak.
		try {
			Promise.resolve(
				run((s) => {
					// Only a REAL advance (more output, or a higher turn/token count) resets the stall
					// clock — a repeated identical snapshot from a spinning worker must not mask a stall.
					const prev = entry.progress;
					if (s.output.length > prev.output.length || s.tokens > prev.tokens || s.turns > prev.turns) {
						entry.lastAdvanceAt = this.now();
					}
					entry.progress = s;
				}, id),
			)
				.then((result) => {
					if (entry.settled) return; // force-settled by the supervisor — drop the late natural result
					entry.status = result.ok ? "done" : result.failureKind === "abort" ? "stopped" : "failed";
					entry.result = result;
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
		this.settledOrder.push(entry.id);
		this.prune();
		// Iterate a SNAPSHOT: a waitFor join unsubscribes from inside its own listener, and
		// splicing the live array under the cursor would shift the next join's listener past it.
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

	onComplete(cb: (run: AsyncRun) => void): () => void {
		this.completeListeners.push(cb);
		return () => {
			const i = this.completeListeners.indexOf(cb);
			if (i >= 0) this.completeListeners.splice(i, 1);
		};
	}

	/**
	 * Wait (join) until every listed run settles, or `timeoutMs` elapses — never rejects:
	 * it resolves with the runs' CURRENT states, so the caller reports what settled and
	 * what is still going. Backs the `intercom wait` action (the supervisor holds its turn
	 * to collect async results it now needs before its next step).
	 */
	waitFor(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<AsyncRun[]> {
		const targets = ids.map((id) => this.runs.get(id)).filter((r): r is AsyncRun => r !== undefined);
		if (targets.every((r) => r.status !== "running")) return Promise.resolve(targets);
		return new Promise((resolve) => {
			let off = (): void => {};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				off();
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolve(targets);
			};
			off = this.onComplete(() => {
				if (targets.every((r) => r.status !== "running")) finish();
			});
			timer = setTimeout(finish, timeoutMs);
			timer.unref?.();
			if (signal) {
				if (signal.aborted) finish();
				else signal.addEventListener("abort", finish, { once: true });
			}
		});
	}
}

/**
 * A compact ProgressView digest of async runs — the full on-demand `/peek` view, and the body the
 * routine check-in wraps ({@link buildCheckIn}). When `opts` carries the current clock + a stall
 * window, a RUNNING run that hasn't advanced within that window is flagged "possibly stuck". The
 * periodic FAST wakeup does NOT send this digest — it sends the focused {@link buildPeekAlert}.
 */
export function dedupeRunsById(runs: AsyncRun[]): AsyncRun[] {
	const byId = new Map<string, AsyncRun>();
	for (const r of runs) if (!byId.has(r.id)) byId.set(r.id, r);
	return [...byId.values()];
}

/** Compact token count for the status digests — 164005 → "164k", 1_234_567 → "1.2M". Exported so
 *  every OTHER raw token render (the agent-tree details in extension.ts) goes through the same
 *  compaction instead of drifting into its own raw `${n} tok` string. */
export function compactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

/** One identity everywhere a tracked run is rendered: the launcher's codename when present,
 *  otherwise the agent type, with the already-shortened model appended once. */
function runDisplayName(run: AsyncRun): string {
	const model = run.model === undefined ? undefined : sanitizeDisplayLabel(run.model, "model", 24);
	if (model === undefined) return sanitizeDisplayLabel(run.label ?? run.agent);
	const suffix = ` · ${model}`;
	const nameLimit = Math.max(1, MAX_DISPLAY_LABEL_CHARS - suffix.length);
	return `${sanitizeDisplayLabel(run.label ?? run.agent, "agent", nameLimit)}${suffix}`;
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

/** A timeout is a status update, not an invitation to poll. The passive completion notifier is
 * the normal delivery path, so send the supervisor back to useful work and reserve peek/steer/stop
 * for intervention. */
export function buildWaitTimeoutNote(ids: readonly string[], timeoutMs: number): string {
	const visibleIds = ids.slice(0, MAX_ASYNC_STATUS_ROWS);
	const omitted = ids.length - visibleIds.length;
	const idSummary = `${visibleIds.join(", ")}${omitted > 0 ? `, … +${omitted} more` : ""}`;
	return (
		`⏳ still running after ${timeoutMs}ms: ${idSummary}. ` +
		"Continue useful supervisor work; completion will notify you automatically. " +
		"Use peek only when status is needed, steer to redirect, or stop a truly stalled run — do not immediately wait again."
	);
}

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

export function buildPeekDigest(runs: AsyncRun[], opts?: { now?: number; stallMs?: number }): string {
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
			let line = `${head} (${r.progress.turns} turns, ${compactTokens(r.progress.tokens)} tok)`;
			if (now !== undefined && stallMs !== undefined && stallMs > 0 && r.lastAdvanceAt !== undefined) {
				const stalledFor = now - r.lastAdvanceAt;
				if (stalledFor >= stallMs) line += ` ⚠ possibly stuck (no progress for ${Math.round(stalledFor / 1000)}s)`;
			}
			return line;
		}
		// Peek is a ProgressView that can be returned directly as a tool result or injected into a
		// routine follow-up. Never put child-authored output or error text on this path: even a short
		// preview is an untrusted prompt-injection carrier. The explicit result action is the fenced,
		// on-demand surface for details.
		if (r.status === "failed") return `${head}: failure details available via intercom result (to: ${r.id})`;
		if (r.result) return `${head}: full result available via intercom result (to: ${r.id})`;
		return head;
	});
	const omitted = runs.length - visibleRuns.length;
	if (omitted > 0) lines.push(`… ${omitted} additional async runs omitted from this bounded status view.`);
	return [`Async runs: ${runs.length} (${running} running)`, ...lines].join("\n");
}

/**
 * Turns the periodic peek from a poll into an EXCEPTION signal. Tracks which running legs have already
 * been surfaced as stalled, so the supervisor is woken ONCE when a leg crosses the stall window — never
 * every tick while it stays stalled, and never at all while it is making progress. A leg that advances
 * again (its `lastAdvanceAt` moves) re-arms, so a later stall re-alerts; legs that leave the list are
 * forgotten. Pure w.r.t. the injected `now`, so it is unit-tested without a real clock.
 */
export class PeekWatcher {
	/** runId → the `lastAdvanceAt` value at which we reported it stalled (a later advance re-arms). */
	private readonly reportedAt = new Map<string, number>();

	/** The running legs that have NEWLY crossed the stall window since we last reported them. */
	poll(runs: AsyncRun[], now: number, stallMs: number): AsyncRun[] {
		const live = new Set<string>();
		const newlyStuck: AsyncRun[] = [];
		for (const r of runs) {
			if (r.status !== "running" || r.lastAdvanceAt === undefined) continue;
			live.add(r.id);
			const prev = this.reportedAt.get(r.id);
			if (prev !== undefined && r.lastAdvanceAt > prev) this.reportedAt.delete(r.id); // advanced ⇒ re-arm
			if (stallMs > 0 && now - r.lastAdvanceAt >= stallMs && !this.reportedAt.has(r.id)) {
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

/**
 * The periodic peek's wake message for a batch of NEWLY-stalled legs (from {@link PeekWatcher}), or ""
 * when none. Unlike {@link buildPeekDigest} (the full, on-demand `/peek` view), this is an exception
 * signal, not a status dump: a long operation looks identical to a stall from outside, so the framing is
 * patience-first, and intervention means asking the leg — never reaching into its environment to check.
 */
export function buildPeekAlert(stuck: AsyncRun[], opts: { now: number }): string {
	if (stuck.length === 0) return "";
	const visibleStuck = stuck.slice(0, MAX_ASYNC_STATUS_ROWS);
	const lines = visibleStuck.map((r) => {
		const secs = Math.round((opts.now - (r.lastAdvanceAt ?? opts.now)) / 1000);
		return `⚠ ${r.id} (${runDisplayName(r)}) — no visible progress for ${secs}s (${r.progress.turns} turns, ${compactTokens(r.progress.tokens)} tok)`;
	});
	const omitted = stuck.length - visibleStuck.length;
	if (omitted > 0) lines.push(`… ${omitted} additional stalled-run alerts omitted from this bounded view.`);
	return [
		`${stuck.length} background ${stuck.length === 1 ? "leg" : "legs"} may be stalled:`,
		...lines,
		"A long operation (a slow scan, a big generation, a blocking command) looks the same as a stall from out here. " +
			"If it's likely still working, leave it — the result returns to you as a follow-up. If you think it's genuinely " +
			"wedged, ask the leg for a one-line status (a light `steer`) or `stop` it — don't run commands in its environment to check.",
	].join("\n");
}

/**
 * The routine check-in: the full progress view ({@link buildPeekDigest}) plus a one-line framing that
 * this is an occasional glance, not a poll — step in only if a leg is off-track or wedged, otherwise
 * carry on. It fires on the slow check-in cadence (config.checkInEveryMs) and is the counterpart to the
 * fast {@link buildPeekAlert} stall signal: it catches a leg going the WRONG way (not stalled, just
 * wrong) before it burns the budget, without waking the supervisor every tick.
 */
export function buildCheckIn(runs: AsyncRun[], opts: { now: number; stallMs: number }): string {
	return (
		`${buildPeekDigest(runs, opts)}\n\n` +
		"Routine check-in — glance at where your legs are and step in only if one is off-track (wrong " +
		"target, rabbit hole) or wedged. If they're progressing, carry on; each result returns to you on its own."
	);
}

/**
 * Build ONE consolidated supervisor notice for a batch of settled async runs. Coalescing a
 * burst into a single message is what keeps completions from piling up as separate queued
 * follow-ups (pi renders one sticky line per queued message); the explicit guidance keeps the
 * supervisor from blindly re-issuing a delegation that just failed. `fence` wraps untrusted
 * sub-agent text so the supervisor treats it as data, never as instructions.
 */
export function buildCompletionReport(runs: AsyncRun[], fence: (text: string) => string): string {
	const done = runs.filter((r) => r.status === "done");
	const failed = runs.filter((r) => r.status === "failed");
	const stopped = runs.filter((r) => r.status === "stopped");
	// Share the notification budget across every leg that can contribute payload. This keeps a
	// large fan-out fair: the first result cannot consume the whole follow-up while later statuses
	// are still waiting to be rendered. The final report cap remains a hard backstop for metadata.
	const payloadRuns = runs.filter((r) => r.status === "done" || r.progress.output.trim());
	const fairRunChars = Math.min(
		MAX_COMPLETION_RUN_CHARS,
		Math.max(256, Math.floor(MAX_COMPLETION_REPORT_CHARS / Math.max(1, payloadRuns.length * 2))),
	);
	// Failures are always reported — the supervisor must know so it can adjust or tell
	// the user. Blind retry loops are prevented at RUNTIME by the DelegationLedger
	// (an identical delegation that failed twice is vetoed before it spawns), not by
	// hiding information.
	// First line stays short and informative — pi's queued-message UI shows only this line, truncated.
	const stoppedCount = stopped.length > 0 ? `, ${stopped.length} stopped` : "";
	const head = `[pi-persona] ${runs.length} async run${runs.length === 1 ? "" : "s"} settled — ${done.length} done, ${failed.length} failed${stoppedCount}`;
	const blocks: string[] = [head];
	for (const r of done) {
		// Only fence REAL output — an empty/whitespace result gets a plain "(no output)", never an
		// empty <fence></fence> shell (there's nothing untrusted to guard, and the empty block reads
		// as clutter).
		const full = getFullRunOutput(r);
		const body = full !== "(no output)" ? fence(clipRunOutput(full, r.id, fairRunChars)) : "(no output)";
		blocks.push(`\n✅ ${r.id} (${runDisplayName(r)}) done:\n${body}`);
	}
	if (stopped.length > 0) {
		const reasons = stopped.map((r) => `• ${r.id} (${runDisplayName(r)}): ${r.error ?? "stopped by supervisor"}`).join("\n");
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
		const reasons = failed.map((r) => `• ${r.id} (${runDisplayName(r)}): ${r.error ?? "(no detail)"}`).join("\n");
		blocks.push(
			`\n❌ ${failed.length} failed:\n${fence(clipRunOutput(reasons, "failures", fairRunChars))}\n\n` +
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
	return boundCompletionSurface(blocks.join("\n"));
}

/**
 * The completion report PLUS the premature-surrender counterweight. When a settled DONE leg's report
 * carries a surrender marker, `scan` returns the note to append (else undefined). BOTH the background
 * completion notifier and the `intercom wait` join render through this, so a blocked leg gets the
 * same counterweight however it is collected — the sync `tool_result` hook never sees a background
 * run. Only DONE legs are scanned: a FAILED leg is already surfaced as a failure by
 * {@link buildCompletionReport}, so the guard and the append agree (no done-vs-all mismatch). `scan`
 * is injected (PersistenceNudge.scan) to keep this module decoupled from the nudge.
 */
export function renderCompletion(
	runs: AsyncRun[],
	fence: (text: string) => string,
	scan: (text: string) => string | undefined,
): string {
	const report = buildCompletionReport(runs, fence);
	const doneOutput = runs
		.filter((r) => r.status === "done")
		.map((r) => r.result?.output ?? "")
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
	/** Legacy host-queue probe. Retained for source compatibility, but deliberately ignored: when
	 *  the supervisor is idle, starting a turn is what drains any orphaned host follow-ups. */
	hasPending?: () => boolean;
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
	/** Clock hook, injected for deterministic tests (defaults to `Date.now`). */
	now?: () => number;
}

/**
 * Coalesces items into a single supervisor message, delivered only while the supervisor is idle.
 * A stale host follow-up is NOT a blocker: an idle delivery starts the clean turn that can drain it.
 * Self-healing: while busy it re-arms; sync throws and async rejections restore the whole batch.
 * Used for async-run completions and child intercom asks.
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
	 *  follow-up hasn't flushed yet). Lets `intercom wait`/`peek` surface results in the
	 *  settle→deliver gap instead of reporting nothing; the caller `discard`s what it collects so
	 *  the pending flush won't re-deliver it. */
	peekPending(): T[] {
		return [...this.pending];
	}

	/** Drop buffered items matching `pred` — e.g. results the supervisor already collected
	 *  synchronously (intercom `wait`), which must not be re-delivered as a follow-up. */
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
		if (this.pending.length === 0) return Promise.resolve();

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

			const take = this.maxBatchItems === undefined ? this.pending.length : Math.max(1, Math.floor(this.maxBatchItems(this.pending)));
			batch = this.pending.splice(0, take);
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

	private arm(ms: number): void {
		if (this.handle !== undefined || this.pending.length === 0) return;
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

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

export interface AsyncRun {
	id: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed";
	progress: ProgressSnapshot;
	result?: AgentResult;
	error?: string;
	/** Clock (ms) of the last time `progress` actually *advanced* (output grew, or turns/tokens
	 *  rose) — NOT merely the last event. A worker looping without headway keeps emitting but
	 *  never bumps this, so `now - lastAdvanceAt` is what tells "working" from "stuck". */
	lastAdvanceAt?: number;
}

/** The run's id is passed in so the launcher can wire a steer handle keyed by it. */
export type RunThunk = (onProgress: (snapshot: ProgressSnapshot) => void, runId: string) => Promise<AgentResult>;

export class AsyncRunTracker {
	private readonly runs = new Map<string, AsyncRun>();
	private readonly completeListeners: Array<(run: AsyncRun) => void> = [];
	private seq = 0;
	private readonly maxRetained = 25;
	private readonly now: () => number;

	/** `now` is injected so the stall clock is deterministic under test (real time by default). */
	constructor(opts?: { now?: () => number }) {
		this.now = opts?.now ?? ((): number => Date.now());
	}

	launch(meta: { agent: string; task: string }, run: RunThunk): string {
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
		this.runs.set(id, entry);

		const settle = (): void => {
			this.prune();
			for (const cb of this.completeListeners) cb(entry);
		};
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
					entry.status = result.ok ? "done" : "failed";
					entry.result = result;
					if (!result.ok && result.error) entry.error = result.error;
				})
				.catch((err: unknown) => {
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

	/** Keep the map bounded by evicting the oldest *completed* runs (FIFO). */
	private prune(): void {
		if (this.runs.size <= this.maxRetained) return;
		for (const [id, run] of this.runs) {
			if (this.runs.size <= this.maxRetained) break;
			if (run.status !== "running") this.runs.delete(id);
		}
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
export function buildPeekDigest(runs: AsyncRun[], opts?: { now?: number; stallMs?: number }): string {
	if (runs.length === 0) return "No async runs.";
	const running = runs.filter((r) => r.status === "running").length;
	const now = opts?.now;
	const stallMs = opts?.stallMs;
	const lines = runs.map((r) => {
		const head = `[${r.id}] ${r.agent} — ${r.status}`;
		if (r.status === "running") {
			let line = `${head} (${r.progress.turns} turns, ${r.progress.tokens} tok)`;
			if (now !== undefined && stallMs !== undefined && stallMs > 0 && r.lastAdvanceAt !== undefined) {
				const stalledFor = now - r.lastAdvanceAt;
				if (stalledFor >= stallMs) line += ` ⚠ possibly stuck (no progress for ${Math.round(stalledFor / 1000)}s)`;
			}
			return line;
		}
		// A failed run's WHY is its error, not its (usually empty) output.
		if (r.status === "failed") return `${head}${r.error ? `: ${r.error}` : ""}`;
		if (r.result) return `${head}: ${r.result.output.slice(0, 80).replace(/\s+/g, " ")}`;
		return head;
	});
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
	const lines = stuck.map((r) => {
		const secs = Math.round((opts.now - (r.lastAdvanceAt ?? opts.now)) / 1000);
		return `⚠ ${r.id} (${r.agent}) — no visible progress for ${secs}s (${r.progress.turns} turns, ${r.progress.tokens} tok)`;
	});
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
	// Failures are always reported — the supervisor must know so it can adjust or tell
	// the user. Blind retry loops are prevented at RUNTIME by the DelegationLedger
	// (an identical delegation that failed twice is vetoed before it spawns), not by
	// hiding information.
	// First line stays short and informative — pi's queued-message UI shows only this line, truncated.
	const head = `[pi-persona] ${runs.length} async run${runs.length === 1 ? "" : "s"} settled — ${done.length} done, ${failed.length} failed`;
	const blocks: string[] = [head];
	for (const r of done) {
		blocks.push(`\n✅ ${r.id} (${r.agent}) done:\n${fence(r.result?.output ?? "(no output)")}`);
	}
	if (failed.length > 0) {
		const reasons = failed.map((r) => `• ${r.id} (${r.agent}): ${r.error ?? "(no detail)"}`).join("\n");
		blocks.push(
			`\n❌ ${failed.length} failed:\n${fence(reasons)}\n\n` +
				"Handle each failure deliberately: retry ONCE with a different model or approach, or report it to the user. " +
				"Do not re-issue the same failing delegation repeatedly.",
		);
	}
	return blocks.join("\n");
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
	return note ? `${report}\n\n${note}` : report;
}

export interface IdleNotifierDeps<T> {
	/** Whether the supervisor is idle (not streaming a turn). */
	isIdle: () => boolean;
	/** Whether the supervisor already has queued messages waiting. */
	hasPending: () => boolean;
	/** Deliver the coalesced message (e.g. pi.sendUserMessage); may throw if it races a turn. */
	deliver: (message: string) => void;
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
}

/**
 * Coalesces items into a single supervisor message, delivered ONLY while the supervisor is idle
 * and unqueued. Rationale: pi drains its follow-up queue only from an active turn (one-at-a-time,
 * and an errored/aborted turn skips the drain), so a message injected mid-stream can strand as an
 * orphaned "sticky" queued message. An idle delivery always starts a fresh turn, so the message
 * both reaches the supervisor (it can react) and never piles up. Self-healing: while busy it
 * re-arms; on a delivery race it requeues. Used for async-run completions and child intercom asks.
 */
export class IdleCoalescingNotifier<T> {
	private readonly deps: IdleNotifierDeps<T>;
	private readonly pending: T[] = [];
	private handle: unknown;
	private readonly debounceMs: number;
	private readonly retryMs: number;

	constructor(deps: IdleNotifierDeps<T>) {
		this.deps = deps;
		this.debounceMs = deps.debounceMs ?? 150;
		this.retryMs = deps.retryMs ?? 400;
	}

	/** Buffer an item and arm a coalesced flush. */
	notify(item: T): void {
		this.pending.push(item);
		this.arm(this.debounceMs);
	}

	/** Cancel any armed flush AND drop buffered items (reload hygiene — never leak a timer or a
	 *  previous session's undelivered items across sessions; the instance may be reused). */
	cancel(): void {
		if (this.handle !== undefined) {
			this.deps.clearTimer(this.handle);
			this.handle = undefined;
		}
		this.pending.length = 0;
	}

	/** Drop buffered items matching `pred` — e.g. results the supervisor already collected
	 *  synchronously (intercom `wait`), which must not be re-delivered as a follow-up. */
	discard(pred: (item: T) => boolean): void {
		for (let i = this.pending.length - 1; i >= 0; i--) {
			if (pred(this.pending[i] as T)) this.pending.splice(i, 1);
		}
	}

	private arm(ms: number): void {
		if (this.handle !== undefined) return; // a flush is already pending; the new item rides it
		this.handle = this.deps.setTimer(() => {
			this.handle = undefined;
			this.flush();
		}, ms);
	}

	private flush(): void {
		if (this.pending.length === 0) return;
		// Only deliver to an idle, unqueued supervisor: an idle delivery always triggers a turn (so
		// the message can't strand) and we never inject into a streaming window (which is what left
		// the orphaned sticky follow-ups). Otherwise wait and re-check.
		if (!this.deps.isIdle() || this.deps.hasPending()) {
			this.arm(this.retryMs);
			return;
		}
		const batch = this.pending.splice(0, this.pending.length);
		const message = this.deps.render(batch);
		if (!message) return; // render suppressed this batch (e.g. all failures) — nothing to deliver
		try {
			this.deps.deliver(message);
		} catch {
			this.pending.unshift(...batch); // raced a just-started turn — retry when idle
			this.arm(this.retryMs);
		}
	}
}

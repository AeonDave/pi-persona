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
}

/** The run's id is passed in so the launcher can wire a steer handle keyed by it. */
export type RunThunk = (onProgress: (snapshot: ProgressSnapshot) => void, runId: string) => Promise<AgentResult>;

export class AsyncRunTracker {
	private readonly runs = new Map<string, AsyncRun>();
	private readonly completeListeners: Array<(run: AsyncRun) => void> = [];
	private seq = 0;
	private readonly maxRetained = 25;

	launch(meta: { agent: string; task: string }, run: RunThunk): string {
		this.seq += 1;
		const id = `run-${this.seq.toString(36)}`;
		const entry: AsyncRun = {
			id,
			agent: meta.agent,
			task: meta.task,
			status: "running",
			progress: { output: "", turns: 0, tokens: 0 },
		};
		this.runs.set(id, entry);

		run((s) => {
			entry.progress = s;
		}, id)
			.then((result) => {
				entry.status = result.ok ? "done" : "failed";
				entry.result = result;
				if (!result.ok && result.error) entry.error = result.error;
			})
			.catch((err: unknown) => {
				entry.status = "failed";
				entry.error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				this.prune();
				for (const cb of this.completeListeners) cb(entry);
			});

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

	onComplete(cb: (run: AsyncRun) => void): void {
		this.completeListeners.push(cb);
	}
}

/** A compact ProgressView digest of async runs (for /peek and the periodic peek). */
export function buildPeekDigest(runs: AsyncRun[]): string {
	if (runs.length === 0) return "No async runs.";
	const running = runs.filter((r) => r.status === "running").length;
	const lines = runs.map((r) => {
		const head = `[${r.id}] ${r.agent} — ${r.status}`;
		if (r.status === "running") return `${head} (${r.progress.turns} turns, ${r.progress.tokens} tok)`;
		if (r.result) return `${head}: ${r.result.output.slice(0, 80).replace(/\s+/g, " ")}`;
		return `${head}${r.error ? `: ${r.error}` : ""}`;
	});
	return [`Async runs: ${runs.length} (${running} running)`, ...lines].join("\n");
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

export interface CompletionNotifierDeps {
	/** Whether the supervisor is idle (not streaming a turn). */
	isIdle: () => boolean;
	/** Whether the supervisor already has queued messages waiting. */
	hasPending: () => boolean;
	/** Deliver the report (e.g. pi.sendUserMessage); may throw if it races a just-started turn. */
	deliver: (report: string) => void;
	/** Wrap untrusted sub-agent text as data. */
	fence: (text: string) => string;
	/** Schedule a callback; returns a handle. Injected so the clock is controllable in tests. */
	setTimer: (fn: () => void, ms: number) => unknown;
	/** Cancel a scheduled callback. */
	clearTimer: (handle: unknown) => void;
	/** Coalesce window for a burst of completions (default 150ms). */
	debounceMs?: number;
	/** Re-poll cadence while the supervisor is busy (default 400ms). */
	retryMs?: number;
}

/**
 * Coalesces settled async runs into a single supervisor notice, delivered ONLY while the
 * supervisor is idle and unqueued. Rationale: pi drains its follow-up queue only from an active
 * turn (one-at-a-time, and an errored/aborted turn skips the drain), so a follow-up injected
 * mid-stream can strand as an orphaned "sticky" queued message. An idle delivery always starts a
 * fresh turn, so the notice both reaches the supervisor (it can react — e.g. pick another model)
 * and never piles up. Self-healing: while busy it re-arms; on a delivery race it requeues.
 */
export class CompletionNotifier {
	private readonly deps: CompletionNotifierDeps;
	private readonly pending: AsyncRun[] = [];
	private handle: unknown;
	private readonly debounceMs: number;
	private readonly retryMs: number;

	constructor(deps: CompletionNotifierDeps) {
		this.deps = deps;
		this.debounceMs = deps.debounceMs ?? 150;
		this.retryMs = deps.retryMs ?? 400;
	}

	/** Buffer a settled run and arm a coalesced flush. */
	notify(run: AsyncRun): void {
		this.pending.push(run);
		this.arm(this.debounceMs);
	}

	/** Cancel any armed flush (reload hygiene — never leak a timer across sessions). */
	cancel(): void {
		if (this.handle !== undefined) {
			this.deps.clearTimer(this.handle);
			this.handle = undefined;
		}
	}

	private arm(ms: number): void {
		if (this.handle !== undefined) return; // a flush is already pending; the new run rides it
		this.handle = this.deps.setTimer(() => {
			this.handle = undefined;
			this.flush();
		}, ms);
	}

	private flush(): void {
		if (this.pending.length === 0) return;
		// Only deliver to an idle, unqueued supervisor: an idle delivery always triggers a turn (so
		// the notice can't strand) and we never inject into a streaming window (which is what left
		// the orphaned sticky follow-ups). Otherwise wait and re-check.
		if (!this.deps.isIdle() || this.deps.hasPending()) {
			this.arm(this.retryMs);
			return;
		}
		const batch = this.pending.splice(0, this.pending.length);
		try {
			this.deps.deliver(buildCompletionReport(batch, this.deps.fence));
		} catch {
			this.pending.unshift(...batch); // raced a just-started turn — retry when idle
			this.arm(this.retryMs);
		}
	}
}

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

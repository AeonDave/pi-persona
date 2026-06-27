/**
 * Flow runner (v0.5) — execute a {@link FlowSpec} DAG: run every phase's strategy in
 * dependency order, fanning out phases whose `needs` are all satisfied in parallel,
 * threading each upstream phase's output into its dependents' task. Journals every
 * completed phase (one JSONL line) so a later run can RESUME by skipping done phases. A
 * failed phase blocks its dependents (they can't run without their input). The strategy
 * runner is injected (`deps.runPhase`), so the DAG logic is engine-agnostic and tested
 * with a stub.
 */

import { emptyUsage } from "../engine/stream.ts";
import type { FlowPhase, FlowSpec } from "./flow.ts";
import type { AgentResult } from "./types.ts";

export type PhaseStatus = "running" | "done" | "failed";

/** One phase ready to run: its spec, the built task, and its upstream phases' results. */
export interface FlowPhaseRun {
	phase: FlowPhase;
	task: string;
	upstream: Record<string, AgentResult>;
}

export type RunPhaseFn = (run: FlowPhaseRun) => Promise<AgentResult>;

/** One journal line — appended as each phase completes (for resume). */
export interface FlowJournalEntry {
	phase: string;
	hash: string;
	ok: boolean;
	output: string;
}

export interface FlowRunDeps {
	/** Run one phase's strategy → its result (wraps `runPersonaStrategy` in prod). */
	runPhase: RunPhaseFn;
	/** The pinned `flow@hash` for this run (I3) — recorded in every journal line. */
	hash: string;
	signal?: AbortSignal;
	/** Append one entry as each phase completes. */
	journal?: (entry: FlowJournalEntry) => void;
	/** Phases already completed (from a prior run's journal) — skipped, output reused. */
	resume?: Record<string, AgentResult>;
	/** Live UI: phase lifecycle. */
	onPhase?: (id: string, status: PhaseStatus, result?: AgentResult) => void;
}

export interface FlowOutcome {
	ok: boolean;
	results: Record<string, AgentResult>;
	/** The terminal (sink) phases' combined output — the flow's answer. */
	output: string;
}

/** Build a phase's task: the base task plus each upstream phase's output as context. */
function buildPhaseTask(baseTask: string, spec: FlowSpec, phase: FlowPhase, upstream: Record<string, AgentResult>): string {
	const parts = [`Flow "${spec.name}" — phase "${phase.id}" (strategy: ${phase.strategy}).`, baseTask];
	const ups = Object.entries(upstream);
	if (ups.length > 0) {
		parts.push("\nUpstream results to build on:");
		for (const [id, r] of ups) parts.push(`\n--- ${id} ---\n${r.output}`);
	}
	return parts.join("\n");
}

export async function runFlow(spec: FlowSpec, baseTask: string, deps: FlowRunDeps): Promise<FlowOutcome> {
	const done = new Map<string, AgentResult>(Object.entries(deps.resume ?? {}));
	let remaining = spec.phases.filter((p) => !done.has(p.id));

	while (remaining.length > 0) {
		if (deps.signal?.aborted) break;
		const ready = remaining.filter((p) => (p.needs ?? []).every((n) => done.has(n)));
		if (ready.length === 0) break; // acyclic + progress guarantees this can't happen

		// A phase whose any need FAILED is blocked — record it failed without running.
		const blocked = ready.filter((p) => (p.needs ?? []).some((n) => !done.get(n)?.ok));
		for (const p of blocked) {
			const r: AgentResult = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error: "blocked: an upstream phase failed" };
			done.set(p.id, r);
			deps.onPhase?.(p.id, "failed", r);
			deps.journal?.({ phase: p.id, hash: deps.hash, ok: false, output: "" });
		}

		const runnable = ready.filter((p) => !blocked.includes(p));
		const results = await Promise.all(
			runnable.map(async (p): Promise<[string, AgentResult]> => {
				deps.onPhase?.(p.id, "running");
				const upstream: Record<string, AgentResult> = {};
				for (const n of p.needs ?? []) {
					const u = done.get(n);
					if (u) upstream[n] = u;
				}
				const task = buildPhaseTask(baseTask, spec, p, upstream);
				// A throwing phase (e.g. a misconfigured strategy) is a phase FAILURE, not a
				// crashed DAG — record it failed so its dependents block and the flow finishes.
				let r: AgentResult;
				try {
					r = await deps.runPhase({ phase: p, task, upstream });
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					r = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error };
				}
				deps.onPhase?.(p.id, r.ok ? "done" : "failed", r);
				deps.journal?.({ phase: p.id, hash: deps.hash, ok: r.ok, output: r.output });
				return [p.id, r];
			}),
		);
		for (const [id, r] of results) done.set(id, r);
		remaining = remaining.filter((p) => !done.has(p.id));
	}

	const results: Record<string, AgentResult> = Object.fromEntries(done);
	const needed = new Set(spec.phases.flatMap((p) => p.needs ?? []));
	const terminals = spec.phases.filter((p) => !needed.has(p.id));
	const output = terminals
		.map((p) => done.get(p.id)?.output ?? "")
		.filter((s) => s.trim())
		.join("\n\n---\n\n");
	const ok = spec.phases.every((p) => done.get(p.id)?.ok ?? false);
	return { ok, results, output };
}

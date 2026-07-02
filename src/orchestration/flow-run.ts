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
	/** A gated phase whose checkpoint was approved — so a resume doesn't re-prompt. */
	gateApproved?: boolean;
}

/** A resume map value: a phase result plus whether its checkpoint gate was already approved. */
export type ResumedResult = AgentResult & { gateApproved?: boolean };

export interface FlowRunDeps {
	/** Run one phase's strategy → its result (wraps `runPersonaStrategy` in prod). */
	runPhase: RunPhaseFn;
	/** The pinned `flow@hash` for this run (I3) — recorded in every journal line. */
	hash: string;
	signal?: AbortSignal;
	/** Append one entry as each phase completes. */
	journal?: (entry: FlowJournalEntry) => void;
	/** Phases already completed (from a prior run's journal) — skipped, output reused. */
	resume?: Record<string, ResumedResult>;
	/** Live UI: phase lifecycle. */
	onPhase?: (id: string, status: PhaseStatus, result?: AgentResult) => void;
	/** A gated phase's checkpoint: after it completes, approve before its dependents run.
	 *  Absent ⇒ gates auto-approve (informational only — headless runs aren't blocked). */
	approveGate?: (phase: FlowPhase, result: AgentResult) => Promise<boolean>;
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
	const byId = new Map(spec.phases.map((p) => [p.id, p]));
	// A gated phase only satisfies its dependents once its checkpoint is "passed" (or it blocks
	// them once "rejected"). Resume pre-seeds gates the journal already recorded as approved.
	const gateState = new Map<string, "passed" | "rejected">();
	const done = new Map<string, AgentResult>();
	for (const [id, r] of Object.entries(deps.resume ?? {})) {
		const gated = byId.get(id)?.gate === true;
		// A gated phase resumed as ok but WITHOUT a recorded approval (the process died between
		// journaling its completion and its gate decision) must RE-RUN, not be treated as done —
		// otherwise it sits in `done` with an unresolved gate and its dependents can never run.
		if (gated && r.ok && !(r as ResumedResult).gateApproved) continue;
		done.set(id, r);
		if (gated && (r as ResumedResult).gateApproved) gateState.set(id, "passed");
	}
	// A FAILED gated phase has no checkpoint to resolve — its gate must not keep dependents
	// from being considered (needFailed then records them "blocked", exactly like a failed
	// non-gated need; otherwise they'd never become ready and silently vanish, stuck ⏳).
	const gateResolved = (id: string): boolean => !byId.get(id)?.gate || gateState.has(id) || done.get(id)?.ok === false;
	const needFailed = (n: string): boolean => (done.has(n) && !done.get(n)?.ok) || gateState.get(n) === "rejected";
	let remaining = spec.phases.filter((p) => !done.has(p.id));

	while (remaining.length > 0) {
		if (deps.signal?.aborted) break;
		// A phase can be considered once every need is done AND any gated need is resolved.
		const ready = remaining.filter((p) => (p.needs ?? []).every((n) => done.has(n) && gateResolved(n)));
		if (ready.length === 0) break; // acyclic + progress guarantees this can't happen

		// A phase whose any need FAILED or whose gate was REJECTED is blocked — record, don't run.
		const blocked = ready.filter((p) => (p.needs ?? []).some((n) => needFailed(n)));
		for (const p of blocked) {
			const gateReject = (p.needs ?? []).some((n) => gateState.get(n) === "rejected");
			const error = gateReject ? "blocked: a checkpoint gate was not approved" : "blocked: an upstream phase failed";
			const r: AgentResult = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error };
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

		// Resolve checkpoint gates for phases that just completed OK — sequentially, so the
		// next readiness pass sees each gate's verdict (a rejected gate blocks its dependents).
		for (const [id, r] of results) {
			const phase = byId.get(id);
			if (!phase?.gate || !r.ok || gateState.has(id)) continue;
			const approved = deps.approveGate ? await deps.approveGate(phase, r) : true;
			gateState.set(id, approved ? "passed" : "rejected");
			if (approved) deps.journal?.({ phase: id, hash: deps.hash, ok: true, output: r.output, gateApproved: true });
		}
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

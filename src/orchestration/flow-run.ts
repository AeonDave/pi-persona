/**
 * Flow runner (v0.5) — execute a {@link FlowSpec} DAG: run every phase's strategy in
 * dependency order, fanning out phases whose `needs` are all satisfied in parallel,
 * threading each upstream phase's output into its dependents' task. Journals every
 * completed phase (one JSONL line) so a later run can RESUME by skipping done phases. A
 * failed phase blocks its dependents (they can't run without their input). The strategy
 * runner is injected (`deps.runPhase`), so the DAG logic is engine-agnostic and tested
 * with a stub.
 */

import { fenceUntrusted } from "../core/fence.ts";
import { emptyUsage } from "../engine/stream.ts";
import type { FlowPhase, FlowSpec } from "./flow.ts";
import type { AgentResult, FailureKind } from "./types.ts";

export type PhaseStatus = "running" | "done" | "failed";

/** One phase ready to run: its spec, the built task, its upstream phases' results, and — in
 *  reference mode — the DIRECT upstream refs granted to this phase's legs (nothing transitive). */
export interface FlowPhaseRun {
	phase: FlowPhase;
	task: string;
	upstream: Record<string, AgentResult>;
	/** Empty in inline mode; the phase's direct needs' archived refs in reference mode. */
	resultRefs: readonly string[];
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
	/** Reference handoff: the archived `result:<UUID>` this phase's output lives under — the
 *  body itself is NOT journaled in that mode (resume reads it back via the archive). */
	resultRef?: string;
	/** The archive-record schema version the `resultRef` line was written against. */
	resultVersion?: 1;
}

/** A resume map value: a phase result plus whether its checkpoint gate was already approved. */
export type ResumedResult = AgentResult & {
	gateApproved?: boolean;
	resultVersion?: 1;
	/** Reference handoff: the archived ref this phase was journaled under (from the journal). */
	resultRef?: string;
	/** The archived body for a phase's ref could not be read back (resume, or a live capture
	 *  that produced no ref) — dependents block on this need; nothing re-runs or falls back. */
	refUnavailable?: string;
};

export interface FlowRunDeps {
	/** Run one phase's strategy → its result (wraps `runPersonaStrategy` in prod). */
	runPhase: RunPhaseFn;
	/** The pinned run identity (I3: `flowRunHash` = flow + task + cwd) — recorded in every journal line. */
	hash: string;
	signal?: AbortSignal;
	/** Reference handoff: read a journaled ref's stored body back from the terminal archive —
	 *  how a RESUME rebuilds a done phase's output without re-running it. Required for a
	 *  reference-mode resume that has refs to restore; absent ⇒ every ref reads unavailable. */
	readArchivedResult?: (ref: string) => { ok: true; body: string; status: "done" | "failed" | "stopped"; truncated?: boolean } | { ok: false; error: string };
	/** Grace an aborted wave gets to unwind cooperatively before its still-running phases are
	 *  force-settled (defaults to {@link ABORT_GRACE_MS}); shrinkable in tests. */
	abortGraceMs?: number;
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
	/** The first phase that failed, when a settled result identifies one. */
	failedPhase?: string;
	/** The actionable cause of the flow's first failure, or the cancellation cause. */
	error?: string;
	/** The machine-readable cause of the flow failure. */
	failureKind?: FailureKind;
	/** The run signal fired before every phase settled ok. A cancelled flow is NOT the same as one
	 *  that merely finished without an answer, and callers report it differently. */
	cancelled?: boolean;
	/** The first checkpoint (in spec order) that was not approved, when that is the ONLY reason the
	 *  flow did not finish: a stop the operator chose, not a failure. `ok` stays false and `error`
	 *  stays "blocked: …" (a mandatory flow must keep failing closed); `output` is the gated
	 *  phase's own answer plus a stop note. */
	stoppedAtGate?: string;
}

/** What a finished flow IS to a reader. A checkpoint the operator declined is a STOP, their choice, never a
 *  failure: the one predicate the tool result, the tree row and the cards share. */
export function flowDisposition(outcome: { ok: boolean; stoppedAtGate?: string | undefined }): "done" | "stopped" | "failed" {
	return outcome.ok ? "done" : outcome.stoppedAtGate !== undefined ? "stopped" : "failed";
}

/** How long an aborted wave is given to unwind COOPERATIVELY before its still-running phases are
 *  force-settled as cancelled. A strategy that consults the run signal returns its own (more
 *  informative) result — the last good draft, the upstream step's output, the usage already
 *  billed — inside this window; a strategy that ignores the signal must not be able to hold the
 *  whole run open. Sized for the cooperative path to actually WIN it: a strategy notices at a
 *  round boundary, and only once its in-flight legs have settled through the engine's abort path
 *  (an in-process session stop, or a child process tree kill), which is seconds rather than
 *  milliseconds. The full wait is paid only by a phase that never unwinds at all. */
const ABORT_GRACE_MS = 5_000;

const CANCELLED_ERROR = "cancelled: the flow run was aborted";

/** Resolves when `signal` aborts — never, when there is none. `dispose` drops the listener, so a
 *  many-wave run doesn't accumulate one per wave on a long-lived signal. */
function whenAborted(signal: AbortSignal | undefined): { promise: Promise<void>; dispose: () => void } {
	if (!signal) return { promise: new Promise<void>(() => { /* never */ }), dispose: () => { /* nothing to drop */ } };
	let onAbort = (): void => { /* replaced below */ };
	const promise = new Promise<void>((resolve) => {
		onAbort = (): void => resolve();
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/** Await `p`, but give up after `ms`. The timer is unref'd: a pending grace must never be the
 *  reason a process stays alive. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		const settle = (): void => {
			clearTimeout(timer);
			resolve();
		};
		void p.then(settle, settle);
	});
}

/** Reference handoff: how much of an upstream body is embedded as a PREVIEW (contract 2).
 *  The full report stays in the archive; the dependent pages it with `read_result`. */
export const RESULT_PREVIEW_CHARS = 1200;

/** Build a phase's task. Inline (the default, first-class): the base task plus each upstream
 *  phase's FULL fenced output. Reference: per upstream phase ONLY a bounded fenced preview +
 *  the archived ref + its status + how to read more — never the full body. */
function buildPhaseTask(baseTask: string, spec: FlowSpec, phase: FlowPhase, upstream: Record<string, AgentResult>): string {
	const parts = [`Flow "${spec.name}" — phase "${phase.id}" (strategy: ${phase.strategy}).`, baseTask];
	const ups = Object.entries(upstream);
	if (ups.length === 0) return parts.join("\n");
	if (spec.handoff === "reference") {
		parts.push("\nUpstream results (archived references — read more with the read_result tool):");
		for (const [id, r] of ups) {
			const ref = r.resultReceipt?.ref;
			parts.push(`\n--- ${id} ---`);
			parts.push(`status: ${r.ok ? "done" : "failed"}`);
			if (ref === undefined) {
				const preview = r.output.slice(0, 200);
				parts.push(preview
					? `result reference unavailable:\n${fenceUntrusted(preview)}`
					: "result reference unavailable: (no output)");
				continue;
			}
			parts.push(`result ref: ${ref}`);
			if (r.resultReceipt?.truncated) parts.push("Archive retention truncated the original report; the stored body is partial even after reading every page.");
			parts.push(`preview (first ${RESULT_PREVIEW_CHARS} of ${r.output.length} chars):\n${fenceUntrusted(r.output.slice(0, RESULT_PREVIEW_CHARS))}${r.output.length > RESULT_PREVIEW_CHARS ? "\n(preview truncated — use read_result for the rest)" : ""}`);
			parts.push(`Read the full report with the read_result tool, e.g. {"ref":"${ref}","offset":0,"limit":8000}; follow each reply's nextOffset until endOfStoredBody.`);
		}
		return parts.join("\n");
	}
	parts.push("\nUpstream results to build on:");
	for (const [id, r] of ups) parts.push(`\n--- ${id} ---\n${fenceUntrusted(r.output)}`);
	return parts.join("\n");
}

export async function runFlow(spec: FlowSpec, baseTask: string, deps: FlowRunDeps): Promise<FlowOutcome> {
	const byId = new Map(spec.phases.map((p) => [p.id, p]));
	const reference = spec.handoff === "reference";
	/** One journal write, mode-aware: reference lines carry the ref (+version marker) and never
	 *  the body; inline lines stay byte-identical to the historical format. */
	const journalSettled = (id: string, r: AgentResult, gateApproved = false): void => {
		if (!deps.journal) return;
		const ref = r.resultReceipt?.ref;
		deps.journal(reference
			? { phase: id, hash: deps.hash, ok: r.ok, output: "", ...(r.ok && ref !== undefined ? { resultRef: ref, resultVersion: 1 as const } : {}), ...(gateApproved ? { gateApproved: true } : {}) }
			: { phase: id, hash: deps.hash, ok: r.ok, output: r.output, ...(gateApproved ? { gateApproved: true } : {}) });
	};
	/** Reference resume: rebuild a done phase's output from the terminal archive. A ref that
	 *  cannot be read back marks the phase `refUnavailable` — its dependents BLOCK (no respawn,
	 *  no inline fallback, no re-run of the done phase); the error says why. */
	const restoreResumed = (r: ResumedResult): ResumedResult => {
		if (r.refUnavailable) return { ...r, output: "" };
		const ref = r.resultRef;
		if (ref === undefined) {
			return { ...r, output: "", refUnavailable: "the phase was journaled without an archived result reference" };
		}
		if (r.resultVersion !== 1) return { ...r, output: "", refUnavailable: "unsupported or missing archived result journal version" };
		const read = deps.readArchivedResult?.(ref);
		if (!read) return { ...r, output: "", refUnavailable: `archived result ${ref} is unreadable (no archive reader is wired for this run)` };
		if (!read.ok) return { ...r, output: "", refUnavailable: `archived result ${ref} is unreadable (${read.error})` };
		if (read.status !== "done") return { ...r, output: "", refUnavailable: `archived result ${ref} has status ${read.status}; expected done` };
		return { ...r, output: read.body, resultReceipt: { ...(r.resultReceipt ?? {}), ref, ...(read.truncated === undefined ? {} : { truncated: read.truncated }) } };
	};
	// A gated phase only satisfies its dependents once its checkpoint is "passed" (or it blocks
	// them once "rejected"). Resume pre-seeds gates the journal already recorded as approved.
	const gateState = new Map<string, "passed" | "rejected">();
	const done = new Map<string, ResumedResult>();
	for (const [id, r0] of Object.entries(deps.resume ?? {})) {
		const gated = byId.get(id)?.gate === true;
		// A gated phase resumed as ok but WITHOUT a recorded approval (the process died between
		// journaling its completion and its gate decision) must RE-RUN, not be treated as done —
		// otherwise it sits in `done` with an unresolved gate and its dependents can never run.
		let r: ResumedResult = r0;
		if (reference && r0.ok) {
			const restored = restoreResumed(r0);
			r = restored.resultReceipt?.ref !== undefined ? restored : { ...restored, refUnavailable: restored.refUnavailable ?? "the phase has no archived result reference" };
		}
		// An invalid reference cannot turn this historical checkpoint into newly paid work.
		if (gated && r.ok && !r.gateApproved && !r.refUnavailable) continue;
		done.set(id, r);
		if (gated && r0.gateApproved) gateState.set(id, "passed");
	}
	// A FAILED gated phase has no checkpoint to resolve — its gate must not keep dependents
	// from being considered (needFailed then records them "blocked", exactly like a failed
	// non-gated need; otherwise they'd never become ready and silently vanish, stuck ⏳).
	const gateResolved = (id: string): boolean => !byId.get(id)?.gate || gateState.has(id) || done.get(id)?.ok === false;
	const needFailed = (n: string): boolean => (done.has(n) && !done.get(n)?.ok) || gateState.get(n) === "rejected";
	/** An OK need whose archived reference cannot serve dependents (unreadable at resume, or a
	 *  live capture that produced no ref). The need stays DONE — only its dependents block. */
	const needUnavailable = (n: string): boolean => (done.get(n)?.refUnavailable ?? "") !== "";
	let remaining = spec.phases.filter((p) => !done.has(p.id));
	let cancelled = false;
	// Keep blocked dependents distinct from phases that actually ran and failed. The flow's
	// declaration order is not necessarily topological, so a dependent can appear before the
	// root failure in `spec.phases`; it must never hide that root cause in the final outcome.
	const blockedPhaseIds = new Set<string>();

	while (remaining.length > 0) {
		if (deps.signal?.aborted) {
			cancelled = true;
			break;
		}
		// A phase can be considered once every need is done AND any gated need is resolved.
		const ready = remaining.filter((p) => (p.needs ?? []).every((n) => done.has(n) && gateResolved(n)));
		if (ready.length === 0) break; // acyclic + progress guarantees this can't happen

		// A phase whose any need FAILED, whose gate was REJECTED, or (reference mode) whose need's
		// archived ref cannot be read — record, don't run.
		const blocked = ready.filter((p) => (p.needs ?? []).some((n) => needFailed(n) || needUnavailable(n)));
		for (const p of blocked) {
			blockedPhaseIds.add(p.id);
			const gateReject = (p.needs ?? []).some((n) => gateState.get(n) === "rejected");
			const unavailableNeed = (p.needs ?? []).find((n) => needUnavailable(n));
			const error = gateReject
				? "blocked: a checkpoint gate was not approved"
				: unavailableNeed !== undefined
					? `blocked: upstream phase "${unavailableNeed}" result reference is unavailable (${done.get(unavailableNeed)?.refUnavailable})`
					: "blocked: an upstream phase failed";
			const r: AgentResult = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error };
			done.set(p.id, r);
			deps.onPhase?.(p.id, "failed", r);
			deps.journal?.({ phase: p.id, hash: deps.hash, ok: false, output: "" });
		}

		const runnable = ready.filter((p) => !blocked.includes(p));
		// Phases that produced their own result. Anything still missing when an aborted wave's
		// grace expires is force-settled below, so a run-level abort can cut a wave already in
		// flight instead of waiting on strategies that never consult the signal.
		const settled = new Map<string, AgentResult>();
		let forced = false;
		const wave = Promise.all(
			runnable.map(async (p): Promise<void> => {
				deps.onPhase?.(p.id, "running");
				const upstream: Record<string, AgentResult> = {};
				for (const n of p.needs ?? []) {
					const u = done.get(n);
					if (u) upstream[n] = u;
				}
				// Reference mode: the phase's legs are granted EXACTLY its direct needs' refs —
				// never a transitive ancestor's (the reader scope mirrors the task's previews).
				const resultRefs: readonly string[] = reference
					? (p.needs ?? []).map((n) => done.get(n)?.resultReceipt?.ref).filter((x): x is string => x !== undefined)
					: [];
				const task = buildPhaseTask(baseTask, spec, p, upstream);
				// A throwing phase (e.g. a misconfigured strategy) is a phase FAILURE, not a
				// crashed DAG — record it failed so its dependents block and the flow finishes.
				let r: ResumedResult;
				try {
					r = await deps.runPhase({ phase: p, task, upstream, resultRefs });
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					r = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error };
				}
				// Reference mode is a durability contract: a phase that finished without an archived
				// ref cannot serve its dependents. It stays done — dependents BLOCK on it below.
				if (reference && r.ok && r.resultReceipt?.ref === undefined) {
					r = { ...r, refUnavailable: "the phase completed without an archived result reference" };
				}
				// The run already gave up on this phase and moved on. Its UI node is torn down and
				// its outcome is already reported, so re-drive neither — but work that DID complete
				// is still worth keeping: journal it so a RESUME reuses the output instead of paying
				// for the same phase a second time. A late FAILURE is not journaled — there is
				// nothing to reuse, and a resume has to re-run it anyway.
				if (forced) {
					if (r.ok) journalSettled(p.id, r);
					return;
				}
				settled.set(p.id, r);
				deps.onPhase?.(p.id, r.ok ? "done" : "failed", r);
				journalSettled(p.id, r);
			}),
		);

		const abort = whenAborted(deps.signal);
		try {
			await Promise.race([wave, abort.promise]);
			if (deps.signal?.aborted) await within(wave, deps.abortGraceMs ?? ABORT_GRACE_MS);
		} finally {
			abort.dispose();
		}
		if (deps.signal?.aborted) {
			forced = true;
			for (const p of runnable) {
				if (settled.has(p.id)) continue;
				// `failureKind: "abort"` is the distinction every other layer keys on (the strategies'
				// own cancelled results carry it) — without it a phase the USER stopped reads to its
				// consumers as one that simply failed.
				const r: AgentResult = { agent: p.id, output: "", usage: emptyUsage(), ok: false, error: CANCELLED_ERROR, failureKind: "abort" };
				settled.set(p.id, r);
				deps.onPhase?.(p.id, "failed", r);
				// Deliberately NOT journaled: the phase produced nothing, so a resume has to re-run
				// it rather than skip it as done.
			}
		}
		for (const [id, r] of settled) done.set(id, r);
		if (deps.signal?.aborted) {
			// Gates are skipped on the way out — an aborted run must not stop to prompt for a
			// checkpoint nobody is waiting on.
			cancelled = spec.phases.some((p) => done.get(p.id)?.ok !== true);
			break;
		}

		// Resolve checkpoint gates for phases that just completed OK — sequentially, so the
		// next readiness pass sees each gate's verdict (a rejected gate blocks its dependents).
		for (const [id, r] of settled) {
			const phase = byId.get(id);
			if (!phase?.gate || !r.ok || gateState.has(id)) continue;
			const approved = deps.approveGate ? await deps.approveGate(phase, r) : true;
			gateState.set(id, approved ? "passed" : "rejected");
			if (approved) journalSettled(id, r, true);
		}
		remaining = remaining.filter((p) => !done.has(p.id));
	}

	// Missing reference evidence is a failed resume, even when the saved phase is a sink
	// with no dependent to expose the problem. Retain it in done to prevent any respawn.
	for (const [id, result] of done) {
		if (result.refUnavailable) done.set(id, {
			...result, ok: false, error: `Archived result reference is unavailable: ${result.refUnavailable}`, failureKind: "contract",
		});
	}
	const results: Record<string, AgentResult> = Object.fromEntries(done);
	const needed = new Set(spec.phases.flatMap((p) => p.needs ?? []));
	const terminals = spec.phases.filter((p) => !needed.has(p.id));
	const terminalOutput = terminals
		.map((p) => {
			const result = done.get(p.id);
			return `${result?.output ?? ""}${result?.resultReceipt?.truncated ? "\n[pi-persona] Archive retention truncated this report; this is the partial stored body." : ""}`;
		})
		.filter((s) => s.trim())
		.join("\n\n---\n\n");
	const ok = spec.phases.every((p) => done.get(p.id)?.ok ?? false);
	const failures = spec.phases
		.map((phase) => ({ phase, result: done.get(phase.id) }))
		.filter((entry): entry is { phase: FlowPhase; result: AgentResult } => entry.result !== undefined && !entry.result.ok);
	const rootFailures = failures.filter((entry) => !blockedPhaseIds.has(entry.phase.id));
	const cancellation = cancelled;
	// Cancellation is authoritative: a normal failure from an earlier phase must not replace the
	// user's stop with an ordinary failure classification. Prefer an explicitly aborted phase when
	// one settled, otherwise keep the cancellation at flow level without inventing a failed phase.
	const failure = cancellation
		? failures.find((entry) => entry.result.failureKind === "abort")
		: rootFailures[0] ?? failures[0];
	// A rejected checkpoint is a STOP, not a failure, only when nothing else went wrong: a real phase
	// failure or a cancellation is the more important fact and keeps its ordinary report. A rejected
	// gate with no dependents blocks nothing, so the flow is still `ok` and was not stopped.
	const stoppedAtGate = !cancellation && !ok && rootFailures.length === 0
		? spec.phases.find((p) => gateState.get(p.id) === "rejected")?.id
		: undefined;
	const failedPhase = failure?.phase.id;
	const error = cancellation ? (failure?.result.error ?? CANCELLED_ERROR) : failure?.result.error;
	const failureKind = cancellation ? "abort" as const : failure?.result.failureKind;
	const failureText = failedPhase
		? `Flow failed at phase "${failedPhase}": ${error ?? "the phase failed"}`
		: `Flow failed: ${error ?? "the flow did not complete successfully"}`;
	const cancellationText = `Flow cancelled${failedPhase ? ` at phase "${failedPhase}"` : ""}: ${error ?? CANCELLED_ERROR}`;
	const outputAlreadySignalsCancellation = /\b(?:cancel(?:led|lation)?|abort(?:ed)?|stopp?ed)\b/i.test(terminalOutput);
	const terminalReport = (): string => {
		// A rejected checkpoint answers with the gated phase's own output: that is what the operator was
		// asked to approve, and dropping it on a "no" would throw away work already paid for. Another
		// branch that finished keeps its answer beside it.
		if (stoppedAtGate !== undefined) {
			return [
				done.get(stoppedAtGate)?.output ?? "",
				terminalOutput,
				`- flow stopped at checkpoint "${stoppedAtGate}": not approved (declined, dismissed, or no interactive session). Later phases did not run.`,
			].filter((part) => part.trim()).join("\n\n");
		}
		if (cancellation) {
			if (!terminalOutput.trim()) return cancellationText;
			return outputAlreadySignalsCancellation ? terminalOutput : `${terminalOutput}\n\n${cancellationText}`;
		}
		if (terminalOutput.trim()) return terminalOutput;
		return failure ? failureText : terminalOutput;
	};
	return {
		ok,
		results,
		output: terminalReport(),
		...(failedPhase ? { failedPhase } : {}),
		...(error ? { error } : {}),
		...(failureKind ? { failureKind } : {}),
		...(cancelled ? { cancelled: true } : {}),
		...(stoppedAtGate !== undefined ? { stoppedAtGate } : {}),
	};
}

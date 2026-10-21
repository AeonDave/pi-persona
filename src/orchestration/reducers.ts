/**
 * Reducers fold many `AgentResult`s into one. This module holds the two non-voting
 * reducers — usage summation and labeled aggregation (for fanout); the voting
 * reducer with the richer status union (winner|tie|no_consensus|invalid_outputs)
 * lives in `voting.ts`.
 */

import { type ChildUsage, emptyUsage } from "../engine/stream.ts";
import type { AgentResult, FailureKind } from "./types.ts";

export interface FailedResultCause {
	error: string;
	failureKind: FailureKind;
}

/** Preserve the most actionable cause when a whole panel yields no usable result.
 * User cancellation wins even in a mixed panel. Otherwise a homogeneous technical
 * failure survives; mixed failures or successful-but-protocol-invalid outputs are
 * classified at the enclosing strategy's contract boundary. */
export function summarizeFailedResults(
	results: AgentResult[],
	fallbackError: string,
	fallbackKind: FailureKind = "contract",
): FailedResultCause {
	const aborted = results.find((result) => !result.ok && result.failureKind === "abort");
	if (aborted) return { error: aborted.error ?? "the run was aborted", failureKind: "abort" };

	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0 && failed.length === results.length) {
		const kinds = new Set(failed.map((result) => result.failureKind ?? "agent"));
		if (kinds.size === 1) {
			const failureKind = kinds.values().next().value as FailureKind;
			const error = failed.find((result) => result.error)?.error ?? fallbackError;
			return { error, failureKind };
		}
	}

	return { error: fallbackError, failureKind: fallbackKind };
}

export function sumUsage(usages: ChildUsage[]): ChildUsage {
	const total = emptyUsage();
	for (const u of usages) {
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.cost += u.cost;
		total.turns += u.turns;
	}
	return total;
}

export type ItemStatus = "completed" | "failed" | "not-run";

/** One status entry per `map` sub-item — the batch's audit trail, independent of `ownership`. */
export interface ItemLedgerEntry {
	index: number;
	item: string;
	status: ItemStatus;
	agent?: string;
	failureKind?: FailureKind;
	error?: string;
	writeSet?: string[];
}

/** One ledger entry per item the splitter produced: `completed`/`failed` for an item a worker
 *  actually ran (from `results`, in item order), `not-run` for the `dropped` tail that never got
 *  a worker slot. Pure; carries the item's declared `writeSet` through when the caller kept it. */
export function itemLedger(
	allItems: readonly { item: string; writeSet?: string[] }[],
	results: readonly AgentResult[],
	dropped: number,
): ItemLedgerEntry[] {
	const ranCount = Math.max(0, allItems.length - dropped);
	return allItems.map((it, index) => {
		const writeSet = it.writeSet ? { writeSet: it.writeSet } : {};
		const result = index < ranCount ? results[index] : undefined;
		if (!result) return { index, item: it.item, status: "not-run", ...writeSet };
		return {
			index,
			item: it.item,
			status: result.ok ? "completed" : "failed",
			agent: result.agent,
			...(result.failureKind ? { failureKind: result.failureKind } : {}),
			...(!result.ok && result.error ? { error: result.error } : {}),
			...writeSet,
		};
	});
}

/** Combine fan-out results into one labeled-section result; ok iff all ok. `labels` (aligned to
 *  `results`) name each section by lens or item instead of the bare agent; the label is kept as
 *  `member` only when it adds something, so a label-free call is byte-identical to before. */
export function aggregateResults(results: AgentResult[], labels?: readonly string[]): AgentResult {
	const labelOf = (r: AgentResult, i: number): string => labels?.[i] ?? r.agent;
	const sections = results.map((r, i) => {
		const status = r.ok ? "ok" : `failed${r.failureKind ? ` (${r.failureKind})` : ""}`;
		const body = r.output || r.error || "(no output)";
		const cause = !r.ok && r.error && r.output && r.error !== r.output ? `\n\nError: ${r.error}` : "";
		return `### [${labelOf(r, i)}] ${status}\n\n${body}${cause}`;
	});
	const aggregate: AgentResult = {
		agent: "aggregate",
		output: sections.join("\n\n---\n\n"),
		structured: {
			count: results.length,
			results: results.map((r, i) => ({
				agent: r.agent,
				...(labelOf(r, i) !== r.agent ? { member: labelOf(r, i) } : {}),
				ok: r.ok,
				output: r.output,
				error: r.error ?? null,
				failureKind: r.failureKind ?? null,
				structured: r.structured ?? null,
			})),
		},
		usage: sumUsage(results.map((r) => r.usage)),
		ok: results.every((r) => r.ok),
	};
	if (!aggregate.ok) {
		const cause = summarizeFailedResults(results, "one or more agents failed", "agent");
		aggregate.error = cause.error;
		aggregate.failureKind = cause.failureKind;
	}
	return aggregate;
}

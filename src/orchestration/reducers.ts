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

/** Combine fan-out results into one labeled-section result; ok iff all ok. */
export function aggregateResults(results: AgentResult[]): AgentResult {
	const sections = results.map((r) => {
		const status = r.ok ? "ok" : `failed${r.failureKind ? ` (${r.failureKind})` : ""}`;
		const body = r.output || r.error || "(no output)";
		const cause = !r.ok && r.error && r.output && r.error !== r.output ? `\n\nError: ${r.error}` : "";
		return `### [${r.agent}] ${status}\n\n${body}${cause}`;
	});
	return {
		agent: "aggregate",
		output: sections.join("\n\n---\n\n"),
		structured: {
			count: results.length,
			results: results.map((r) => ({
				agent: r.agent,
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
}

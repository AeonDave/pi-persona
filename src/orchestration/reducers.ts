/**
 * Reducers fold many `AgentResult`s into one. v0.1 ships the two non-voting
 * reducers the first strategies need: usage summation and labeled aggregation
 * (for fanout). The voting reducers with the richer status union
 * (winner|tie|no_consensus|invalid) land in v0.2 with `magi`.
 */

import { type ChildUsage, emptyUsage } from "../engine/stream.ts";
import type { AgentResult } from "./types.ts";

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
	const sections = results.map((r) => `### [${r.agent}] ${r.ok ? "ok" : "failed"}\n\n${r.output || "(no output)"}`);
	return {
		agent: "aggregate",
		output: sections.join("\n\n---\n\n"),
		structured: {
			count: results.length,
			results: results.map((r) => ({
				agent: r.agent,
				ok: r.ok,
				output: r.output,
				structured: r.structured ?? null,
			})),
		},
		usage: sumUsage(results.map((r) => r.usage)),
		ok: results.every((r) => r.ok),
	};
}

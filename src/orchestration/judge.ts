/**
 * Judge preparation (§4.3) — the impartial-judge counterpart to `vote`. Voting tallies
 * the candidates' own votes; judging hands the candidates to ONE judge agent that picks.
 * The bias guard is that the judge must see them **anonymised** (no author identity) and,
 * for production, **reordered** (so position can't bias the pick). This module is the PURE
 * part: render an anonymised, labelled ballot and resolve the judge's chosen label back to
 * the real candidate. A judge strategy then runs `agent(judge, { task: prep.ballot })` and
 * maps its verdict via `prep.pick(...)` — no new engine surface needed.
 */

import type { AgentResult } from "./types.ts";

export interface JudgePrep {
	/** The candidates rendered anonymised + reordered, each under a `[A]`/`[B]`… label. */
	ballot: string;
	/** Resolve a judge's chosen label (case-insensitive) back to the original candidate. */
	pick(label: string): AgentResult | undefined;
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Anonymise + label (+ optionally reorder) candidates for an impartial LLM judge. `order`
 *  is a permutation of candidate indices (ballot position → candidate); production passes a
 *  shuffle, tests pass a fixed permutation. Defaults to candidate order. */
export function prepareJudge(candidates: AgentResult[], order?: number[]): JudgePrep {
	const perm = order && order.length === candidates.length ? order : candidates.map((_, i) => i);
	const byLabel = new Map<string, AgentResult>();
	const sections: string[] = [];
	perm.forEach((candIdx, pos) => {
		const c = candidates[candIdx];
		if (!c) return;
		const label = LABELS[pos] ?? `#${pos + 1}`;
		byLabel.set(label, c);
		sections.push(`[${label}]\n${c.output.trim()}`);
	});
	return {
		ballot: sections.join("\n\n"),
		pick: (label) => byLabel.get(label.trim().toUpperCase()),
	};
}

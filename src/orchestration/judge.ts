/**
 * Judge preparation (§4.3) — the impartial-judge counterpart to `vote`. Voting tallies
 * the candidates' own votes; judging hands the candidates to ONE judge agent that picks.
 * The bias guard is that the judge must see them **anonymised** (no author identity) and,
 * for production, **reordered** (so position can't bias the pick). This module is the PURE
 * part: render an anonymised, labelled ballot and resolve the judge's chosen label back to
 * the real candidate. A judge strategy then runs `agent(judge, { task: prep.ballot })` and
 * maps its verdict via `prep.pick(...)` — no new engine surface needed.
 */

import { fenceUntrusted } from "../core/fence.ts";
import type { AgentResult } from "./types.ts";

export interface JudgePrep {
	/** The candidates rendered anonymised + reordered, each under a `[A]`/`[B]`… label. */
	ballot: string;
	/** Resolve a judge's chosen label (case-insensitive) back to the original candidate. */
	pick(label: string): AgentResult | undefined;
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The judge's vote reduced to a ballot label. Models routinely answer "Candidate B" or "B."
 * where the ballot asked for "B", so a bare single-letter token is read as the pick.
 *
 * The candidate letters are filtered against the labels ACTUALLY on this ballot, and an
 * ambiguous vote (two different labels named, e.g. "A or B?") resolves to nothing. Guessing
 * here is worse than failing: the no-pick path already returns the panel (or, for compete,
 * every valid diff) — a refusal loses nothing, while a wrong guess applies the wrong work.
 */
export function ballotLabel(vote: string, onBallot: number): string {
	const bare = vote.trim().toUpperCase();
	if (bare.length <= 1) return bare;
	const labels = new Set(LABELS.slice(0, Math.min(onBallot, LABELS.length)));
	const named = [...new Set(bare.split(/[^A-Z]+/).filter((t) => t.length === 1 && labels.has(t)))];
	return named.length === 1 ? named[0]! : bare;
}

function isPermutation(order: number[], n: number): boolean {
	if (order.length !== n) return false;
	const seen = new Set(order);
	if (seen.size !== n) return false;
	return order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
}

/** Anonymise + label (+ optionally reorder) candidates for an impartial LLM judge. `order`
 *  is a permutation of candidate indices (ballot position → candidate); production passes a
 *  shuffle, tests pass a fixed permutation. Defaults to candidate order. A malformed `order`
 *  (wrong length / not a permutation) is ignored rather than silently becoming identity —
 *  identity would drop the reorder half of the bias guard. */
export function prepareJudge(candidates: AgentResult[], order?: number[]): JudgePrep {
	const perm = order && isPermutation(order, candidates.length) ? order : candidates.map((_, i) => i);
	const byLabel = new Map<string, AgentResult>();
	const sections: string[] = [];
	perm.forEach((candIdx, pos) => {
		const c = candidates[candIdx];
		if (!c) return;
		const label = LABELS[pos] ?? `#${pos + 1}`;
		byLabel.set(label, c);
		sections.push(`[${label}]\n${fenceUntrusted(c.output.trim())}`);
	});
	return {
		ballot: sections.join("\n\n"),
		pick: (label) => byLabel.get(ballotLabel(label, byLabel.size)),
	};
}

/** A random permutation of [0..n) — so a judge can't be biased by candidate order.
 *  Production ballots pass this to {@link prepareJudge}; tests pass a fixed permutation. */
export function shuffleOrder(n: number): number[] {
	const a = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j] as number, a[i] as number];
	}
	return a;
}

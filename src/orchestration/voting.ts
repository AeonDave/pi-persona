/**
 * Voting reducers (v0.2). Fold candidate results into a decision with an honest
 * status union — never just a `winner`. Built-in bias guards: invalid outputs
 * are quarantined, dissent is always preserved, and ties/no-consensus are
 * surfaced (with an optional keep-best-by-confidence fallback). Anonymisation /
 * order-shuffling apply to judge-based aggregation (added with the judge reducer).
 */

import type { AgentResult } from "./types.ts";

export type ReducerStatus = "winner" | "tie" | "no_consensus" | "invalid_outputs";

export interface ReducerResult {
	status: ReducerStatus;
	winner?: AgentResult;
	dissent?: AgentResult[];
	invalid?: AgentResult[];
	tally: Record<string, number>;
	usedFallback: boolean;
}

export interface VoteOpts {
	aggregate: "majority" | "unanimity";
	keepBestFallback?: boolean;
	/** Best-of-X: a plurality winner must reach at least this many votes, else no_consensus. */
	threshold?: number;
}

/** Normalise a vote so case/separator variants tally together
 *  (`json-first`, `JSON_First`, `json first` → `json-first`). */
function normalizeVote(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** The canonical (normalised) vote key for a candidate, or undefined if it cannot vote. */
function voteKey(r: AgentResult): string | undefined {
	if (!r.ok) return undefined;
	const s = r.structured;
	if (s && typeof s.vote === "string" && s.vote.trim()) return normalizeVote(s.vote);
	if (s && typeof s.result === "string" && s.result.trim()) return normalizeVote(s.result);
	return undefined;
}

function confidence(r: AgentResult): number {
	const c = r.structured?.confidence;
	return typeof c === "number" ? c : 0;
}

export function voteReduce(candidates: AgentResult[], opts: VoteOpts): ReducerResult {
	const valid: Array<{ result: AgentResult; key: string }> = [];
	const invalid: AgentResult[] = [];
	for (const candidate of candidates) {
		const key = voteKey(candidate);
		if (key === undefined) invalid.push(candidate);
		else valid.push({ result: candidate, key });
	}

	const tally: Record<string, number> = {};
	for (const v of valid) tally[v.key] = (tally[v.key] ?? 0) + 1;

	if (valid.length === 0) {
		// Nobody emitted a parseable vote. With keepBestFallback, don't strand the caller with an
		// empty ruling (small models often drop the vote JSON) — surface the strongest single PROSE
		// answer among the candidates that actually ANSWERED. That means ok candidates AND
		// contract-only failures: an engine marks a member that answered in prose instead of the
		// vote JSON as `ok:false, failureKind:"contract"`, which is precisely the case this rescue
		// exists for (requiring `ok` here would make it unreachable — live-drive verified: a debate
		// over generic agents returned an empty ruling). Hard failures (timeout/abort/provider/
		// agent) stay excluded. No usable prose ⇒ genuinely nothing to show.
		const res: ReducerResult = { status: "invalid_outputs", invalid, tally, usedFallback: false };
		if (opts.keepBestFallback) {
			const prose = candidates.filter((c) => c.output.trim() && (c.ok || c.failureKind === "contract"));
			const winner = [...prose].sort((a, b) => confidence(b) - confidence(a))[0];
			if (winner) {
				res.winner = winner;
				res.dissent = prose.filter((c) => c !== winner);
				res.usedFallback = true;
				// The rescued prose (winner + dissent) is SURFACED, not excluded — keep only the
				// candidates that produced nothing usable in `invalid`, so an "N invalid excluded"
				// footer counts what was actually dropped, not the ruling it sits above.
				res.invalid = invalid.filter((c) => c !== winner && !res.dissent!.includes(c));
			}
		}
		return res;
	}

	const bestByConfidence = (): AgentResult =>
		[...valid].sort((a, b) => confidence(b.result) - confidence(a.result))[0]!.result;

	const withFallback = (status: ReducerStatus): ReducerResult => {
		const res: ReducerResult = { status, invalid, tally, usedFallback: false };
		if (opts.keepBestFallback) {
			const winner = bestByConfidence();
			res.winner = winner;
			// Preserve the minority report even when we fall back — this is exactly the
			// case (tie / no_consensus) where the dissent matters most.
			res.dissent = valid.filter((v) => v.result !== winner).map((v) => v.result);
			res.usedFallback = true;
		}
		return res;
	};

	if (opts.aggregate === "unanimity") {
		if (Object.keys(tally).length === 1) {
			return { status: "winner", winner: valid[0]!.result, dissent: [], invalid, tally, usedFallback: false };
		}
		return withFallback("no_consensus");
	}

	// majority
	const max = Math.max(...Object.values(tally));
	const top = Object.keys(tally).filter((k) => tally[k] === max);
	if (top.length === 1) {
		// Best-of-X: a clear plurality still needs `threshold` votes to win outright.
		if (opts.threshold !== undefined && max < opts.threshold) return withFallback("no_consensus");
		const winnerKey = top[0];
		const winner = valid.find((v) => v.key === winnerKey)!.result;
		const dissent = valid.filter((v) => v.key !== winnerKey).map((v) => v.result);
		return { status: "winner", winner, dissent, invalid, tally, usedFallback: false };
	}
	return withFallback("tie");
}

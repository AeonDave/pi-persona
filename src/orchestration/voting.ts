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
}

/** The canonical vote key for a candidate, or undefined if it cannot vote. */
function voteKey(r: AgentResult): string | undefined {
	if (!r.ok) return undefined;
	const s = r.structured;
	if (s && typeof s.vote === "string" && s.vote.trim()) return s.vote.trim();
	if (s && typeof s.result === "string" && s.result.trim()) return s.result.trim();
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

	if (valid.length === 0) return { status: "invalid_outputs", invalid, tally, usedFallback: false };

	const bestByConfidence = (): AgentResult =>
		[...valid].sort((a, b) => confidence(b.result) - confidence(a.result))[0]!.result;

	const withFallback = (status: ReducerStatus): ReducerResult => {
		const res: ReducerResult = { status, invalid, tally, usedFallback: false };
		if (opts.keepBestFallback) {
			res.winner = bestByConfidence();
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
		const winnerKey = top[0];
		const winner = valid.find((v) => v.key === winnerKey)!.result;
		const dissent = valid.filter((v) => v.key !== winnerKey).map((v) => v.result);
		return { status: "winner", winner, dissent, invalid, tally, usedFallback: false };
	}
	return withFallback("tie");
}

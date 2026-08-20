/**
 * council-rounds — a multi-round deliberation strategy. Each round the whole
 * roster re-deliberates (carrying the prior round's debate forward) and votes; a
 * candidate that reaches `bestOf` votes wins outright, otherwise the council runs
 * another round, up to `rounds`. On the final round it keeps the best-by-confidence
 * as a fallback. Pure SDK usage — proof that a richer ensemble (more members,
 * supermajority, iterative debate) is just a strategy file, no engine changes.
 *
 * params: { rounds?: number (default 3), bestOf?: number (default = majority of the roster), aggregate? }
 */

import { fenceUntrusted } from "../../core/fence.ts";
import { sumUsage, summarizeFailedResults } from "../reducers.ts";
import { dissentLine, readableRuling, rulingHeadline } from "../render.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";
import type { ReducerResult } from "../voting.ts";

function render(
	decision: ReducerResult,
	round: number,
	bestOf: number,
	usages: AgentResult["usage"][],
	candidates: AgentResult[],
): AgentResult {
	const lines: string[] = [];
	lines.push(
		`COUNCIL ruling after ${round} round(s), best-of-${bestOf}: ${decision.status}${
			decision.usedFallback ? " — fell back to best-by-confidence" : ""
		}`,
	);
	lines.push(`tally: ${Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
	const nInvalid = decision.invalid?.length ?? 0;
	if (nInvalid > 0) lines.push(`(${nInvalid} invalid excluded)`);
	if (decision.winner) lines.push(`\n--- ruling ---\n${readableRuling(decision.winner)}`);
	if (decision.dissent && decision.dissent.length > 0) {
		lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map(dissentLine).join("\n\n")}`);
	}
	const headline = decision.winner ? rulingHeadline(decision.winner) : undefined;
	const result: AgentResult = {
		agent: "council",
		output: lines.join("\n"),
		structured: {
			status: decision.status,
			tally: decision.tally,
			rounds: round,
			usedFallback: decision.usedFallback,
			...(headline ? { headline } : {}),
		},
		usage: sumUsage(usages),
		ok: decision.winner !== undefined,
	};
	if (!result.ok) {
		const cause = summarizeFailedResults(candidates, "council produced no ruling");
		result.error = cause.error;
		result.failureKind = cause.failureKind;
	}
	return result;
}

const DEFAULT_ROUNDS = 3;

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}

/** A deliberation the run cancelled — distinct from one that finished without a ruling, so a
 *  journal or supervisor records it as cancelled rather than as a completed failure. */
function cancelled(rounds: number, usages: AgentResult["usage"][]): AgentResult {
	return {
		agent: "council",
		output: `COUNCIL cancelled after ${rounds} round(s) — the run was aborted before a ruling.`,
		structured: { status: "cancelled", rounds },
		usage: sumUsage(usages),
		ok: false,
		error: "the run was aborted",
		failureKind: "abort",
	};
}

export const councilRounds: Strategy = {
	name: "council-rounds",
	params: {
		rounds: { type: "number", default: 3, doc: "max deliberation rounds" },
		bestOf: { type: "number", doc: "default: majority of the roster" },
		aggregate: { type: "string", default: "majority", doc: '"majority" | "unanimity"' },
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("council-rounds: a roster is required");
		const maxRounds = positiveInteger(input.params.rounds, DEFAULT_ROUNDS);
		const bestOf = positiveInteger(input.params.bestOf, Math.floor(team.length / 2) + 1);
		const aggregate = input.params.aggregate === "unanimity" ? "unanimity" : "majority";

		const usages: AgentResult["usage"][] = [];
		let debate = "";
		let last: ReducerResult | undefined;

		for (let round = 1; round <= maxRounds; round++) {
			if (sdk.signal?.aborted) return cancelled(round - 1, usages);
			sdk.log(`council-rounds ${round}/${maxRounds} (best of ${bestOf})`);
			const task =
				round === 1
					? input.task
				: `${input.task}\n\n--- round ${round - 1} debate ---\n${fenceUntrusted(debate)}\n\nReconsider in light of the above and cast your vote again.`;
			const candidates = await sdk.parallel(
				team.map((m) => () => sdk.agent({ ...rosterSpec(m), task, outputContract: "default" })),
			);
			usages.push(...candidates.map((c) => c.usage));
			// An abort settles every member as ok:false/'abort' instead of throwing, so a stop that
			// landed while the round was running is first visible here — without this the council
			// keeps convening the whole roster for every remaining round, then reports a
			// normal-looking "no ruling". The loop guard above is a round too late for it.
			if (sdk.signal?.aborted || candidates.every((c) => c.failureKind === "abort")) return cancelled(round - 1, usages);
			const lastRound = round === maxRounds;
			last = sdk.reduce.vote(candidates, { aggregate, threshold: bestOf, keepBestFallback: lastRound });
			if (last.status === "winner" || lastRound) return render(last, round, bestOf, usages, candidates);
			debate = candidates
				.filter((c) => c.ok)
				.map((c) => `[${c.agent}] ${c.output}`)
				.join("\n");
		}
		// Unreachable: the loop always returns on the final round. Satisfies the type checker.
		return render(last as ReducerResult, maxRounds, bestOf, usages, []);
	},
};

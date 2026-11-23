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
import { clampBestOf, positiveInteger } from "../params.ts";
import { sumUsage, summarizeFailedResults } from "../reducers.ts";
import { dissentLine, notRunLine, readableRuling, rulingHeadline } from "../render.ts";
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
	/** Set when a run limit refused voters this round: the council stops convening here. */
	priorDebate?: string,
): AgentResult {
	const notRun = notRunLine(candidates);
	const lines: string[] = [];
	lines.push(
		`COUNCIL ruling after ${round} round(s), best-of-${bestOf}: ${decision.status}${
			decision.usedFallback ? " — fell back to best-by-confidence" : ""
		}${notRun ? " — stopped at a run limit" : ""}`,
	);
	lines.push(`tally: ${Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
	const nInvalid = decision.invalid?.length ?? 0;
	if (nInvalid > 0) lines.push(`(${nInvalid} invalid excluded)`);
	if (notRun) lines.push(notRun);
	if (decision.winner) lines.push(`\n--- ruling ---\n${readableRuling(decision.winner)}`);
	if (decision.dissent && decision.dissent.length > 0) {
		lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map(dissentLine).join("\n\n")}`);
	}
	const cast = decision.winner ? [] : candidates.filter((c) => c.ok);
	if (cast.length > 0) lines.push(`\n--- votes cast (no ruling) ---\n${cast.map(dissentLine).join("\n\n")}`);
	if (priorDebate) lines.push(`\n--- round ${round - 1} debate ---\n${fenceUntrusted(priorDebate)}`);
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
	when: "hard fork needing iterated debate: re-vote each round to a bestOf majority",
	team: "magi",
	params: {
		rounds: { type: "number", default: 3, doc: "max deliberation rounds" },
		bestOf: { type: "number", doc: "default: majority of the roster" },
		aggregate: { type: "string", default: "majority", doc: '"majority" | "unanimity"' },
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("council-rounds: a roster is required");
		const maxRounds = positiveInteger(input.params.rounds, DEFAULT_ROUNDS);
		const { bestOf } = clampBestOf(input.params.bestOf, team.length);
		const aggregate = input.params.aggregate === "unanimity" ? "unanimity" : "majority";

		const usages: AgentResult["usage"][] = [];
		let debate = "";
		let last: ReducerResult | undefined;
		// The previous round's voters and the debate that fed it: what a fully refused round reports.
		let previous: AgentResult[] = [];
		let previousDebate = "";

		for (let round = 1; round <= maxRounds; round++) {
			if (sdk.signal?.aborted) return cancelled(round - 1, usages);
			sdk.log(`council-rounds ${round}/${maxRounds} (best of ${bestOf})`);
			const task =
				round === 1
					? input.task
				: `${input.task}\n\n--- round ${round - 1} debate ---\n${fenceUntrusted(debate)}\n\nReconsider in light of the above and cast your vote again.`;
			const candidates = await sdk.parallel(
				team.map((m) => () =>
					sdk.agent(
						{ ...rosterSpec(m), task, outputContract: "default" },
						// Later rosters are not in the current parallel queue yet. Keep their worst-case
						// child budget intact while allowing recovery when a true spare slot remains.
						{ reserveChildren: (maxRounds - round) * team.length },
					),
				),
			);
			usages.push(...candidates.map((c) => c.usage));
			// An abort settles every member as ok:false/'abort' instead of throwing, so a stop that
			// landed while the round was running is first visible here — without this the council
			// keeps convening the whole roster for every remaining round, then reports a
			// normal-looking "no ruling". The loop guard above is a round too late for it.
			if (sdk.signal?.aborted || candidates.every((c) => c.failureKind === "abort")) return cancelled(round - 1, usages);
			// A voter the run's budget refused will be refused again next round: stop convening here.
			// The quorum decides over the votes cast, with no best-by-confidence fallback — a fallback
			// "ruling" from a panel that never fully convened is not one the council reached.
			if (candidates.some((c) => c.failureKind === "limit")) {
				// A round in which every voter was refused never convened: the last round that did is
				// the one reported (its decision already had no fallback, as it was not the final round).
				const decide = () => sdk.reduce.vote(candidates, { aggregate, threshold: bestOf, keepBestFallback: false });
				if (candidates.every((c) => c.failureKind === "limit")) {
					return render(last ?? decide(), round - 1, bestOf, usages, [...previous, ...candidates], previousDebate || undefined);
				}
				last = decide();
				return render(last, round, bestOf, usages, candidates, debate || undefined);
			}
			const lastRound = round === maxRounds;
			last = sdk.reduce.vote(candidates, { aggregate, threshold: bestOf, keepBestFallback: lastRound });
			if (last.status === "winner" || lastRound) return render(last, round, bestOf, usages, candidates);
			previous = candidates;
			previousDebate = debate;
			debate = candidates
				.filter((c) => c.ok)
				.map((c) => `[${c.agent}] ${c.output}`)
				.join("\n");
		}
		// Unreachable: the loop always returns on the final round. Satisfies the type checker.
		return render(last as ReducerResult, maxRounds, bestOf, usages, []);
	},
};

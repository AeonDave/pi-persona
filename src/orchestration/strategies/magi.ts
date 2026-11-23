/**
 * magi — the MagiSystem. Run a roster of distinct-persona "systems" on the same
 * question in parallel, each returning a structured vote, then decide by
 * majority (or unanimity), surfacing the tally and a minority report. Diversity
 * comes from the roster's personas; bias guards live in the vote reducer.
 *
 * Reflection round (params.reflect, default ON): after the independent round, each
 * core sees the PANEL's positions **anonymised** — its own among them, unmarked, because the
 * reflecting leg is a fresh session and that list is its only memory of round 1 — and casts a
 * FINAL vote, revising only if a genuinely new consideration moves it (holding is fine). This
 * lets a core catch a blind spot without turning MAGI into groupthink: the positions
 * are anonymised (no "defer to Casper" authority bias), it is exactly ONE round (not
 * iterate-to-consensus — that is `council-rounds`), and dissent is always preserved. A core whose
 * reflection leg fails keeps the valid vote it already cast (disclosed in the ruling footer).
 * Set `reflect: false` for a pure independent poll (uncorrelated errors, cheapest).
 */

import { fenceUntrusted } from "../../core/fence.ts";
import { clampBestOf } from "../params.ts";
import { sumUsage, summarizeFailedResults } from "../reducers.ts";
import { dissentLine, notRunLine, readableRuling as readable } from "../render.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";
import { rosterSpec } from "../roster.ts";

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A poll the run cancelled — distinct from one that finished without a ruling, so a
 *  journal or supervisor records it as cancelled rather than as a completed failure. */
function cancelled(usages: AgentResult["usage"][]): AgentResult {
	const output = "MAGI cancelled — the run was aborted before a ruling.";
	return {
		agent: "magi",
		output,
		structured: { status: "cancelled", reflected: false, headline: output },
		usage: sumUsage(usages),
		ok: false,
		error: "the run was aborted",
		failureKind: "abort",
	};
}

/**
 * Cores the shared SDK recovered onto the session's own model (`AgentResult.modelRecovery`). MAGI
 * does not decide the recovery — `sdk.agent` does it for every leg of every strategy — it only has
 * to (a) carry the rescued model into the reflection round and (b) disclose it in the ruling.
 */
function recoveredCores(results: readonly AgentResult[]): AgentResult[] {
	return results.filter((c) => c.ok && c.modelRecovery);
}

/** The model a SUCCESSFULLY recovered core must keep: the one that actually answered, never the
 *  model that broke. A twice-failed core keeps its roster model, so its reflection attempt is a
 *  genuine fresh chance on the configuration the roster chose. */
function rescuedModel(c: AgentResult | undefined): string | undefined {
	return c?.ok && c.modelRecovery ? (c.modelUsed ?? c.modelRecovery.to) : undefined;
}

export const magi: Strategy = {
	name: "magi",
	when: "contested fork: voters pick on a closed-choice question (yes/no, A/B); majority plus dissent",
	team: "magi",
	params: {
		aggregate: { type: "string", default: "majority", doc: '"majority" | "unanimity"' },
		reflect: { type: "boolean", default: true, doc: "one anonymised reflection round" },
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("magi: a roster of voting personas is required");
		if (sdk.signal?.aborted) return cancelled([]);
		const aggregate = input.params.aggregate === "unanimity" ? "unanimity" : "majority";
		const reflect = input.params.reflect !== false; // default ON — one informed round
		sdk.log(`magi: ${team.length} systems, ${aggregate} vote${reflect ? " + reflection" : ""}`);

		// Round 1 — each core answers INDEPENDENTLY (uncorrelated errors: the whole point).
		const round1 = await sdk.parallel(
			team.map((m) => () => sdk.agent({ ...rosterSpec(m), task: input.task, outputContract: "default" })),
		);

		// A core whose MODEL broke is not a dissenting voice, it is a missing one — and a poll of two
		// is a materially weaker poll. `sdk.agent` has already re-run such a core ONCE on the session's
		// own model — the SDK's main-only recovery, `provider`/`unknown-model` only, never a peer's
		// model — billed BOTH attempts onto that one result, and marked it with `modelRecovery`.
		// Diversity is the council's whole point, so recovery stays an exception that is disclosed in
		// the ruling, never a preference: each core's own model is untouched otherwise.
		const opening = round1;
		const rescued = recoveredCores(opening);

		// An abort settles every core as ok:false/'abort' instead of throwing, so a stop that
		// landed while round 1 was running is first visible here — without this MAGI re-polls the
		// whole roster for a reflection round nobody will read, then reports a "no ruling".
		if (sdk.signal?.aborted || round1.every((c) => c.failureKind === "abort")) {
			return cancelled(round1.map((c) => c.usage));
		}

		const okCount = opening.filter((c) => c.ok).length;
		// A reflection is meaningful only when every core can participate, so it needs at least one
		// token and one child per core left in the run's SHARED budget (a flow's other phases spend
		// it too). Starting a partial round would only buy refused legs.
		const left = sdk.remaining;
		const wantsReflection = reflect && okCount >= 2;
		const skip = !wantsReflection ? undefined
			: left.tokens < team.length
				? { why: "token budget", detail: `cannot fund the full panel (${left.tokens} of ${sdk.limits.budgetTokens} tokens left)` }
			: left.children < team.length
				? { why: "child budget", detail: `cannot fund the full panel (maxChildren ${sdk.limits.maxChildren}, ${left.children} left)` }
			: undefined;
		const didReflect = wantsReflection && !skip;
		if (skip) sdk.log(`magi: reflection skipped — ${skip.why} ${skip.detail}`);

		let reflected: AgentResult[] = [];
		if (didReflect) {
			// Round 2 — each core sees the panel's positions ANONYMISED (no author identity, so a
			// core can't defer to a "senior" peer) and casts its FINAL vote. Instructed to hold
			// unless genuinely moved, so this informs without manufacturing false consensus.
			const positions = opening
				.filter((c) => c.ok)
				.map((c, i) => `[Position ${LABELS[i] ?? `#${i + 1}`}]\n${fenceUntrusted(readable(c))}`)
				.join("\n\n");
			const reflectTask =
				`${input.task}\n\n--- the panel's positions so far (anonymised — judge them on merit, not source) ---\n${positions}\n\n` +
				`Reconsider ONLY if one of these raises a consideration that genuinely changes your analysis — it is perfectly fine to hold your original position through your own lens. ` +
				`Then cast your FINAL vote.`;
			// The recovered model must survive into this round: rebuilding from `rosterSpec(m)` alone
			// would hand the rescued core back the model that just broke, so it fails again, is
			// quarantined as invalid, and the recovery buys nothing but tokens.
			reflected = await sdk.parallel(
				team.map((m, i) => () => {
					const model = rescuedModel(opening[i]);
					return sdk.agent({ ...rosterSpec(m), ...(model ? { model } : {}), task: reflectTask, outputContract: "default" });
				}),
			);
			// Same reasoning as round 1, and both clauses earn their place. `sdk.signal` is wired
			// (the council/flow tools pass Pi's tool-execution signal down), but a stop that lands
			// DURING the reflection round is visible here only as every core settling
			// `failureKind: "abort"` — as is one on a caller that passed no signal. Without the
			// second clause a stopped run reports a normal-looking "no ruling" from a killed poll.
			if (sdk.signal?.aborted || reflected.every((c) => c.failureKind === "abort")) {
				return cancelled([...round1, ...reflected].map((c) => c.usage));
			}
		}
		// A reflection leg that FAILED (timeout, provider, contract, a run limit) is a missing second opinion, not a
		// missing voter: the core keeps the valid vote it already cast, so a 3-core poll stays a 3-core
		// poll. A STOPPED leg is never substituted. The substituted vote is not billed again (`allRuns`).
		const ballots = didReflect
			? reflected.map((r, i) => {
					const first = opening[i];
					return !r.ok && r.failureKind !== "abort" && first?.ok ? first : r;
				})
			: opening;
		const kept = didReflect ? ballots.filter((b, i) => b !== reflected[i]).length : 0;
		// "Reflected" means at least one core cast a second-round vote; a round that failed everywhere changed nothing.
		const reflectedAny = didReflect && kept < ballots.length;
		// A core a run limit refused is a missing ballot. Then the poll decides over the votes cast
		// with no best-by-confidence fallback, and a plurality must still be a majority of the FULL
		// roster: otherwise a lone surviving core would be reported as the panel's ruling.
		const refused = ballots.some((b) => b.failureKind === "limit");
		const decision = sdk.reduce.vote(ballots, {
			aggregate,
			keepBestFallback: !refused,
			...(refused ? { threshold: clampBestOf(undefined, team.length).bestOf } : {}),
		});

		// Lead with the ruling (the answer); the decision/tally plumbing is a compact footer,
		// not the headline. The collapsed council card shows `headline`; the supervisor still
		// receives the full text (ruling + dissent + footer).
		const lines: string[] = [];
		if (decision.winner) lines.push(readable(decision.winner));
		if (decision.dissent && decision.dissent.length > 0) {
			lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map(dissentLine).join("\n\n")}`);
		}
		const cast = decision.winner ? [] : ballots.filter((b) => b.ok);
		if (cast.length > 0) lines.push(`\n--- votes cast (no ruling) ---\n${cast.map(dissentLine).join("\n\n")}`);
		const tally = Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
		const invalid = decision.invalid && decision.invalid.length > 0 ? ` · ${decision.invalid.length} invalid excluded` : "";
		// State the recovery in the RULING, not only through sdk.log — which no production caller
		// sinks. A reader must be able to tell that a core argued on a borrowed model, because that
		// is exactly the diversity the tally silently lost.
		const rescuedLine = rescued.length > 0
			? ` · ${rescued.length} core${rescued.length === 1 ? "" : "s"} recovered on ${[...new Set(rescued.map((c) => c.modelRecovery?.to ?? ""))].filter(Boolean).join(", ")}`
			: "";
		const keptLine = kept > 0 ? ` · ${kept} core${kept === 1 ? "" : "s"} kept their round-1 vote (reflection failed)` : "";
		const skipLine = skip ? ` · reflection skipped (${skip.why})` : "";
		const notRun = notRunLine(ballots);
		const notRunPart = notRun ? ` · ${notRun}` : "";
		lines.push(
			`\n— magi: ${decision.status}${reflectedAny ? " (after 1 reflection round)" : ""}${decision.usedFallback ? " · fell back to best-by-confidence" : ""} · tally ${tally}${invalid}${notRunPart}${rescuedLine}${keptLine}${skipLine}`,
		);

		const winnerResult = decision.winner?.structured?.result;
		const headline = decision.winner
			? typeof winnerResult === "string" && winnerResult.trim()
				? winnerResult.trim()
				: readable(decision.winner).split("\n")[0] ?? decision.status
			: decision.status;

		// Usage sums EVERY run the poll actually paid for: the opening round (each logical result
		// already carries its rescue's tokens exactly once) and the reflection round, kept separate
		// from the opening one when reflection ran.
		const allRuns: AgentResult[] = [...round1, ...reflected];
		const result: AgentResult = {
			agent: "magi",
			output: lines.join("\n"),
			structured: { status: decision.status, tally: decision.tally, usedFallback: decision.usedFallback, reflected: reflectedAny, headline },
			usage: sumUsage(allRuns.map((c) => c.usage)),
			ok: decision.winner !== undefined,
		};
		if (!result.ok) {
			const cause = summarizeFailedResults(ballots, "magi produced no ruling");
			result.error = cause.error;
			result.failureKind = cause.failureKind;
		}
		return result;
	},
};

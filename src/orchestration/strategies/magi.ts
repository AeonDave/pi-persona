/**
 * magi — the MagiSystem. Run a roster of distinct-persona "systems" on the same
 * question in parallel, each returning a structured vote, then decide by
 * majority (or unanimity), surfacing the tally and a minority report. Diversity
 * comes from the roster's personas; bias guards live in the vote reducer.
 *
 * Reflection round (params.reflect, default ON): after the independent round, each
 * core sees the OTHER cores' positions **anonymised** and casts a FINAL vote —
 * revising only if a genuinely new consideration moves it (holding is fine). This
 * lets a core catch a blind spot without turning MAGI into groupthink: the positions
 * are anonymised (no "defer to Casper" authority bias), it is exactly ONE round (not
 * iterate-to-consensus — that is `council-rounds`), and dissent is always preserved.
 * Set `reflect: false` for a pure independent poll (uncorrelated errors, cheapest).
 */

import { fenceUntrusted } from "../../core/fence.ts";
import { planModelRetries } from "../model-retry.ts";
import { sumUsage, summarizeFailedResults } from "../reducers.ts";
import { dissentLine, readableRuling as readable } from "../render.ts";
import type { Strategy, StrategySDK } from "../sdk.ts";
import type { AgentResult } from "../types.ts";
import { type RosterMember, rosterSpec } from "../roster.ts";

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

interface Recovery {
	/** Round 1 with each successful recovery spliced into its original roster position. */
	results: AgentResult[];
	/** Every retry leg that actually ran, so usage can bill what the run really spent. */
	attempts: AgentResult[];
	/** Roster index → the model that rescued it. MUST be carried into every LATER round: rebuilding a
	 *  spec from the roster alone would put the core straight back on the model that just broke. */
	models: Map<number, string>;
}

/**
 * Re-run the cores whose MODEL broke on one that this run proved works, and splice the recoveries
 * back into their original roster positions. Returns `round1` untouched when nothing qualifies.
 *
 * Exactly one pass: a core that fails again keeps its second failure and drops out of the vote
 * honestly, rather than looping. The abort signal is checked first, so a stopped run recovers
 * nothing.
 */
async function recoverBrokenModels(
	round1: AgentResult[],
	team: RosterMember[],
	task: string,
	sdk: StrategySDK,
	affordable: number,
): Promise<Recovery> {
	const nothing = { results: round1, attempts: [], models: new Map<number, string>() };
	if (sdk.signal?.aborted || affordable <= 0) return nothing;
	const wanted = planModelRetries(round1, { ...(sdk.sessionModel ? { sessionModel: sdk.sessionModel } : {}) });
	if (wanted.length === 0) return nothing;
	// Recovery is an ENHANCEMENT and must not spend the budget the rounds themselves need: exceeding
	// `maxChildren` throws out of sdk.agent(), which would turn a poll that had a ruling into no
	// ruling at all. Take what the run can afford, oldest-first, and say what was left behind.
	const plan = wanted.slice(0, affordable);
	for (const dropped of wanted.slice(affordable)) {
		sdk.log(`magi: ${dropped.agent} stays failed — no child budget left to retry it (maxChildren ${sdk.limits.maxChildren})`);
	}
	const recovered = [...round1];
	const attempts: AgentResult[] = [];
	const models = new Map<number, string>();
	let observedTokens = round1.reduce((total, result) => total + result.usage.input + result.usage.output, 0);
	for (let i = 0; i < plan.length; i++) {
		const retry = plan[i] as (typeof plan)[number];
		if (sdk.signal?.aborted) break;
		if (sdk.limits.budgetTokens > 0 && observedTokens >= sdk.limits.budgetTokens) {
			for (const dropped of plan.slice(i)) {
				sdk.log(`magi: ${dropped.agent} stays failed — token budget exhausted (${sdk.limits.budgetTokens})`);
			}
			break;
		}
		sdk.log(`magi: ${retry.agent} failed on ${retry.from ?? "its model"} — retrying on ${retry.model} (${retry.reason === "peer" ? "worked for a peer" : "session model"})`);
		const member = team[retry.index];
		// A member is always present: the plan indexes the round the team produced. Retries are
		// deliberately serial so each completed attempt updates the observable token remainder before
		// another billed leg is allowed to start.
		const attempt = await sdk.agent({ ...rosterSpec(member as RosterMember), model: retry.model, task, outputContract: "default" });
		attempts.push(attempt);
		observedTokens += attempt.usage.input + attempt.usage.output;
		// Keep the ORIGINAL failure when the retry failed too: the first error is the one that
		// describes the core's own model, which is what a reader needs to fix the roster — and a
		// twice-failed core keeps NO override, so it re-runs on its own model and fails honestly.
		if (!attempt.ok) continue;
		recovered[retry.index] = attempt;
		models.set(retry.index, retry.model);
	}
	// Every attempt is returned separately: a recovery REPLACES a failed result, so summing the
	// final array alone would bill the run for less than it actually spent.
	return { results: recovered, attempts, models };
}

export const magi: Strategy = {
	name: "magi",
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
		// is a materially weaker poll. Re-run just those cores, ONCE, on a model this run proved works
		// (a healthy peer's, else the session's own). Only provider/unknown-model failures qualify:
		// an abort or a contract violation reproduces on any model, and a retried abort would be a
		// stop that does not stop. Diversity is the council's whole point, so this never runs as a
		// preference — it is the difference between a degraded poll and a lost vote, and it is logged.
		// Round 1 has spent one child per member, and the reflection round (when it runs) will spend
		// another; whatever is left is what recovery may use.
		const reserved = team.length * (reflect ? 2 : 1);
		const recovery = await recoverBrokenModels(round1, team, input.task, sdk, sdk.limits.maxChildren - reserved);
		const opening = recovery.results;

		// An abort settles every core as ok:false/'abort' instead of throwing, so a stop that
		// landed while round 1 was running is first visible here — without this MAGI re-polls the
		// whole roster for a reflection round nobody will read, then reports a "no ruling".
		if (sdk.signal?.aborted || round1.every((c) => c.failureKind === "abort")) {
			return cancelled([...round1, ...recovery.attempts].map((c) => c.usage));
		}

		let candidates = opening;
		const okCount = opening.filter((c) => c.ok).length;
		const tokensBeforeReflection = [...round1, ...recovery.attempts].reduce(
			(total, result) => total + result.usage.input + result.usage.output,
			0,
		);
		// A reflection is meaningful only when every core can participate. Under an active token
		// budget, reserve the observable minimum of one token per leg instead of starting a partial
		// round (or letting every parallel leg race past an already exhausted SDK counter).
		const reflectionHasTokenRoom =
			sdk.limits.budgetTokens <= 0 || tokensBeforeReflection + team.length <= sdk.limits.budgetTokens;
		const didReflect = reflect && okCount >= 2 && reflectionHasTokenRoom;
		if (reflect && okCount >= 2 && !reflectionHasTokenRoom) {
			sdk.log(`magi: reflection skipped — token budget cannot fund the full panel (${sdk.limits.budgetTokens})`);
		}
		if (didReflect) {
			// Round 2 — each core sees the others' positions ANONYMISED (no author identity, so a
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
			candidates = await sdk.parallel(
				team.map((m, i) => () => {
					const model = recovery.models.get(i);
					return sdk.agent({ ...rosterSpec(m), ...(model ? { model } : {}), task: reflectTask, outputContract: "default" });
				}),
			);
			// Same reasoning as round 1, and both clauses earn their place. `sdk.signal` is wired
			// (the council/flow tools pass Pi's tool-execution signal down), but a stop that lands
			// DURING the reflection round is visible here only as every core settling
			// `failureKind: "abort"` — as is one on a caller that passed no signal. Without the
			// second clause a stopped run reports a normal-looking "no ruling" from a killed poll.
			if (sdk.signal?.aborted || candidates.every((c) => c.failureKind === "abort")) {
				return cancelled([...round1, ...recovery.attempts, ...candidates].map((c) => c.usage));
			}
		}
		const decision = sdk.reduce.vote(candidates, { aggregate, keepBestFallback: true });

		// Lead with the ruling (the answer); the decision/tally plumbing is a compact footer,
		// not the headline. The collapsed council card shows `headline`; the supervisor still
		// receives the full text (ruling + dissent + footer).
		const lines: string[] = [];
		if (decision.winner) lines.push(readable(decision.winner));
		if (decision.dissent && decision.dissent.length > 0) {
			lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map(dissentLine).join("\n\n")}`);
		}
		const tally = Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
		const invalid = decision.invalid && decision.invalid.length > 0 ? ` · ${decision.invalid.length} invalid excluded` : "";
		// State the recovery in the RULING, not only through sdk.log — which no production caller
		// sinks. A reader must be able to tell that a core argued on a borrowed model, because that
		// is exactly the diversity the tally silently lost.
		const rescued = recovery.models.size > 0
			? ` · ${recovery.models.size} core${recovery.models.size === 1 ? "" : "s"} recovered on ${[...new Set(recovery.models.values())].join(", ")}`
			: "";
		lines.push(
			`\n— magi: ${decision.status}${didReflect ? " (after 1 reflection round)" : ""}${decision.usedFallback ? " · fell back to best-by-confidence" : ""} · tally ${tally}${invalid}${rescued}`,
		);

		const winnerResult = decision.winner?.structured?.result;
		const headline = decision.winner
			? typeof winnerResult === "string" && winnerResult.trim()
				? winnerResult.trim()
				: readable(decision.winner).split("\n")[0] ?? decision.status
			: decision.status;

		// Usage sums EVERY run the poll actually paid for: the opening round, any model recovery,
		// and the reflection round (separate from the opening one when reflection ran).
		const allRuns: AgentResult[] = didReflect ? [...round1, ...recovery.attempts, ...candidates] : [...round1, ...recovery.attempts];
		const result: AgentResult = {
			agent: "magi",
			output: lines.join("\n"),
			structured: { status: decision.status, tally: decision.tally, usedFallback: decision.usedFallback, reflected: didReflect, headline },
			usage: sumUsage(allRuns.map((c) => c.usage)),
			ok: decision.winner !== undefined,
		};
		if (!result.ok) {
			const cause = summarizeFailedResults(candidates, "magi produced no ruling");
			result.error = cause.error;
			result.failureKind = cause.failureKind;
		}
		return result;
	},
};

/**
 * critic-loop — the Antagonist. A generator proposes, a critic attacks; while
 * the critic's stance is `reject`, the generator revises, up to `rounds`.
 *
 * params = { generator?: "<agent>", critic?: "<agent>", rounds?: number (default 3) }
 */

import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { AgentRunSpec, Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

/** A loop the run cancelled — distinct from work the critic rejected or failed to review,
 *  so a journal or supervisor records it as cancelled rather than as a failed review. */
function cancelled(rounds: number, output: string, usages: AgentResult["usage"][]): AgentResult {
	return {
		agent: "critic-loop",
		output,
		structured: { rounds, criticOk: false, cancelled: true },
		usage: sumUsage(usages),
		ok: false,
		error: "the run was aborted",
		failureKind: "abort",
	};
}

export const criticLoop: Strategy = {
	name: "critic-loop",
	params: {
		generator: { type: "string", doc: "optional — overrides roster member 0" },
		critic: { type: "string", doc: "optional — overrides roster member 1" },
		rounds: { type: "number", default: 3, doc: "max generate/critique rounds" },
	},
	async run(input, sdk) {
		const rosterAgents = input.roster ? sdk.roster.team(input.roster) : [];
		// generator + critic are the roster's two members; a params NAME override selects a bare agent.
		const memberSpec = (idx: number, override: unknown, fallback: string): AgentRunSpec => {
			if (typeof override === "string" && override.trim()) return { agent: override.trim(), task: "" };
			const m = rosterAgents[idx];
			return m ? { ...rosterSpec(m), task: "" } : { agent: fallback, task: "" };
		};
		const genSpec = memberSpec(0, input.params.generator, "operator");
		const criticSpec = memberSpec(1, input.params.critic, "verifier");
		const maxRounds = typeof input.params.rounds === "number" ? input.params.rounds : 3;

		const all: AgentResult[] = [];
		if (sdk.signal?.aborted) return cancelled(0, "", []);
		let work = await sdk.agent({ ...genSpec, task: input.task });
		all.push(work);
		// A stop that lands WHILE a leg is running shows up only as that leg settling — `sdk.signal`
		// (checked at the boundaries) is read a round too late for it, and a caller may pass none at
		// all. So this check (and the two below) tests the leg. Nothing was drafted here, and
		// `criticOk` must not read as "the critic was fine" when no critique ever ran.
		if (!work.ok && work.failureKind === "abort") return cancelled(0, work.output, all.map((r) => r.usage));
		let rounds = 0;
		let criticFailure: AgentResult | undefined;

		// A failed generation leaves nothing to review — critiquing an empty draft only spends
		// another run.
		for (let round = 1; work.ok && round <= maxRounds; round++) {
			// An abort settles each leg as ok:false/'abort' instead of throwing, so without this
			// the loop keeps spending a critic and a generator on every remaining round.
			if (sdk.signal?.aborted) return cancelled(round - 1, work.output, all.map((r) => r.usage));
			rounds = round;
			sdk.log(`critic-loop round ${round}/${maxRounds}`);
			const critique = await sdk.agent({
				...criticSpec,
				task: `Critically review the work below and find every flaw. Return your stance (approve|reject|revise).\n\n${work.output}`,
				outputContract: "default",
			});
			all.push(critique);
			// A critique that FAILED carries no stance, and an absent stance must never read as
			// approval — that would hand back unreviewed work as having survived the antagonist.
			if (!critique.ok) {
				// A stopped run is not a review that failed: keep the draft the critic was reading.
				if (critique.failureKind === "abort") return cancelled(round, work.output, all.map((r) => r.usage));
				criticFailure = critique;
				break;
			}
			if (critique.structured?.stance !== "reject") break;
			const revised = await sdk.agent({
				...genSpec,
				task: `Revise the work to address the critique.\n\n--- WORK ---\n${work.output}\n\n--- CRITIQUE ---\n${critique.output}`,
			});
			all.push(revised);
			// A revision the run stopped is an EMPTY result — assigning it to `work` would throw
			// away the hardened draft the loop already paid for and report "" as the answer.
			if (!revised.ok && revised.failureKind === "abort") return cancelled(round, work.output, all.map((r) => r.usage));
			work = revised;
		}

		// Return the hardened work, with usage summed across the WHOLE loop and a strategy
		// identity (consistent with the other built-ins).
		const result: AgentResult = {
			agent: "critic-loop",
			output: work.output,
			usage: sumUsage(all.map((r) => r.usage)),
			ok: work.ok && !criticFailure,
		};
		result.structured = { rounds, criticOk: !criticFailure, ...(work.structured ?? {}) };
		const cause = criticFailure ?? (work.ok ? undefined : work);
		if (cause) {
			result.error = criticFailure
				? `the critic failed: ${criticFailure.error ?? "no critique produced"}`
				: (cause.error ?? "the generator failed");
			if (cause.failureKind) result.failureKind = cause.failureKind;
		}
		return result;
	},
};

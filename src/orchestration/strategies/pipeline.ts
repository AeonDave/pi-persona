/**
 * pipeline — run the roster agents in SEQUENCE, each building on the previous one's
 * output (a chain / refinement / debate shape, vs `fanout`'s parallel and `magi`'s vote).
 * The built-in behind L1 `mode: pipeline`. The pipeline's answer is the LAST step's output
 * (the culmination); usage is summed across the chain and a failed step stops it.
 */

import { emptyUsage } from "../../engine/stream.ts";
import { fenceUntrusted } from "../../core/fence.ts";
import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

/** A chain the run cancelled — distinct from one a step failed, so a journal or supervisor
 *  records it as cancelled rather than as a broken step. The work already produced rides
 *  along: it cost real tokens and is still the best thing to show. */
function cancelled(results: AgentResult[], upstream: string): AgentResult {
	return {
		agent: "pipeline",
		output: upstream || "(no output)",
		structured: { steps: results.length, cancelled: true },
		usage: results.length > 0 ? sumUsage(results.map((r) => r.usage)) : emptyUsage(),
		ok: false,
		error: "the run was aborted",
		failureKind: "abort",
	};
}

function failed(results: AgentResult[], upstream: string, step: AgentResult): AgentResult {
	const cause = step.error ?? step.output ?? "failed";
	const failedStep = `--- failed step (${step.agent}): ${cause} ---`;
	const result: AgentResult = {
		agent: "pipeline",
		output: upstream ? `${upstream}\n\n${failedStep}` : (step.output || failedStep),
		usage: results.length > 0 ? sumUsage(results.map((r) => r.usage)) : emptyUsage(),
		ok: false,
	};
	if (step.error) result.error = step.error;
	if (step.failureKind) result.failureKind = step.failureKind;
	if (step.structured) result.structured = step.structured;
	return result;
}

export const pipeline: Strategy = {
	name: "pipeline",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("pipeline: a non-empty roster is required");
		sdk.log(`pipeline: ${team.length} agents in sequence`);

		const results: AgentResult[] = [];
		let upstream = "";
		for (const member of team) {
			// An abort settles a step as ok:false/'abort' instead of throwing, and one that lands
			// between steps marks nothing at all — either way the chain must stop here rather than
			// walk the rest of the roster.
			if (sdk.signal?.aborted) return cancelled(results, upstream);
			const task = upstream
				? `${input.task}\n\n--- previous step's output (build on it) ---\n${fenceUntrusted(upstream)}`
				: input.task;
			const r = await sdk.agent({ ...rosterSpec(member), task });
			results.push(r);
			if (!r.ok) {
				// A stop that lands WHILE this step runs settles it here, never at the loop guard
				// above (the chain already broke): that guard reads `sdk.signal`, which is wired but
				// only consulted BETWEEN steps. Report it as a cancelled chain that keeps the
				// upstream work, not as a failed step whose empty output replaces it.
				if (r.failureKind === "abort") return cancelled(results, upstream);
				return failed(results, upstream, r);
			}
			if (r.output) upstream = r.output;
		}

		const last = results[results.length - 1];
		const result: AgentResult = {
			agent: "pipeline",
			output: last?.output ?? "(no output)",
			usage: results.length > 0 ? sumUsage(results.map((r) => r.usage)) : emptyUsage(),
			ok: results.length === team.length && results.every((r) => r.ok),
		};
		if (last?.structured) result.structured = last.structured;
		// The chain breaks AT the failing step, so `last` carries the cause — without it the phase
		// renders as failed with an empty output and nothing to act on.
		if (!result.ok && last && !last.ok) {
			if (last.error) result.error = last.error;
			if (last.failureKind) result.failureKind = last.failureKind;
		}
		return result;
	},
};

/**
 * pipeline — run the roster agents in SEQUENCE, each building on the previous one's
 * output (a chain / refinement / debate shape, vs `fanout`'s parallel and `magi`'s vote).
 * The built-in behind L1 `mode: pipeline`. The pipeline's answer is the LAST step's output
 * (the culmination); usage is summed across the chain and a failed step stops it.
 */

import { emptyUsage } from "../../engine/stream.ts";
import { sumUsage } from "../reducers.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

export const pipeline: Strategy = {
	name: "pipeline",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("pipeline: a non-empty roster is required");
		sdk.log(`pipeline: ${team.length} agents in sequence`);

		const results: AgentResult[] = [];
		let upstream = "";
		for (const agent of team) {
			const task = upstream ? `${input.task}\n\n--- previous step's output (build on it) ---\n${upstream}` : input.task;
			const r = await sdk.agent({ agent, task });
			results.push(r);
			if (!r.ok) break; // a failed step stops the chain — its dependents can't build on nothing
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
		return result;
	},
};

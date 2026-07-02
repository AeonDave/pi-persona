/**
 * critic-loop — the Antagonist. A generator proposes, a critic attacks; while
 * the critic's stance is `reject`, the generator revises, up to `rounds`.
 */

import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

export const criticLoop: Strategy = {
	name: "critic-loop",
	async run(input, sdk) {
		const rosterAgents = input.roster ? sdk.roster.team(input.roster) : [];
		// generator + critic are the roster's two entities (params can still override).
		const generator = str(input.params.generator, rosterAgents[0] ? rosterSpec(rosterAgents[0]).agent : "operator");
		const critic = str(input.params.critic, rosterAgents[1] ? rosterSpec(rosterAgents[1]).agent : "verifier");
		const maxRounds = typeof input.params.rounds === "number" ? input.params.rounds : 3;

		const all: AgentResult[] = [];
		let work = await sdk.agent({ agent: generator, task: input.task });
		all.push(work);
		let rounds = 0;

		for (let round = 1; round <= maxRounds; round++) {
			rounds = round;
			sdk.log(`critic-loop round ${round}/${maxRounds}`);
			const critique = await sdk.agent({
				agent: critic,
				task: `Critically review the work below and find every flaw. Return your stance (approve|reject|revise).\n\n${work.output}`,
				outputContract: "default",
			});
			all.push(critique);
			if (critique.structured?.stance !== "reject") break;
			work = await sdk.agent({
				agent: generator,
				task: `Revise the work to address the critique.\n\n--- WORK ---\n${work.output}\n\n--- CRITIQUE ---\n${critique.output}`,
			});
			all.push(work);
		}

		// Return the hardened work, with usage summed across the WHOLE loop and a strategy
		// identity (consistent with the other built-ins).
		const result: AgentResult = { agent: "critic-loop", output: work.output, usage: sumUsage(all.map((r) => r.usage)), ok: work.ok };
		result.structured = { rounds, ...(work.structured ?? {}) };
		return result;
	},
};

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
		let work = await sdk.agent({ ...genSpec, task: input.task });
		all.push(work);
		let rounds = 0;

		for (let round = 1; round <= maxRounds; round++) {
			rounds = round;
			sdk.log(`critic-loop round ${round}/${maxRounds}`);
			const critique = await sdk.agent({
				...criticSpec,
				task: `Critically review the work below and find every flaw. Return your stance (approve|reject|revise).\n\n${work.output}`,
				outputContract: "default",
			});
			all.push(critique);
			if (critique.structured?.stance !== "reject") break;
			work = await sdk.agent({
				...genSpec,
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

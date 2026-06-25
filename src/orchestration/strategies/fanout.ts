/**
 * fanout — run every agent in the roster on the same task, in parallel, and
 * aggregate the results. The built-in behind L1 `mode: parallel`.
 */

import type { Strategy } from "../sdk.ts";

export const fanout: Strategy = {
	name: "fanout",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("fanout: a non-empty roster is required");
		sdk.log(`fanout: ${team.length} agents on "${input.task.slice(0, 40)}"`);
		const results = await sdk.parallel(team.map((agent) => () => sdk.agent({ agent, task: input.task })));
		return sdk.reduce.aggregate(results);
	},
};

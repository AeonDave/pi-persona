/**
 * magi — the MagiSystem. Run a roster of distinct-persona "systems" on the same
 * question in parallel, each returning a structured vote, then decide by
 * majority (or unanimity), surfacing the tally and a minority report. Diversity
 * comes from the roster's personas; bias guards live in the vote reducer.
 */

import { sumUsage } from "../reducers.ts";
import type { Strategy } from "../sdk.ts";

export const magi: Strategy = {
	name: "magi",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("magi: a roster of voting personas is required");
		const aggregate = input.params.aggregate === "unanimity" ? "unanimity" : "majority";
		sdk.log(`magi: ${team.length} systems, ${aggregate} vote`);

		const candidates = await sdk.parallel(
			team.map((agent) => () => sdk.agent({ agent, task: input.task, outputContract: "default" })),
		);
		const decision = sdk.reduce.vote(candidates, { aggregate, keepBestFallback: true });

		const lines: string[] = [];
		lines.push(
			`MAGI decision (${aggregate}): ${decision.status}${decision.usedFallback ? " — fell back to best-by-confidence" : ""}`,
		);
		lines.push(`tally: ${Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
		if (decision.winner) lines.push(`\n--- ruling ---\n${decision.winner.output}`);
		if (decision.dissent && decision.dissent.length > 0) {
			lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map((d) => `[${d.agent}] ${d.output}`).join("\n")}`);
		}
		if (decision.invalid && decision.invalid.length > 0) {
			lines.push(`\n(${decision.invalid.length} invalid output(s) excluded from the vote)`);
		}

		return {
			agent: "magi",
			output: lines.join("\n"),
			structured: { status: decision.status, tally: decision.tally, usedFallback: decision.usedFallback },
			usage: sumUsage(candidates.map((c) => c.usage)),
			ok: decision.winner !== undefined,
		};
	},
};

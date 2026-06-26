/**
 * magi — the MagiSystem. Run a roster of distinct-persona "systems" on the same
 * question in parallel, each returning a structured vote, then decide by
 * majority (or unanimity), surfacing the tally and a minority report. Diversity
 * comes from the roster's personas; bias guards live in the vote reducer.
 */

import { sumUsage } from "../reducers.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

/** A member's human-readable position from its structured fields (result + output),
 *  NOT the raw JSON envelope — so the ruling/dissent read as prose, not as tool JSON. */
function readable(r: AgentResult): string {
	const s = r.structured;
	if (s) {
		const parts: string[] = [];
		if (typeof s.result === "string" && s.result.trim()) parts.push(s.result.trim());
		if (typeof s.output === "string" && s.output.trim()) parts.push(s.output.trim());
		if (parts.length > 0) return parts.join("\n\n");
	}
	return r.output.trim();
}

/** A one-line dissent entry: who, how they voted, and their one-line position. */
function dissentLine(r: AgentResult): string {
	const s = r.structured;
	const vote = s && typeof s.vote === "string" && s.vote.trim() ? s.vote.trim() : "?";
	const summary = s && typeof s.result === "string" && s.result.trim() ? s.result.trim() : r.output.trim();
	return `[${r.agent} · ${vote}] ${summary}`;
}

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
		lines.push(
			`\n— magi: ${decision.status}${decision.usedFallback ? " (fell back to best-by-confidence)" : ""} · tally ${tally}${invalid}`,
		);

		const winnerResult = decision.winner?.structured?.result;
		const headline = decision.winner
			? typeof winnerResult === "string" && winnerResult.trim()
				? winnerResult.trim()
				: readable(decision.winner).split("\n")[0] ?? decision.status
			: decision.status;

		return {
			agent: "magi",
			output: lines.join("\n"),
			structured: { status: decision.status, tally: decision.tally, usedFallback: decision.usedFallback, headline },
			usage: sumUsage(candidates.map((c) => c.usage)),
			ok: decision.winner !== undefined,
		};
	},
};

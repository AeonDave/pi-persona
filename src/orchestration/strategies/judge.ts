/**
 * judge — a panel answers the task independently (parallel), then ONE impartial judge
 * picks the best. The judge-based counterpart to `magi`'s self-vote: use it when you want
 * a strong synthesiser/arbiter rather than a tally. Bias guard (§4.3): candidates are
 * anonymised + reordered before the judge sees them (via `reduce.judge`), so identity and
 * position can't sway the pick. Built entirely on the SDK — no new engine surface.
 *
 * roster  = the panel (the candidate generators)
 * params  = { judge: "<agent>", contract?: "<name>" }
 *   - judge:    the arbiter agent (separate from the panel)
 *   - contract: optional — run the panel against this contract so its members emit
 *     structured positions; the ballot then shows the readable field, not a raw JSON
 *     blob. Lets voting cores (e.g. the MAGI triad) double as a judge panel cleanly.
 *     Omit it for a prose panel (candidates shown verbatim, as before).
 */

import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

/** A random permutation of [0..n) — so the judge can't be biased by candidate order. */
function shuffleOrder(n: number): number[] {
	const a = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j] as number, a[i] as number];
	}
	return a;
}

export const judge: Strategy = {
	name: "judge",
	async run(input, sdk) {
		const panel = input.roster ? sdk.roster.team(input.roster) : [];
		if (panel.length === 0) throw new Error("judge: a non-empty roster (the panel) is required");
		const arbiter = typeof input.params.judge === "string" ? input.params.judge : undefined;
		if (!arbiter) throw new Error("judge: params.judge (the arbiter agent) is required");
		const contract = typeof input.params.contract === "string" && input.params.contract.trim() ? input.params.contract.trim() : undefined;
		sdk.log(`judge: ${panel.length} candidates → arbiter ${arbiter}${contract ? ` (contract ${contract})` : ""}`);

		const candidates = await sdk.parallel(
			panel.map((m) => () => sdk.agent({ ...rosterSpec(m), task: input.task, ...(contract ? { outputContract: contract } : {}) })),
		);
		const valid = candidates.filter((c) => c.ok && c.output.trim());
		if (valid.length === 0) {
			return { agent: "judge", output: "(no valid candidates to judge)", usage: sumUsage(candidates.map((c) => c.usage)), ok: false };
		}

		// The text a judge should read for each candidate: the structured position when a
		// contract produced one (a JSON-emitting core), else the raw answer. `pick` returns
		// the same display object, so the winning `output` is the readable text, not JSON.
		const readable = (c: AgentResult): string => {
			const s = c.structured;
			if (s) {
				if (typeof s.output === "string" && s.output.trim()) return s.output.trim();
				if (typeof s.result === "string" && s.result.trim()) return s.result.trim();
			}
			return c.output.trim();
		};
		const display = valid.map((c) => ({ ...c, output: readable(c) }));

		const prep = sdk.reduce.judge(display, shuffleOrder(display.length));
		const verdict = await sdk.agent({
			agent: arbiter,
			task: `Judge these options for the task and pick the single best one. Be impartial — the options are anonymised.\n\nTask: ${input.task}\n\nOptions:\n${prep.ballot}\n\nReturn JSON ONLY: {"vote":"<the letter of your pick>","result":"<one-line verdict>","output":"<why it wins over the others>"}`,
			outputContract: "default",
		});
		const label = typeof verdict.structured?.vote === "string" ? verdict.structured.vote : "";
		const picked = prep.pick(label);

		const reasoning = (typeof verdict.structured?.output === "string" && verdict.structured.output) || verdict.output;
		const result: AgentResult = {
			agent: "judge",
			output: picked ? `${picked.output}\n\n— chosen by ${arbiter}: ${reasoning}` : `judge could not resolve a pick (verdict: ${verdict.output})`,
			usage: sumUsage([...candidates, verdict].map((r) => r.usage)),
			ok: picked !== undefined,
		};
		result.structured = { winner: picked?.agent ?? "?", pick: label, panel: panel.length };
		return result;
	},
};

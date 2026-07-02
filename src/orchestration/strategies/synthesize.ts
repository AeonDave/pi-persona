/**
 * synthesize — fan the roster out on the task in parallel, then ONE synthesiser agent
 * merges the labeled findings into a single coherent answer. This is the "reduce" that
 * `fanout` lacks (its aggregate is only concatenated sections): use it whenever the
 * ensemble's value is a unified deliverable — research sweeps, multi-angle reviews,
 * gather-then-write — rather than a vote (`magi`) or a pick (`judge`).
 *
 * roster = the gatherers · params = { synthesizer?: "<agent>" (default: the first roster agent) }
 */

import { rosterSpec } from "../roster.ts";
import { sumUsage } from "../reducers.ts";
import type { Strategy } from "../sdk.ts";

export const synthesize: Strategy = {
	name: "synthesize",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("synthesize: a non-empty roster (the gatherers) is required");
		const synthesizer =
			typeof input.params.synthesizer === "string" && input.params.synthesizer.trim()
				? input.params.synthesizer.trim()
				: rosterSpec(team[0]!).agent;
		sdk.log(`synthesize: ${team.length} gatherers → ${synthesizer}`);

		const results = await sdk.parallel(team.map((m) => () => sdk.agent({ ...rosterSpec(m), task: input.task })));
		const usable = results.filter((r) => r.ok && r.output.trim());
		if (usable.length === 0) {
			const reasons = results.map((r) => `[${r.agent}] ${r.error ?? "(no output)"}`).join("; ");
			return { agent: "synthesize", output: `(no gatherer produced output: ${reasons})`, usage: sumUsage(results.map((r) => r.usage)), ok: false };
		}

		const sections = usable.map((r) => `--- [${r.agent}] ---\n${r.output.trim()}`).join("\n\n");
		const final = await sdk.agent({
			agent: synthesizer,
			task:
				`Synthesise the findings below into ONE coherent, de-duplicated answer to the task. ` +
				`Resolve contradictions explicitly (say which finding you trusted and why) and keep every load-bearing detail.\n\n` +
				`Task: ${input.task}\n\nFindings:\n${sections}`,
		});

		// A one-line headline for the collapsed council card (the tool reads `headline`):
		// the synthesiser's `result` field if it emitted one, else the first non-empty line.
		const firstLine = final.output.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
		const structuredResult = final.structured?.result;
		const headline = (typeof structuredResult === "string" && structuredResult.trim() ? structuredResult : firstLine).slice(0, 120);

		return {
			agent: "synthesize",
			output: final.output,
			structured: { ...(final.structured ?? {}), gatherers: usable.length, headline },
			usage: sumUsage([...results, final].map((r) => r.usage)),
			ok: final.ok,
		};
	},
};

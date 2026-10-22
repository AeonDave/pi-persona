/**
 * synthesize — fan the roster out on the task in parallel, then ONE synthesiser agent
 * merges the labeled findings into a single coherent answer. This is the "reduce" that
 * `fanout` lacks (its aggregate is only concatenated sections): use it whenever the
 * ensemble's value is a unified deliverable — research sweeps, multi-angle reviews,
 * gather-then-write — rather than a vote (`magi`) or a pick (`judge`).
 *
 * roster = the gatherers · params = { synthesizer?: "<agent>" | { agent, role?, model?, skills? }
 *          (default: the first roster agent),
 *          peers?: boolean (gatherers share contradictions/corroborations live — default off) }
 */

import { rosterNodeKeys, rosterSpec } from "../roster.ts";
import { fenceUntrusted } from "../../core/fence.ts";
import { sanitizeStatusLabel } from "../../core/display-label.ts";
import { parseAuxActor } from "../params.ts";
import { sumUsage, summarizeFailedResults } from "../reducers.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

// Cooperative cross-talk (params.peers): gatherers surface contradictions early instead of
// leaving them all to the synthesizer. Task-text injection keeps UI tree keys stable.
const CROSS_TALK = [
	"You have sibling gatherers working OTHER angles of this same task. If you find something that",
	"contradicts or strongly corroborates what another angle would see, share it once via",
	"`contact_peer` (action `list`, then `send`) — short and factual. Incorporate any",
	'"[message from peer …]" notes you receive. No chatter: only load-bearing findings.',
].join(" ");

export const synthesize: Strategy = {
	name: "synthesize",
	when: "many angles into ONE deliverable: gatherers in parallel, one synthesiser merges",
	roster: "gatherers",
	team: "review",
	params: {
		// The default IS roster[0] — declared as `rosterIndex`, never as an agent name: the
		// participant collector resolves "override, else roster[rosterIndex], else `default`",
		// so a phrase here would spawn an agent that does not exist.
		synthesizer: { type: "agent", rosterIndex: 0, doc: "the merging agent, or an inline { agent, role?, model?, skills? } member; default: the first roster agent" },
		peers: { type: "boolean", default: false, doc: "gatherers share contradictions/corroborations live" },
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length === 0) throw new Error("synthesize: a non-empty roster (the gatherers) is required");
		// An explicit synthesizer is an author decision — a supplied-but-unusable value is a
		// typo to diagnose, never a quiet slide back onto the default (a gatherer merging its
		// own findings is the weaker merge the caller was avoiding).
		const synthesizerParam = parseAuxActor(input.params.synthesizer, "synthesizer");
		if (synthesizerParam && !synthesizerParam.ok) throw new Error(`synthesize: ${synthesizerParam.error}`);
		const synthesizer = synthesizerParam?.ok ? synthesizerParam.spec : rosterSpec(team[0]!);
		const synthesizerName = synthesizer.agent;
		const peers = input.params.peers === true;
		sdk.log(`synthesize: ${team.length} gatherers → ${synthesizerName}${peers ? " (cross-talk on)" : ""}`);
		if (peers && team.length > sdk.limits.maxConcurrency) {
			sdk.log(
				`synthesize: ${team.length} gatherers exceeds maxConcurrency (${sdk.limits.maxConcurrency}) — the live exchange will be batched (gatherers beyond the concurrency window join late)`,
			);
		}

		const results = await sdk.parallel(
			team.map((m) => () => sdk.agent({
					...rosterSpec(m),
					task: peers ? `${input.task}\n\n--- gatherer cross-talk ---\n${CROSS_TALK}` : input.task,
					...(peers ? { peers: true } : {}),
				}, { reserveChildren: 1 }), // leave the mandatory merge slot; SDK reserves queued gatherers
			),
		);
		// Lens-aware labels (`reviewer · SECURITY`): the synthesizer must see WHICH lens found what.
		const labels = rosterNodeKeys(team);
		const usable = results.flatMap((r, i) => (r.ok && r.output.trim() ? [{ label: labels[i], output: r.output.trim() }] : []));
		if (usable.length === 0) {
			const cause = summarizeFailedResults(results, "no gatherer produced output");
			const reasons = results.map((r, i) => `[${labels[i]}] ${r.error ?? "(no output)"}`).join("; ");
			return {
				agent: "synthesize",
				output: `(no gatherer produced output: ${reasons})`,
				usage: sumUsage(results.map((r) => r.usage)),
				ok: false,
				error: cause.error,
				failureKind: cause.failureKind,
			};
		}
		// A partial merge is useful, but a missing review lens is not a clean review. Carry the
		// runtime coverage into BOTH the merger's input and its returned output, even if it omits it.
		const missing = results.flatMap((r, i) => r.ok && r.output.trim() ? [] : [{
			member: sanitizeStatusLabel(labels[i] ?? r.agent),
			status: r.ok ? "empty" : "failed",
			detail: sanitizeStatusLabel(r.ok ? "no output" : r.error ?? "no failure detail", "no failure detail", 200),
		}]);
		const coverage = missing.length > 0 ? { expected: team.length, usable: usable.length, missing } : undefined;
		const coverageNote = coverage ? [
			`Incomplete coverage: ${usable.length}/${team.length} gatherers returned usable findings. Missing members were not reviewed; do not present this as a complete review.`,
			fenceUntrusted(missing.slice(0, 16).map((m) => `${m.member} — ${m.status}: ${m.detail}`).join("\n")),
			...(missing.length > 16 ? [`${missing.length - 16} additional missing members are recorded in the result's coverage metadata.`] : []),
		].join("\n") : "";

		const sections = usable.map((u) => `--- [${u.label}] ---\n${fenceUntrusted(u.output)}`).join("\n\n");
		const final = await sdk.agent({
			...synthesizer,
			task:
				`Synthesise the findings below into ONE coherent, de-duplicated answer to the task. ` +
				`Resolve contradictions explicitly (say which finding you trusted and why) and keep every load-bearing detail.\n\n` +
				(coverageNote ? `${coverageNote}\n\n` : "") +
				`Task: ${input.task}\n\nFindings:\n${sections}`,
		});

		// A one-line headline for the collapsed council card (the tool reads `headline`):
		// the synthesiser's `result` field if it emitted one, else the first non-empty line.
		const firstLine = final.output.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
		const structuredResult = final.structured?.result;
		const headline = `${coverage ? `Incomplete coverage: ${usable.length}/${team.length} · ` : ""}${typeof structuredResult === "string" && structuredResult.trim() ? structuredResult : firstLine}`.slice(0, 120);

		const result: AgentResult = {
			agent: "synthesize",
			output: coverageNote ? `${coverageNote}\n\n${final.output}` : final.output,
			structured: { ...(final.structured ?? {}), gatherers: usable.length, headline, ...(coverage ? { coverage } : {}) },
			usage: sumUsage([...results, final].map((r) => r.usage)),
			ok: final.ok,
		};
		if (!final.ok) {
			result.error = final.error ?? "the synthesizer failed";
			result.failureKind = final.failureKind ?? "agent";
		}
		return result;
	},
};

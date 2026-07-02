/**
 * compete — best-of-N implementations in ISOLATED worktrees, judged blind. Every
 * competitor attacks the same task with `isolation: "worktree"` (the engine routes it
 * through a throwaway detached checkout whose edits are DISCARDED at the end), so each
 * must deliver its work AS A UNIFIED DIFF at the tail of its answer. An impartial judge
 * picks on an anonymised, shuffled ballot (the same bias guards as `judge`); the strategy
 * returns the WINNING DIFF in full — the SUPERVISOR applies it (council pattern: the
 * executor applies the ruling; the strategy never touches the tree). No p2p between
 * competitors: independence is the point.
 *
 * REQUIRES a git repo: without one the isolation wrapper silently degrades to unisolated
 * runs sharing the real tree — do not convene compete there.
 *
 * roster = the competitors · params = { judge: "<agent>" (required),
 *          ballotDiffChars?: number (default 6000 — ballot-only clip; the winner is full) }
 */

import { shuffleOrder } from "../judge.ts";
import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";

const DIFF_PROTOCOL = [
	"You are ONE of several competitors implementing this task independently in an ISOLATED git",
	"worktree — your edits are discarded when you finish, so the diff IS your deliverable.",
	"When your implementation is complete and verified: run `git add -N .` (so new files show up),",
	"then `git diff`, and END your answer with a one-paragraph summary of your approach followed",
	"by the COMPLETE unified diff in a ```diff fenced block. An empty diff means you failed.",
].join(" ");

const BALLOT_DIFF_CHARS = 6000;
const TAIL_DIFF_FENCE = /```diff\n([\s\S]*?)```\s*$/;

/** The tail ```diff fence of a competitor's answer (its deliverable), or undefined. */
function extractDiff(output: string): string | undefined {
	const body = output.match(TAIL_DIFF_FENCE)?.[1]?.trim();
	return body ? body : undefined;
}

/** Clip a diff for the ballot only — the winner's diff is always returned in full. */
function clip(diff: string, max: number): string {
	if (diff.length <= max) return diff;
	return `${diff.slice(0, max)}\n…[diff clipped for the ballot — ${diff.length - max} more chars; the full diff survives in the winner]`;
}

export const compete: Strategy = {
	name: "compete",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length < 2) throw new Error("compete: a roster of at least 2 competitors is required");
		const arbiter = typeof input.params.judge === "string" && input.params.judge.trim() ? input.params.judge.trim() : undefined;
		if (!arbiter) throw new Error("compete: params.judge (the arbiter agent) is required");
		const ballotChars =
			typeof input.params.ballotDiffChars === "number" && input.params.ballotDiffChars > 0
				? input.params.ballotDiffChars
				: BALLOT_DIFF_CHARS;
		sdk.log(`compete: ${team.length} competitors in isolated worktrees → judge ${arbiter}`);

		const candidates = await sdk.parallel(
			team.map((m) => () =>
				sdk.agent({
					...rosterSpec(m),
					task: `${input.task}\n\n--- competition protocol ---\n${DIFF_PROTOCOL}`,
					isolation: "worktree",
				}),
			),
		);
		const valid: Array<{ result: AgentResult; diff: string }> = [];
		for (const c of candidates) {
			const diff = c.ok ? extractDiff(c.output) : undefined;
			if (diff) valid.push({ result: c, diff });
		}
		if (valid.length === 0) {
			const reasons = candidates.map((c) => `[${c.agent}] ${c.ok ? "no tail ```diff fence" : (c.error ?? "failed")}`).join("; ");
			return {
				agent: "compete",
				output: `(no competitor delivered a diff: ${reasons})`,
				usage: sumUsage(candidates.map((c) => c.usage)),
				ok: false,
			};
		}

		// Blind ballot: each candidate is its approach summary (the answer minus the diff fence)
		// + a clipped diff — anonymised and shuffled by the shared judge prep (§4.3 bias guards).
		const display = valid.map(({ result, diff }) => ({
			...result,
			output: `${result.output.replace(TAIL_DIFF_FENCE, "").trim()}\n\n${clip(diff, ballotChars)}`,
		}));
		const prep = sdk.reduce.judge(display, shuffleOrder(display.length));
		const verdict = await sdk.agent({
			agent: arbiter,
			task:
				`Judge these competing implementations (each: approach summary + unified diff) and pick the single best — ` +
				`correctness first, then simplicity and fit. Be impartial: the candidates are anonymised.\n\n` +
				`Task: ${input.task}\n\nCandidates:\n${prep.ballot}\n\n` +
				`Return JSON ONLY: {"vote":"<the letter of your pick>","result":"<one-line verdict>","output":"<why it wins>"}`,
			outputContract: "default",
		});
		const label = typeof verdict.structured?.vote === "string" ? verdict.structured.vote : "";
		const picked = prep.pick(label);
		// prep.pick returns the display object by reference, so its index maps back to `valid`.
		const winner = picked ? valid[display.indexOf(picked)] : undefined;
		const usage = sumUsage([...candidates, verdict].map((r) => r.usage));
		if (!winner) {
			return { agent: "compete", output: `compete: the judge could not resolve a pick (verdict: ${verdict.output})`, usage, ok: false };
		}

		const reasoning = (typeof verdict.structured?.output === "string" && verdict.structured.output) || verdict.output;
		const out = [
			`COMPETE winner: ${winner.result.agent} (${valid.length} valid of ${team.length} entered) — chosen by ${arbiter}: ${reasoning}`,
			"",
			"Apply the winning diff from the repo root (save it, then `git apply`):",
			"```diff",
			winner.diff,
			"```",
		].join("\n");
		return {
			agent: "compete",
			output: out,
			structured: { winner: winner.result.agent, pick: label, entered: team.length, valid: valid.length },
			usage,
			ok: true,
		};
	},
};

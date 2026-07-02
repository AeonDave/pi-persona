/**
 * debate — the p2p reference strategy (design: 2026-07-02-sibling-peer-comm-design.md).
 * 2+ members work the SAME task in parallel and talk to each other DIRECTLY while they
 * work (`contact_peer`, one-way notes): state a position, rebut or concede what arrives,
 * refine, then each finalizes on the contract and a majority vote settles it. Unlike
 * `council-rounds` (supervisor-mediated debate BETWEEN rounds), the exchange here is
 * live and mid-flight — no supervisor in the loop.
 *
 * params: { bestOf?: number (default = majority of the roster) }
 */

import { sumUsage } from "../reducers.ts";
import { dissentLine, readableRuling } from "../render.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";
import type { AgentResult } from "../types.ts";
import type { ReducerResult } from "../voting.ts";

const PROTOCOL = [
	"You are ONE member of a live DEBATE panel — your peers are working this same task right now.",
	"Protocol: form a position early; use `contact_peer` (action `list`, then `send`) to push it to",
	"EACH peer as one short note (claim + strongest evidence). Peer notes reach you as fenced",
	"\"[message from peer …]\" turns: rebut or concede each point EXPLICITLY, and change your position",
	"only when the argument is genuinely stronger — never merely to conform. If `contact_peer` is",
	"unavailable or every peer is gone, proceed solo. When your position is stable, STOP debating and",
	"finalize on the output contract (result + vote + confidence). Do not stall waiting for replies.",
].join(" ");

function render(decision: ReducerResult, members: number, bestOf: number, usages: AgentResult["usage"][]): AgentResult {
	const lines: string[] = [];
	lines.push(
		`DEBATE ruling (${members} members, live peer exchange, best-of-${bestOf}): ${decision.status}${
			decision.usedFallback ? " — fell back to best-by-confidence" : ""
		}`,
	);
	lines.push(`tally: ${Object.entries(decision.tally).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
	if (decision.winner) lines.push(`\n--- ruling ---\n${readableRuling(decision.winner)}`);
	if (decision.dissent && decision.dissent.length > 0) {
		lines.push(`\n--- dissent (minority report) ---\n${decision.dissent.map(dissentLine).join("\n\n")}`);
	}
	return {
		agent: "debate",
		output: lines.join("\n"),
		structured: { status: decision.status, tally: decision.tally, usedFallback: decision.usedFallback },
		usage: sumUsage(usages),
		ok: decision.winner !== undefined,
	};
}

export const debate: Strategy = {
	name: "debate",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		if (team.length < 2) throw new Error("debate: a roster of at least 2 members is required");
		const bestOf = typeof input.params.bestOf === "number" ? input.params.bestOf : Math.floor(team.length / 2) + 1;
		sdk.log(`debate: ${team.length} members, live peer exchange, best of ${bestOf}`);
		if (team.length > sdk.limits.maxConcurrency) {
			sdk.log(
				`debate: roster of ${team.length} exceeds maxConcurrency (${sdk.limits.maxConcurrency}) — the live exchange will be batched (members beyond the concurrency window join late)`,
			);
		}
		const candidates = await sdk.parallel(
			team.map((m) => () => {
				const s = rosterSpec(m);
				// PROTOCOL travels in the TASK text, not appended to role (mirrors how `magi` injects
				// per-round instructions via the task) — a bare roster member keeps role UNSET, so its
				// `roleHint`-derived UI key stays identical to the `rosterNodeKeys` seeding.
				return sdk.agent({
					...s,
					task: `${input.task}\n\n--- debate protocol ---\n${PROTOCOL}`,
					outputContract: "default",
					peers: true,
				});
			}),
		);
		const decision = sdk.reduce.vote(candidates, { aggregate: "majority", threshold: bestOf, keepBestFallback: true });
		return render(decision, team.length, bestOf, candidates.map((c) => c.usage));
	},
};

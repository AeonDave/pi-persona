/**
 * map — dynamic fan-out over a RUNTIME list (vs `fanout`'s fixed roster). A splitter agent
 * breaks the task into independent sub-items, then a worker runs once per item in parallel
 * (bounded by the run limits / `params.maxItems`), and the results aggregate. The map-reduce
 * shape for "review each changed file", "summarise each doc", etc. Built on the SDK + the
 * shared JSON extractor — no new engine surface.
 *
 * roster = [splitter, worker]  (worker defaults to the splitter if only one is given)
 * params = { maxItems?: number, peers?: boolean (workers share load-bearing cross-item
 *            discoveries live via contact_peer — default off) }
 */

import { extractJsonCandidate } from "../../core/contract.ts";
import { sumUsage } from "../reducers.ts";
import { rosterSpec } from "../roster.ts";
import type { Strategy } from "../sdk.ts";

// Cooperative cross-talk (params.peers): workers share load-bearing cross-item discoveries
// live. Injected into the TASK text (not the role) so UI tree keys stay stable.
const CROSS_TALK = [
	"You have sibling workers on OTHER sub-items of this same batch. If you discover something",
	"load-bearing that likely applies to their items too (a shared gotcha, a convention, a blocker),",
	"share it once via `contact_peer` (action `list`, then `send`) — short and factual. Incorporate",
	'any "[message from peer …]" notes you receive. No chatter: only load-bearing findings.',
].join(" ");

/** Parse a splitter's output into a list of short item strings (tolerant of fences/prose). */
function parseItems(output: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonCandidate(output));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter((s) => s.trim());
}

export const map: Strategy = {
	name: "map",
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		const splitterMember = team[0];
		if (!splitterMember) throw new Error("map: a roster with at least a splitter agent is required");
		const splitter = rosterSpec(splitterMember);
		const worker = team[1] ? rosterSpec(team[1]) : splitter;
		const maxItems = typeof input.params.maxItems === "number" ? input.params.maxItems : sdk.limits.maxChildren;
		const peers = input.params.peers === true;

		const split = await sdk.agent({
			...splitter,
			task: `Break this task into independent sub-items. Return ONLY a JSON array of short strings — one per sub-item, nothing else.\n\nTask: ${input.task}`,
		});
		const items = parseItems(split.output).slice(0, Math.max(0, maxItems));
		if (items.length === 0) {
			return { agent: "map", output: split.output || "(splitter produced no items)", usage: split.usage, ok: false };
		}
		sdk.log(`map: ${items.length} items → ${worker.agent}${peers ? " (cross-talk on)" : ""}`);

		const results = await sdk.parallel(
			items.map((item) => () =>
				sdk.agent({
					...worker,
					task: `${input.task}\n\n— Your single sub-item: ${item}${peers ? `\n\n--- swarm cross-talk ---\n${CROSS_TALK}` : ""}`,
					...(peers ? { peers: true } : {}),
				}),
			),
		);
		const agg = sdk.reduce.aggregate(results);
		return { ...agg, agent: "map", usage: sumUsage([split, ...results].map((r) => r.usage)) };
	},
};

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
	params: {
		maxItems: { type: "number", doc: "default AND ceiling: the run's maxChildren, less the splitter's own slot" },
		peers: { type: "boolean", default: false, doc: "workers share load-bearing cross-item discoveries live" },
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		const splitterMember = team[0];
		if (!splitterMember) throw new Error("map: a roster with at least a splitter agent is required");
		const splitter = rosterSpec(splitterMember);
		const worker = team[1] ? rosterSpec(team[1]) : splitter;
		// The splitter spends one child slot before any worker runs, so the worker cap is one
		// BELOW maxChildren — at the cap the last worker would trip the run's pre-spawn guard
		// and take the whole (mostly finished) fan-out down with it.
		const workerSlots = Math.max(1, sdk.limits.maxChildren - 1);
		const maxItems = Math.min(typeof input.params.maxItems === "number" ? input.params.maxItems : workerSlots, workerSlots);
		const peers = input.params.peers === true;

		const split = await sdk.agent({
			...splitter,
			task: `Break this task into independent sub-items. Return ONLY a JSON array of short strings — one per sub-item, nothing else.\n\nTask: ${input.task}`,
		});
		const allItems = parseItems(split.output);
		const items = allItems.slice(0, Math.max(0, maxItems));
		const dropped = allItems.length - items.length;
		if (items.length === 0) {
			return { agent: "map", output: split.output || "(splitter produced no items)", usage: split.usage, ok: false };
		}
		sdk.log(`map: ${items.length} items → ${worker.agent}${peers ? " (cross-talk on)" : ""}`);
		if (peers && items.length > sdk.limits.maxConcurrency) {
			sdk.log(
				`map: ${items.length} items exceeds maxConcurrency (${sdk.limits.maxConcurrency}) — the live exchange will be batched (workers beyond the concurrency window join late)`,
			);
		}

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
		// Say what was left out. The clamp is right — a worker per item past the cap would trip the
		// pre-spawn guard and lose the whole fan-out — but an aggregate that silently covers part of
		// the splitter's list reads as a complete answer over an incomplete input set.
		const output =
			dropped > 0
				? `${agg.output}\n\n[pi-persona] ${dropped} sub-item(s) beyond the worker cap (${maxItems}) were not run — this covers ${items.length} of ${allItems.length} sub-items.`
				: agg.output;
		return { ...agg, agent: "map", output, usage: sumUsage([split, ...results].map((r) => r.usage)) };
	},
};

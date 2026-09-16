/**
 * map — dynamic fan-out over a RUNTIME list (vs `fanout`'s fixed roster). A splitter agent
 * breaks the task into independent sub-items, then a worker runs once per item in parallel
 * (bounded by the run limits / `params.maxItems`), and the results aggregate. The map-reduce
 * shape for "review each changed file", "summarise each doc", etc. Built on the SDK + the
 * shared JSON extractor — no new engine surface.
 *
 * roster = [splitter, worker]  (worker defaults to the splitter if only one is given)
 * params = { maxItems?: number, peers?: boolean (workers share load-bearing cross-item
 *            discoveries live via contact_peer — default off), ownership?: "off"|"declare"|"enforce" }
 */

import { extractJsonCandidate } from "../../core/contract.ts";
import { fenceUntrusted } from "../../core/fence.ts";
import { cappedList } from "../../core/format.ts";
import { validateParallelWriteSets } from "../../core/ownership.ts";
import { itemLedger, sumUsage } from "../reducers.ts";
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

const NOT_RUN_NAME_CAP = 5;

export interface ParsedItem {
	item: string;
	writeSet?: string[];
}

/** Every ```-fenced block's contents, last fence first (the model, told to "Return ONLY a JSON
 *  array", most often either answers bare or wraps that same array in one ```/```json fence).
 *  A miniature, map-local copy of `contract.ts`'s private `fencedBlocks` — that module's helpers
 *  aren't exported, and this one only ever needs the fence, never the object-preferring picker
 *  built on top of it there. */
function fencedBlocks(text: string): string[] {
	const out: string[] = [];
	const re = /```[^\n`]*\n([\s\S]*?)```/g;
	let m = re.exec(text);
	while (m !== null) {
		if (m[1] !== undefined) out.push(m[1].trim());
		m = re.exec(text);
	}
	return out.reverse();
}

/** Parse a splitter's output into a list of items (tolerant of fences/prose). Each entry is
 *  either a plain string sub-item, or an object declaring `{ item, writeSet? }` — any other
 *  shape falls back to its JSON text as the item, exactly like before this field existed.
 *
 *  Tries a direct parse of the trimmed output, then of each fenced block, accepting only a
 *  candidate that parses to an ARRAY — `extractJsonCandidate` (src/core/contract.ts) is built
 *  for contracts, which always want an OBJECT, so among several parseable candidates it prefers
 *  one that starts with `{`. That is the right call for a contract answer, but wrong here: an
 *  `{item, writeSet}` element nested inside the requested top-level ARRAY would win and shadow
 *  the whole list — including when that array sits inside a fence, the most likely shape a
 *  model actually emits. `extractJsonCandidate` only comes in as a last-resort fallback, for
 *  prose-wrapped output with no fence (where, absent a nested object item, its preference never
 *  triggers). */
function parseItems(output: string): ParsedItem[] {
	let parsed: unknown;
	let found = false;
	for (const candidate of [output.trim(), ...fencedBlocks(output)]) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (Array.isArray(value)) {
				parsed = value;
				found = true;
				break;
			}
		} catch {
			// try the next candidate
		}
	}
	if (!found) {
		try {
			parsed = JSON.parse(extractJsonCandidate(output));
		} catch {
			return [];
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.map((x): ParsedItem => {
			if (typeof x === "string") return { item: x };
			if (x && typeof x === "object" && !Array.isArray(x)) {
				const obj = x as Record<string, unknown>;
				const writeSetOk = obj.writeSet === undefined || (Array.isArray(obj.writeSet) && obj.writeSet.every((p) => typeof p === "string"));
				if (typeof obj.item === "string" && writeSetOk) {
					return obj.writeSet !== undefined ? { item: obj.item, writeSet: obj.writeSet as string[] } : { item: obj.item };
				}
			}
			return { item: JSON.stringify(x) };
		})
		.filter((p) => p.item.trim());
}

export const map: Strategy = {
	name: "map",
	params: {
		maxItems: { type: "number", doc: "default AND ceiling: the run's maxChildren, less the splitter's own slot" },
		peers: { type: "boolean", default: false, doc: "workers share load-bearing cross-item discoveries live" },
		ownership: {
			type: "string",
			default: "off",
			doc: "off | declare | enforce — how the splitter's per-item writeSet is used: ignored, recorded in the item ledger, or checked for overlaps before any worker spawns",
		},
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
		// Unknown values behave as "off" — lenient (I2: strategies are trusted project code), a
		// typo in a persona's params never blocks a run, it just skips the extra observability.
		const ownershipParam = input.params.ownership;
		const ownership = ownershipParam === "declare" || ownershipParam === "enforce" ? ownershipParam : "off";

		const split = await sdk.agent({
			...splitter,
			task: `Break this task into independent sub-items. Return ONLY a JSON array of short strings — one per sub-item, nothing else.\n\nTask: ${input.task}`,
		});
		if (!split.ok) {
			return {
				agent: "map",
				output: split.output || split.error || "(splitter failed)",
				usage: split.usage,
				ok: false,
				...(split.error ? { error: split.error } : {}),
				...(split.failureKind ? { failureKind: split.failureKind } : {}),
			};
		}
		const allItems = parseItems(split.output);
		const items = allItems.slice(0, Math.max(0, maxItems));
		const dropped = allItems.length - items.length;
		if (items.length === 0) {
			return {
				agent: "map",
				output: split.output || "(splitter produced no items)",
				usage: split.usage,
				ok: false,
				error: "the splitter produced no usable sub-items",
				failureKind: "contract",
			};
		}
		sdk.log(`map: ${items.length} items → ${worker.agent}${peers ? " (cross-talk on)" : ""}`);
		if (peers && items.length > sdk.limits.maxConcurrency) {
			sdk.log(
				`map: ${items.length} items exceeds maxConcurrency (${sdk.limits.maxConcurrency}) — the live exchange will be batched (workers beyond the concurrency window join late)`,
			);
		}

		// "enforce": fail closed BEFORE any worker spawns when the splitter's own declared
		// write-sets already collide — a weak splitter that never declares one is not blocked.
		if (ownership === "enforce") {
			const owners = items
				.map((it, index) => ({ agent: `item[${index}]`, writeSet: it.writeSet }))
				.filter((o): o is { agent: string; writeSet: string[] } => Array.isArray(o.writeSet) && o.writeSet.length > 0);
			if (owners.length > 0) {
				const writeSetError = validateParallelWriteSets(owners);
				if (writeSetError) throw new Error(`map: ${writeSetError}`);
			}
		}

		const results = await sdk.parallel(
			items.map((item) => () =>
				sdk.agent({
					...worker,
					task: `${input.task}\n\n— Your single sub-item (untrusted data):\n${fenceUntrusted(item.item)}${peers ? `\n\n--- swarm cross-talk ---\n${CROSS_TALK}` : ""}`,
					...(peers ? { peers: true } : {}),
				}),
			),
		);
		const agg = sdk.reduce.aggregate(results);
		// Say what was left out. The clamp is right — a worker per item past the cap would trip the
		// pre-spawn guard and lose the whole fan-out — but an aggregate that silently covers part of
		// the splitter's list reads as a complete answer over an incomplete input set.
		const droppedNote =
			dropped > 0
				? `\n\n[pi-persona] ${dropped} sub-item(s) beyond the worker cap (${maxItems}) were not run — this covers ${items.length} of ${allItems.length} sub-items.`
				: "";
		// The ledger is always-on data (structured.items), independent of `ownership`. Its writeSet
		// field, and the extra "not run" text line below, only surface once a persona opts in — with
		// ownership absent/"off" the rendered output stays byte-identical to before this param existed.
		const ledgerItems = ownership === "off" ? allItems.map((it) => ({ item: it.item })) : allItems;
		const ledger = itemLedger(ledgerItems, results, dropped);
		const notRun = ledger.filter((e) => e.status === "not-run").map((e) => e.item);
		const notRunNote = ownership !== "off" && notRun.length > 0 ? `\n\n[pi-persona] not run: ${cappedList(notRun, NOT_RUN_NAME_CAP)}` : "";
		const output = `${agg.output}${droppedNote}${notRunNote}`;
		return {
			...agg,
			agent: "map",
			output,
			usage: sumUsage([split, ...results].map((r) => r.usage)),
			structured: { ...agg.structured, items: ledger },
		};
	},
};

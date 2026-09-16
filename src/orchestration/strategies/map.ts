/**
 * map — dynamic fan-out over a RUNTIME list (vs `fanout`'s fixed roster). A splitter agent
 * breaks the task into independent sub-items, then a worker runs once per item in parallel
 * (bounded by the run limits / `params.maxItems`), and the results aggregate. The map-reduce
 * shape for "review each changed file", "summarise each doc", etc. Built on the SDK + the
 * shared JSON extractor — no new engine surface.
 *
 * roster = [splitter, worker]  (worker defaults to the splitter if only one is given)
 * params = { maxItems?: number, peers?: boolean (workers share load-bearing cross-item
 *            discoveries live via contact_peer — default off), ownership?: "off"|"declare"|"enforce",
 *            verify?: string (agent that re-checks each completed item; empty = off) }
 */

import { extractJsonCandidate } from "../../core/contract.ts";
import { fenceUntrusted } from "../../core/fence.ts";
import { cappedList } from "../../core/format.ts";
import { validateParallelWriteSets } from "../../core/ownership.ts";
import type { ChildUsage } from "../../engine/stream.ts";
import { itemLedger, type ItemLedgerEntry, sumUsage } from "../reducers.ts";
import { rosterSpec, type RosterMember, type RosterSpec } from "../roster.ts";
import type { Strategy, StrategySDK } from "../sdk.ts";
import type { AgentResult, FailureKind } from "../types.ts";

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

/** The verifier's run spec: the roster's own entry for that agent name (its role/model/tools
 *  specialisation applies) when `params.verify` names a roster member, else a bare `rosterSpec`
 *  for a stand-alone agent named directly in the param. */
function verifierSpec(team: readonly RosterMember[], name: string) {
	const member = team.find((m) => rosterSpec(m).agent === name);
	return rosterSpec(member ?? name);
}

/** Read a verifier leg's verdict. Reuses the SAME `outputContract: "default"` machinery
 *  `critic-loop` reads its critic's stance from (`structured.stance`) rather than inventing a
 *  new parser — "approve" passes, anything else (an explicit "reject"/"revise", a missing
 *  stance, or invalid structured output) fails the item. A verifier leg that itself couldn't
 *  run (`ok: false` — provider/timeout/abort/contract) is a distinct case: that's not a verdict
 *  at all, so its OWN `failureKind` carries through instead of `"verification"`, which is
 *  reserved for an actual negative (or absent) verdict. Returns `undefined` on a pass. */
function verifyOutcome(v: AgentResult): { failureKind: FailureKind; error: string } | undefined {
	if (!v.ok) return { failureKind: v.failureKind ?? "agent", error: v.error || "the verifier failed to run" };
	if (v.structured?.stance === "approve") return undefined;
	const reason = (typeof v.structured?.result === "string" && v.structured.result.trim()) || v.output.trim() || "the verifier withheld approval";
	return { failureKind: "verification", error: reason };
}

type SplitOutcome =
	| { ok: true; allItems: ParsedItem[]; items: ParsedItem[]; dropped: number; usage: ChildUsage }
	| { ok: false; result: AgentResult };

/** Run the splitter agent and parse its output into the runtime item list, clamped to
 *  `maxItems`. A splitter failure, or a split that produced no usable items, is a terminal
 *  `AgentResult` — the whole run fails before any worker spawns. */
async function splitIntoItems(sdk: StrategySDK, splitter: RosterSpec, task: string, maxItems: number): Promise<SplitOutcome> {
	const split = await sdk.agent({
		...splitter,
		task: `Break this task into independent sub-items. Return ONLY a JSON array of short strings — one per sub-item, nothing else.\n\nTask: ${task}`,
	});
	if (!split.ok) {
		return {
			ok: false,
			result: {
				agent: "map",
				output: split.output || split.error || "(splitter failed)",
				usage: split.usage,
				ok: false,
				...(split.error ? { error: split.error } : {}),
				...(split.failureKind ? { failureKind: split.failureKind } : {}),
			},
		};
	}
	const allItems = parseItems(split.output);
	const items = allItems.slice(0, Math.max(0, maxItems));
	const dropped = allItems.length - items.length;
	if (items.length === 0) {
		return {
			ok: false,
			result: {
				agent: "map",
				output: split.output || "(splitter produced no items)",
				usage: split.usage,
				ok: false,
				error: "the splitter produced no usable sub-items",
				failureKind: "contract",
			},
		};
	}
	return { ok: true, allItems, items, dropped, usage: split.usage };
}

/** "enforce": fail closed BEFORE any worker spawns when the splitter's own declared write-sets
 *  already collide — a weak splitter that never declares one is not blocked. */
function enforceOwnershipOrThrow(items: readonly ParsedItem[]): void {
	const owners = items
		.map((it, index) => ({ agent: `item[${index}]`, writeSet: it.writeSet }))
		.filter((o): o is { agent: string; writeSet: string[] } => Array.isArray(o.writeSet) && o.writeSet.length > 0);
	if (owners.length === 0) return;
	const writeSetError = validateParallelWriteSets(owners);
	if (writeSetError) throw new Error(`map: ${writeSetError}`);
}

/** Run the worker agent once per item, in parallel. */
function runWorkers(sdk: StrategySDK, worker: RosterSpec, task: string, items: readonly ParsedItem[], peers: boolean): Promise<AgentResult[]> {
	return sdk.parallel(
		items.map((item) => () =>
			sdk.agent({
				...worker,
				task: `${task}\n\n— Your single sub-item (untrusted data):\n${fenceUntrusted(item.item)}${peers ? `\n\n--- swarm cross-talk ---\n${CROSS_TALK}` : ""}`,
				...(peers ? { peers: true } : {}),
			}),
		),
	);
}

/** "verify": one read-only reviewer per COMPLETED item (a failed worker has nothing worth
 *  re-checking), run through `sdk.parallel` exactly like the worker wave — the run's own
 *  semaphore/maxChildren/budget still apply, and an empty `verifyAgent` spawns no verifier at
 *  all, so the byte-identical-when-off guarantee extends to this param too. */
async function runVerification(
	sdk: StrategySDK,
	team: readonly RosterMember[],
	verifyAgent: string,
	task: string,
	items: readonly ParsedItem[],
	results: readonly AgentResult[],
): Promise<{ verifyResults: AgentResult[]; failures: Map<number, { failureKind: FailureKind; error: string }> }> {
	const failures = new Map<number, { failureKind: FailureKind; error: string }>();
	if (!verifyAgent) return { verifyResults: [], failures };
	const reviewer = verifierSpec(team, verifyAgent);
	const completedIndices = results.map((_r, index) => index).filter((index) => results[index]!.ok);
	const verifyResults = await sdk.parallel(
		completedIndices.map((index) => () =>
			sdk.agent({
				...reviewer,
				task: `Re-check this completed sub-item's work, read-only — do not make further changes.\n\nOriginal task: ${task}\n\nSub-item: ${fenceUntrusted(items[index]!.item)}\n\nCompleted work (untrusted data):\n${fenceUntrusted(results[index]!.output)}\n\nReturn your stance (approve|reject).`,
				outputContract: "default",
			}),
		),
	);
	completedIndices.forEach((index, k) => {
		const outcome = verifyOutcome(verifyResults[k]!);
		if (outcome) failures.set(index, outcome);
	});
	return { verifyResults, failures };
}

/** The always-on per-item status ledger (`structured.items`), independent of `ownership`. Its
 *  `writeSet` field only surfaces once a persona opts in — with ownership absent/"off" the
 *  rendered ledger stays byte-identical to before this param existed — merged with each item's
 *  verify outcome, if any. */
function buildItemLedger(
	ownership: "off" | "declare" | "enforce",
	allItems: readonly ParsedItem[],
	results: readonly AgentResult[],
	dropped: number,
	verifyFailures: ReadonlyMap<number, { failureKind: FailureKind; error: string }>,
): ItemLedgerEntry[] {
	const ledgerItems = ownership === "off" ? allItems.map((it) => ({ item: it.item })) : allItems;
	const preVerifyLedger = itemLedger(ledgerItems, results, dropped);
	return preVerifyLedger.map((entry) => {
		const outcome = verifyFailures.get(entry.index);
		return outcome ? { ...entry, status: "failed" as const, failureKind: outcome.failureKind, error: outcome.error } : entry;
	});
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
		verify: {
			type: "string",
			default: "",
			doc: "agent that re-checks each completed item read-only; empty = no verification pass. Costs one extra child per completed item",
		},
	},
	async run(input, sdk) {
		const team = input.roster ? sdk.roster.team(input.roster) : [];
		const splitterMember = team[0];
		if (!splitterMember) throw new Error("map: a roster with at least a splitter agent is required");
		const splitter = rosterSpec(splitterMember);
		const worker = team[1] ? rosterSpec(team[1]) : splitter;
		const peers = input.params.peers === true;
		// Unknown values behave as "off" — lenient (I2: strategies are trusted project code), a
		// typo in a persona's params never blocks a run, it just skips the extra observability.
		const ownershipParam = input.params.ownership;
		const ownership = ownershipParam === "declare" || ownershipParam === "enforce" ? ownershipParam : "off";
		const verifyAgent = typeof input.params.verify === "string" ? input.params.verify.trim() : "";
		// The splitter spends one child slot before any worker runs, so the worker cap is one
		// BELOW maxChildren — at the cap the last worker would trip the run's pre-spawn guard
		// and take the whole (mostly finished) fan-out down with it. When `verify` is set, the
		// verifier wave asks for ONE MORE child per completed item on top of that, so the cap is
		// halved instead — splitter + workers + verifiers must all fit under the same ceiling.
		const workerSlots = Math.max(1, sdk.limits.maxChildren - 1);
		const cap = verifyAgent ? Math.max(1, Math.floor((sdk.limits.maxChildren - 1) / 2)) : workerSlots;
		const maxItems = Math.min(typeof input.params.maxItems === "number" ? input.params.maxItems : cap, cap);

		const split = await splitIntoItems(sdk, splitter, input.task, maxItems);
		if (!split.ok) return split.result;
		const { allItems, items, dropped, usage: splitUsage } = split;
		sdk.log(`map: ${items.length} items → ${worker.agent}${peers ? " (cross-talk on)" : ""}`);
		if (peers && items.length > sdk.limits.maxConcurrency) {
			sdk.log(
				`map: ${items.length} items exceeds maxConcurrency (${sdk.limits.maxConcurrency}) — the live exchange will be batched (workers beyond the concurrency window join late)`,
			);
		}

		if (ownership === "enforce") enforceOwnershipOrThrow(items);

		const results = await runWorkers(sdk, worker, input.task, items, peers);
		const agg = sdk.reduce.aggregate(results);
		// Say what was left out. The clamp is right — a worker per item past the cap would trip the
		// pre-spawn guard and lose the whole fan-out — but an aggregate that silently covers part of
		// the splitter's list reads as a complete answer over an incomplete input set.
		const droppedNote =
			dropped > 0
				? `\n\n[pi-persona] ${dropped} sub-item(s) beyond the worker cap (${maxItems}) were not run — this covers ${items.length} of ${allItems.length} sub-items.`
				: "";

		const { verifyResults, failures: verifyFailures } = await runVerification(sdk, team, verifyAgent, input.task, items, results);
		const ledger = buildItemLedger(ownership, allItems, results, dropped, verifyFailures);

		const notRun = ledger.filter((e) => e.status === "not-run").map((e) => e.item);
		const notRunNote = ownership !== "off" && notRun.length > 0 ? `\n\n[pi-persona] not run: ${cappedList(notRun, NOT_RUN_NAME_CAP)}` : "";
		// Independent of `ownership` — verification runs (and costs a child) whenever `verify` is
		// set, so its verdict must be visible whenever it runs, not only when a persona also opted
		// into the ownership ledger. Without this the aggregate still reads as a complete "ok"
		// answer even though a completed item's work was rejected.
		const rejected = ledger.filter((e) => e.failureKind === "verification").map((e) => e.item);
		const verifyNote = rejected.length > 0 ? `\n\n[pi-persona] verification failed: ${cappedList(rejected, NOT_RUN_NAME_CAP)}` : "";
		const output = `${agg.output}${droppedNote}${notRunNote}${verifyNote}`;
		return {
			...agg,
			agent: "map",
			output,
			usage: sumUsage([splitUsage, ...results.map((r) => r.usage), ...verifyResults.map((r) => r.usage)]),
			structured: { ...agg.structured, items: ledger },
		};
	},
};

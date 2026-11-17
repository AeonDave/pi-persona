import { visibleWidth } from "@earendil-works/pi-tui";
import type { CardFramePresentation } from "./card-frame.ts";

type Card = CardFramePresentation;
const COMPACT_BODY_ROWS = 4;

interface StatusRunLine { name: string; detail: string; queued: boolean; signal?: string }
type SettledStatus = "done" | "failed" | "stopped";

/** Skip-list for the peek-digest boilerplate the status card's title/frame replaces. Each entry
 * is drift-guarded in tests against live `buildPeekDigest`/`buildCheckIn` output (src/engine/async.ts):
 * routine, stall and recovery headers, the cumulative-token footnote and the omitted-runs tail. The
 * `Async runs: N (M running)` header is recognized below (the title carries its counts). */
const STATUS_SKIP: readonly RegExp[] = [
	/^Async activity · (?:routine check-in|possible stall|progress resumed)$/,
	/^Cumulative tokens show /,
	/^… \d+ additional async runs omitted/,
];
const STATUS_RUNNING = /^\[([^\]]+)\] (.+?) — running \((?:(\d+) turns, )?(.+?) cumulative input \+ output tokens\)(.*)$/;
const STATUS_SETTLED = /^\[([^\]]+)\] (.+?) — (done|failed|stopped)(?: (?:in|after) (.+?))?(?::.*)?$/;
const STATUS_HEADER_COUNTS = /^Async runs: (\d+) \((\d+) running\)$/;
/** A running line's suffix is ` · running for <duration>` (never while queued) plus at most one of
 * the queued sentence, the awaiting label, the supervisor wait, or the stall marker. The awaiting
 * label carries flow-authored text (a checkpoint id), so queued and stalled are recognized only as
 * the whole suffix, never as a substring the label could imitate. */
const RUNNING_FOR = String.raw`(?: · running for [^·]+?)?`;
const STATUS_QUEUED = " · queued (waiting for concurrency slot)";
const STATUS_STALLED = new RegExp(`^${RUNNING_FOR} ⚠ possibly stuck \\(no progress for (\\d+s)\\)$`);
const STATUS_WAITING = new RegExp(`^${RUNNING_FOR} · (waiting for supervisor|waiting for operator|awaiting [^·]+)`);

/** `1 turn`, `2 turns`: every count this card prints agrees with its number. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface StatusRuns {
	/** Runs the digest header counts as running, queued ones included. */
	running: number;
	queued: number;
	/** Settled runs listed in the digest, by outcome. */
	settled: Record<SettledStatus, number>;
	/** True when the digest lists every run its header counts (no omitted tail). */
	complete: boolean;
	/** Total runs and settled runs the header counts, listed or not. */
	total: number;
	runs: StatusRunLine[];
}

/** Parse one peek digest into per-run compact lines (`<name> · 53 turns · 216k tok` for running
 * legs, `<name> · done · 12s` for settled ones), or undefined when the shape is not the generator's. */
export function parseStatusRuns(full: string, labels: ReadonlyMap<string, string>): StatusRuns | undefined {
	let running: number | undefined;
	let total = 0;
	let queued = 0;
	const settled: Record<SettledStatus, number> = { done: 0, failed: 0, stopped: 0 };
	const runs: StatusRunLine[] = [];
	const recovery = full.split("\n").includes("Async activity · progress resumed");
	for (const line of full.split("\n")) {
		if (line.trim().length === 0 || STATUS_SKIP.some((skip) => skip.test(line))) continue;
		const head = STATUS_HEADER_COUNTS.exec(line);
		if (head) {
			if (running !== undefined) return undefined;
			total = Number(head[1]);
			running = Number(head[2]);
			continue;
		}
		const runLine = STATUS_RUNNING.exec(line);
		if (runLine) {
			const [, id, name, turns, tokens, suffix] = runLine;
			const details = suffix ?? "";
			const isQueued = details === STATUS_QUEUED;
			if (isQueued) queued++;
			// The agent widget's unit; the expanded card keeps the generator's cumulative-usage wording.
			const usage = `${tokens ?? "0"} tok`;
			const stalledFor = STATUS_STALLED.exec(details)?.[1];
			const waiting = STATUS_WAITING.exec(details)?.[1];
			const signal = isQueued ? "queued" : stalledFor ? `no observed progress for ${stalledFor}` : waiting ?? (recovery ? "progress resumed" : undefined);
			const detail = isQueued
				? `queued · ${usage}`
				: [signal, ...(turns !== undefined ? [count(Number(turns), "turn")] : []), usage].filter((part): part is string => part !== undefined).join(" · ");
			runs.push({ name: labels.get(id ?? "") ?? name ?? "", detail, queued: isQueued, ...(signal !== undefined ? { signal } : {}) });
			continue;
		}
		const settledLine = STATUS_SETTLED.exec(line);
		if (settledLine) {
			const [, id, name, status, duration] = settledLine;
			settled[status as SettledStatus]++;
			runs.push({ name: labels.get(id ?? "") ?? name ?? "", detail: duration !== undefined ? `${status} · ${duration}` : status ?? "", queued: false });
			continue;
		}
		return undefined; // unknown shape → the caller falls back to the generic bounded preview
	}
	if (running === undefined || runs.length === 0) return undefined;
	return { running, queued, settled, complete: runs.length === total, total, runs };
}

/** The card title's counts: `2 running, 1 queued, 1 done`. Zero counts are left out; when the
 * digest omitted runs, settled ones are counted from the header instead of guessed per outcome.
 * Queued runs are counted apart from running ones in both forms; a queued run among the omitted
 * rows cannot be told apart, so it stays inside the header's own running count. */
export function statusCounts(parsed: StatusRuns): string {
	const settledTotal = Math.max(0, parsed.total - parsed.running);
	const active = [
		...(parsed.running - parsed.queued > 0 ? [`${parsed.running - parsed.queued} running`] : []),
		...(parsed.queued > 0 ? [`${parsed.queued} queued`] : []),
	];
	const parts = parsed.complete
		? [...active, ...(["done", "failed", "stopped"] as const).flatMap((status) => parsed.settled[status] > 0 ? [`${parsed.settled[status]} ${status}`] : [])]
		: [...active, ...(settledTotal > 0 ? [`${settledTotal} settled`] : [])];
	return parts.join(", ") || "0 running";
}

/** Compact projection of the periodic status digest, capped like the settlement preview. */
export function statusPreview(full: string, labels: ReadonlyMap<string, string>): Card["preview"] | undefined {
	const parsed = parseStatusRuns(full, labels);
	if (!parsed) return undefined;
	return (width) => {
		const blocks = parsed.runs.map((run): string[] => {
			const line = `${run.name} · ${run.detail}`;
			const signalPrefix = run.signal ? `${run.name} · ${run.signal}` : undefined;
			// Leave room after the reason so the frame's clipping marker never replaces its last character.
			return signalPrefix && visibleWidth(signalPrefix) >= width ? [run.name, run.detail] : [line];
		});
		const fullLineCount = blocks.reduce((total, block) => total + block.length, 0);
		const rowBudget = fullLineCount > COMPACT_BODY_ROWS ? COMPACT_BODY_ROWS - 1 : COMPACT_BODY_ROWS;
		let shown = 0;
		let usedRows = 0;
		for (const block of blocks) {
			if (usedRows + block.length > rowBudget) break;
			usedRows += block.length;
			shown++;
		}
		const visible = blocks.slice(0, shown).flat();
		if (shown < blocks.length) visible.push(`… +${blocks.length - shown} more`);
		return { text: visible.join("\n"), truncated: true };
	};
}

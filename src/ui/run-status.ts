import { visibleWidth } from "@earendil-works/pi-tui";
import type { CardFramePresentation } from "./card-frame.ts";

type Card = CardFramePresentation;
const COMPACT_BODY_ROWS = 4;

interface StatusRunLine { name: string; detail: string; queued: boolean; signal?: string }

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
const STATUS_HEADER_COUNTS = /^Async runs: \d+ \((\d+) running\)$/;

/** Parse one peek digest into per-run compact lines (`<name> · 53t · 216k` for running legs,
 * `<name> · done · 12s` for settled ones), or undefined when the shape is not the generator's. */
export function parseStatusRuns(full: string, labels: ReadonlyMap<string, string>): { running: number; queued: number; runs: StatusRunLine[] } | undefined {
	let running: number | undefined;
	let queued = 0;
	const runs: StatusRunLine[] = [];
	const recovery = full.split("\n").includes("Async activity · progress resumed");
	for (const line of full.split("\n")) {
		if (line.trim().length === 0 || STATUS_SKIP.some((skip) => skip.test(line))) continue;
		const head = STATUS_HEADER_COUNTS.exec(line);
		if (head) {
			if (running !== undefined) return undefined;
			running = Number(head[1]);
			continue;
		}
		const runLine = STATUS_RUNNING.exec(line);
		if (runLine) {
			const [, id, name, turns, tokens, suffix] = runLine;
			const details = suffix ?? "";
			const isQueued = /· queued \(/.test(details);
			if (isQueued) queued++;
			const usage = `${tokens ?? "0"} cumulative input + output tokens`;
			const stalledFor = /⚠ possibly stuck \(no progress for (\d+s)\)/.exec(details)?.[1];
			const waiting = /· (waiting for supervisor|waiting for operator|awaiting [^·]+)/.exec(details)?.[1];
			const signal = isQueued ? "queued" : stalledFor ? `no observed progress for ${stalledFor}` : waiting ?? (recovery ? "progress resumed" : undefined);
			const detail = isQueued
				? `queued · ${usage}`
				: [signal, ...(turns !== undefined ? [`${turns} turns`] : []), usage].filter((part): part is string => part !== undefined).join(" · ");
			runs.push({ name: labels.get(id ?? "") ?? name ?? "", detail, queued: isQueued, ...(signal !== undefined ? { signal } : {}) });
			continue;
		}
		const settledLine = STATUS_SETTLED.exec(line);
		if (settledLine) {
			const [, id, name, status, duration] = settledLine;
			runs.push({ name: labels.get(id ?? "") ?? name ?? "", detail: duration !== undefined ? `${status} · ${duration}` : status ?? "", queued: false });
			continue;
		}
		return undefined; // unknown shape → the caller falls back to the generic bounded preview
	}
	if (running === undefined || runs.length === 0) return undefined;
	return { running, queued, runs };
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


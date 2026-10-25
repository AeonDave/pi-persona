/**
 * What a session restore cannot carry over.
 *
 * Background runs, armed timers and monitors live only in the memory of one extension instance. A
 * `/reload`, an in-session `/resume` or `pi -c` tears that instance down, so the restored supervisor
 * would otherwise keep waiting for wakes that can no longer come, and run ids would restart at
 * `run-1` and collide with the ids already in its history. The shutdown hook records the loss and
 * the id counter in a session entry; the next start reads it back (the session-identity pattern)
 * and tells the supervisor once.
 *
 * Everything read back is untrusted session data, so nothing but run ids matching a strict shape and
 * small counts is ever kept: no free text can reach the model through this entry. Pure — no I/O.
 */

/** Custom session-entry type for {@link RunsEntry}; deliberately unrendered. */
export const RUNS_ENTRY_CUSTOM_TYPE = "pi-persona:runs";

const RUN_ID = /^run-[0-9a-z]{1,8}$/;
/** One cap for every count and the id list (a full 64-leg fan-out fits whole); the entry stays small. */
const MAX_COUNT = 99;
const MAX_ISSUED = 1_000_000_000;
/** Ids named in the notice itself; the rest are counted. */
const MAX_NAMED_IDS = 8;

export interface LostWork {
	runs: string[];
	timers: number;
	monitors: number;
}

export interface RunsEntry {
	version: 1;
	sessionId: string;
	/** Run ids issued so far in this session lineage: the next instance continues from here. */
	issued: number;
	lost: LostWork;
}

const count = (value: unknown): number => (Number.isInteger(value) && (value as number) > 0 ? Math.min(value as number, MAX_COUNT) : 0);

function cleanLost(value: { runs?: unknown; timers?: unknown; monitors?: unknown }): LostWork {
	const runs = (Array.isArray(value.runs) ? value.runs : []).filter((id): id is string => typeof id === "string" && RUN_ID.test(id));
	return { runs: [...new Set(runs)].slice(0, MAX_COUNT), timers: count(value.timers), monitors: count(value.monitors) };
}

export function makeRunsEntry(sessionId: string, issued: number, lost: LostWork): RunsEntry {
	return { version: 1, sessionId, issued, lost: cleanLost(lost) };
}

/**
 * The newest runs entry written for THIS session id, or undefined. The newest one wins even when it
 * is malformed (fail closed): skipping it would let an older loss replay after it was acknowledged.
 */
export function findStoredRuns(entries: readonly unknown[], sessionId: string): RunsEntry | undefined {
	if (!sessionId) return undefined;
	let data: Partial<RunsEntry> | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (item.type !== "custom" || item.customType !== RUNS_ENTRY_CUSTOM_TYPE) continue;
		if (!item.data || typeof item.data !== "object") continue;
		const candidate = item.data as Partial<RunsEntry>;
		if (candidate.version === 1 && candidate.sessionId === sessionId) data = candidate;
	}
	if (!data) return undefined;
	const { issued, lost } = data;
	if (typeof issued !== "number" || !Number.isInteger(issued) || issued < 0 || issued > MAX_ISSUED) return undefined;
	if (!lost || typeof lost !== "object") return undefined;
	return makeRunsEntry(sessionId, issued, lost);
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The one line the restored supervisor is told, or undefined when nothing was lost. */
export function restoreNotice(lost: LostWork): string | undefined {
	const parts: string[] = [];
	if (lost.runs.length > 0) {
		const named = lost.runs.slice(0, MAX_NAMED_IDS).join(", ");
		const more = lost.runs.length - MAX_NAMED_IDS;
		parts.push(`run${lost.runs.length === 1 ? "" : "s"} ${named}${more > 0 ? ` +${more} more` : ""} (stopped or never reported)`);
	}
	if (lost.timers > 0) parts.push(plural(lost.timers, "timer"));
	if (lost.monitors > 0) parts.push(plural(lost.monitors, "monitor"));
	if (parts.length === 0) return undefined;
	return `Session restored. Background work from before the restore did not survive (it lives only in memory): ${parts.join("; ")}. `
		+ "Runtime workers and live run handles are not restored. Retained terminal reports may still be available via intercom { action:'results' } and result { ref:'result:<UUID>' }; read saved data without restarting work. Do not wait for vanished workers; relaunch unfinished work or re-arm wake sources only when still needed.";
}

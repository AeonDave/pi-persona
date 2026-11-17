/**
 * What a session restore cannot carry over.
 *
 * Background runs, armed timers and monitors live only in the memory of one extension instance. A
 * `/reload`, an in-session `/resume` or `pi -c` tears that instance down, so the restored supervisor
 * would otherwise keep waiting for wakes that can no longer come, and run ids would restart at
 * `run-1` and collide with the ids already in its history. The shutdown hook records the loss and
 * the id counter in a session entry; the next start reads it back (the session-identity pattern)
 * and tells the supervisor once. Independently, every start continues the counter past the highest
 * run id the file names ({@link highestIssuedRun}), so a fork or a crash cannot reuse those ids.
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
	scripts: number;
	notifications: number;
}

export interface RunsEntry {
	version: 1;
	sessionId: string;
	/** Run ids issued so far in this session lineage: the next instance continues from here. */
	issued: number;
	lost: LostWork;
}

const count = (value: unknown): number => (Number.isInteger(value) && (value as number) > 0 ? Math.min(value as number, MAX_COUNT) : 0);

function cleanLost(value: { runs?: unknown; timers?: unknown; monitors?: unknown; scripts?: unknown; notifications?: unknown }): LostWork {
	const runs = (Array.isArray(value.runs) ? value.runs : []).filter((id): id is string => typeof id === "string" && RUN_ID.test(id));
	return { runs: [...new Set(runs)].slice(0, MAX_COUNT), timers: count(value.timers), monitors: count(value.monitors), scripts: count(value.scripts), notifications: count(value.notifications) };
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

/** Terminal-result custom entry type (mirrors `results/types.ts`; core stays import-free). */
const TERMINAL_RESULT_ENTRY = "pi-persona-terminal-result";

/** The counter value behind a tracker run id (`run-<base36>`), or 0 for anything else. */
function runOrdinal(id: unknown): number {
	if (typeof id !== "string" || !RUN_ID.test(id)) return 0;
	const n = Number.parseInt(id.slice("run-".length), 36);
	return Number.isSafeInteger(n) && n > 0 && n <= MAX_ISSUED ? n : 0;
}

const idList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const idOf = (value: unknown): unknown => (value && typeof value === "object" ? (value as { id?: unknown }).id : undefined);

/**
 * The tracker run ids a persisted supervisor tool result names, read only where the value is the
 * tracker's own (a launch's return or a found run's id), never a model-supplied target:
 * `delegate` launch receipts (`runId`, `runIds[]`, `runs[].id`) and headless settles
 * (`settledRuns[].id`), `council`/`flow` launch receipts (`runId`), and a successful live
 * `intercom result` (`action: "result"`, `ok: true`, a `status`: its `runId` is the found run's id).
 * Every other intercom `runId` echoes the call's `to` argument, so it is ignored.
 */
function toolResultRunIds(message: { toolName?: unknown; details?: unknown }): unknown[] {
	const details = message.details;
	if (!details || typeof details !== "object") return [];
	const d = details as { runId?: unknown; runIds?: unknown; runs?: unknown; settledRuns?: unknown; action?: unknown; ok?: unknown; status?: unknown };
	switch (message.toolName) {
		case "delegate": return [d.runId, ...idList(d.runIds), ...idList(d.runs).map(idOf), ...idList(d.settledRuns).map(idOf)];
		case "council":
		case "flow": return [d.runId];
		case "intercom": return d.action === "result" && d.ok === true && typeof d.status === "string" ? [d.runId] : [];
		default: return [];
	}
}

/**
 * The highest tracker run counter this session FILE has ever used, under any session id: every
 * terminal record's `originRunId`, every runs entry (its `issued` and its lost run ids), and every
 * run id a persisted tool result names ({@link toolResultRunIds}). A fork copies history under a
 * new session id and a crash writes no shutdown entry, so the per-session {@link findStoredRuns}
 * alone would restart the counter and reissue ids the file already holds; the tool results cover a
 * run still in flight at a crash, or whose record the archive quota or an append failure dropped,
 * once its launch receipt or settling result is in the file. Continuing past this keeps every id
 * the file names unique for every run created from now on. A run the file never names (no record,
 * no runs entry, no such tool result) can still be reissued. Malformed or out-of-range values are
 * ignored (never rewind, never jump past {@link MAX_ISSUED}).
 */
export function highestIssuedRun(entries: readonly unknown[]): number {
	let highest = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: unknown; customType?: unknown; data?: unknown; message?: unknown };
		if (item.type === "message" && item.message && typeof item.message === "object") {
			const message = item.message as { role?: unknown; toolName?: unknown; details?: unknown };
			if (message.role === "toolResult") for (const id of toolResultRunIds(message)) highest = Math.max(highest, runOrdinal(id));
			continue;
		}
		if (item.type !== "custom" || !item.data || typeof item.data !== "object") continue;
		const data = item.data as { originRunId?: unknown; issued?: unknown; lost?: { runs?: unknown } };
		if (item.customType === TERMINAL_RESULT_ENTRY) highest = Math.max(highest, runOrdinal(data.originRunId));
		else if (item.customType === RUNS_ENTRY_CUSTOM_TYPE) {
			if (typeof data.issued === "number" && Number.isInteger(data.issued) && data.issued > 0 && data.issued <= MAX_ISSUED) highest = Math.max(highest, data.issued);
			const lost = data.lost && typeof data.lost === "object" && Array.isArray(data.lost.runs) ? data.lost.runs : [];
			for (const id of lost) highest = Math.max(highest, runOrdinal(id));
		}
	}
	return highest;
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
	if (lost.scripts > 0) parts.push(plural(lost.scripts, "script"));
	if (parts.length === 0 && lost.notifications === 0) return undefined;
	const work = parts.length ? `Background work from before the restore did not survive (it lives only in memory): ${parts.join("; ")}. ` : "";
	const notifications = lost.notifications > 0 ? `${plural(lost.notifications, "pending notification")} discarded. Retained script and monitor logs may be available via script { action:'result' } and monitor { action:'result' }. ` : "";
	return `Session restored. ${work}${notifications}`
		+ (parts.length ? "Runtime workers and live run handles are not restored. Retained terminal reports may still be available via intercom { action:'results' } and result { ref:'result:<UUID>' }; read saved data without restarting work. Do not wait for vanished workers; relaunch unfinished work or re-arm wake sources only when still needed." : "Read saved data without restarting work.");
}

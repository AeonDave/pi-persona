import {
	MONITOR_MAX_ARGS, MONITOR_MAX_ARG_CHARS, MONITOR_MAX_ARGV_CHARS,
	MONITOR_MAX_COMMAND_CHARS, MONITOR_MAX_EVENTS, MONITOR_MAX_LABEL_CHARS,
	type MonitorEntry, type MonitorEvent, type MonitorOutput,
} from "../core/monitor.ts";

export const MONITOR_LOG_ENTRY = "pi-persona-monitor-log";
export const MONITOR_LOG_MAX_STREAM_CHARS = 16 * 1024;
export const MONITOR_LOG_MAX_TEXT_CHARS = 16 * 1024;
export const MONITOR_LOG_MAX_RECORDS = 64;
export const MONITOR_LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface MonitorLogRecord {
	version: 1;
	entry: MonitorEntry;
	outcome: "running" | "exit" | "error" | "timeout" | "cancelled" | "ended";
	/** Last semantic event's text (not an interleaved raw stream). */
	text: string;
	stdout: string;
	stderr: string;
	truncated: boolean;
	storageWarning?: string;
}

export interface MonitorArchiveDeps {
	/** Only the owning session's entries; never a global session/history lookup. */
	entries: () => readonly unknown[];
	/** Session-native custom data, NOT a model-visible custom message. */
	append: (customType: string, data: unknown) => void;
}

const BUDGET_WARNING = "Monitor log persistence unavailable: session archive budget exhausted; this log is retained only in bounded runtime history.";
const APPEND_WARNING = "Monitor log persistence unavailable: appending the session entry failed; this log is retained only in bounded runtime history.";
const HISTORY_WARNING = "Monitor log history unavailable: owning-session entries could not be read; persistence is disabled to preserve the session budget.";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0");
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function validEntry(value: unknown): value is MonitorEntry {
	if (!object(value) || !onlyKeys(value, ["id", "label", "command", "args", "cwd", "mode", "startedAtEpochMs", "expiresAtEpochMs", "maxEvents"])) return false;
	return nonempty(value.id, 512)
		&& nonempty(value.label, MONITOR_MAX_LABEL_CHARS)
		&& nonempty(value.command, MONITOR_MAX_COMMAND_CHARS)
		&& nonempty(value.cwd, 32_768)
		&& (value.mode === "output" || value.mode === "exit")
		&& Array.isArray(value.args) && value.args.length <= MONITOR_MAX_ARGS
		&& Array.from(value.args).every((arg: unknown) => typeof arg === "string" && arg.length <= MONITOR_MAX_ARG_CHARS && !arg.includes("\0"))
		&& value.args.reduce((sum: number, arg: string) => sum + arg.length, 0) <= MONITOR_MAX_ARGV_CHARS
		&& typeof value.startedAtEpochMs === "number" && Number.isFinite(value.startedAtEpochMs) && value.startedAtEpochMs >= 0
		&& typeof value.expiresAtEpochMs === "number" && Number.isFinite(value.expiresAtEpochMs) && value.expiresAtEpochMs >= value.startedAtEpochMs
		&& typeof value.maxEvents === "number" && Number.isInteger(value.maxEvents) && value.maxEvents >= 1 && value.maxEvents <= MONITOR_MAX_EVENTS;
}

function copyEntry(entry: MonitorEntry): MonitorEntry {
	return {
		id: entry.id, label: entry.label, command: entry.command, args: [...entry.args],
		cwd: entry.cwd, mode: entry.mode, startedAtEpochMs: entry.startedAtEpochMs,
		expiresAtEpochMs: entry.expiresAtEpochMs, maxEvents: entry.maxEvents,
	};
}

function copyRecord(record: MonitorLogRecord): MonitorLogRecord {
	return {
		version: 1, entry: copyEntry(record.entry), outcome: record.outcome,
		text: record.text, stdout: record.stdout, stderr: record.stderr, truncated: record.truncated,
		...(record.storageWarning === undefined ? {} : { storageWarning: record.storageWarning }),
	};
}

/** Validate custom-entry DATA for historical operator rendering; never returns input references.
 * Unknown fields are rejected so serialized metadata cannot hide outside the archive budget. */
export function parseMonitorLogRecord(value: unknown): MonitorLogRecord | undefined {
	try {
		return parseRecord(value);
	} catch {
		return undefined;
	}
}

function parseRecord(value: unknown): MonitorLogRecord | undefined {
	if (!object(value) || !onlyKeys(value, ["version", "entry", "outcome", "text", "stdout", "stderr", "truncated", "storageWarning"])
		|| value.version !== 1 || !validEntry(value.entry)) return undefined;
	if (value.outcome !== "exit" && value.outcome !== "error" && value.outcome !== "timeout"
		&& value.outcome !== "cancelled" && value.outcome !== "ended") return undefined;
	if (typeof value.text !== "string" || value.text.length > MONITOR_LOG_MAX_TEXT_CHARS
		|| typeof value.stdout !== "string" || value.stdout.length > MONITOR_LOG_MAX_STREAM_CHARS
		|| typeof value.stderr !== "string" || value.stderr.length > MONITOR_LOG_MAX_STREAM_CHARS
		|| typeof value.truncated !== "boolean"
		|| (value.storageWarning !== undefined && (typeof value.storageWarning !== "string" || value.storageWarning.length > 1024))) return undefined;
	return copyRecord(value as unknown as MonitorLogRecord);
}

/** UTF-8 uses at most three bytes per UTF-16 code unit, AFTER JSON escaping.
 * Reserve extra space for the host's custom-entry envelope. Deliberately conservative:
 * this bounds the archive's serialized records, not arbitrary host/session metadata. */
function storageCost(record: unknown): number {
	return (JSON.stringify(record) ?? "null").length * 3 + 256;
}

/** Bounded, session-native raw logs. No files, processes, timers, wakes, or model messages.
 * Feed only admitted MonitorManager lifecycles (at most MONITOR_MAX_ACTIVE running entries).
 * Completed records are oldest-first; the most recent 64 survive in runtime memory.
 * Hydration runs once, so construct a fresh archive when the owning session changes.
 * History never restores running monitors. A removed observer has no cause information:
 * cancellation, permission revocation, shutdown and synchronous start failure all map to cancelled.
 */
export class MonitorArchive {
	private readonly deps: MonitorArchiveDeps;
	private readonly active = new Map<string, MonitorLogRecord>();
	private readonly completed = new Map<string, MonitorLogRecord>();
	private hydrated = false;
	private persistedCount = 0;
	private persistedBytes = 0;
	private historyWarning: string | undefined;

	constructor(deps: MonitorArchiveDeps) {
		this.deps = deps;
	}

	armed(entry: MonitorEntry): void {
		this.hydrate();
		if (this.active.has(entry.id) || this.completed.has(entry.id)) return;
		this.active.set(entry.id, {
			version: 1, entry: copyEntry(entry), outcome: "running", text: "", stdout: "", stderr: "", truncated: false,
			...(this.historyWarning === undefined ? {} : { storageWarning: this.historyWarning }),
		});
	}

	output({ id, stream, text }: MonitorOutput): void {
		const record = this.active.get(id);
		if (!record || !text) return;
		const current = record[stream];
		if (current.length + text.length > MONITOR_LOG_MAX_STREAM_CHARS) record.truncated = true;
		// Slice the chunk BEFORE concatenation: a huge callback must not create a huge copy.
		record[stream] = text.length >= MONITOR_LOG_MAX_STREAM_CHARS
			? text.slice(-MONITOR_LOG_MAX_STREAM_CHARS)
			: (current + text).slice(-MONITOR_LOG_MAX_STREAM_CHARS);
	}

	event(event: MonitorEvent): void {
		const record = this.active.get(event.id);
		if (!record) return;
		record.text = event.text.slice(0, MONITOR_LOG_MAX_TEXT_CHARS);
		if (event.text.length > MONITOR_LOG_MAX_TEXT_CHARS) record.truncated = true;
		if (!event.terminal) return;
		record.outcome = event.kind === "output" ? "ended" : event.kind;
		this.finish(record);
	}

	removed(entry: MonitorEntry): void {
		const record = this.active.get(entry.id);
		if (!record) return;
		record.outcome = "cancelled";
		this.finish(record);
	}

	result(id: string): MonitorLogRecord | undefined {
		this.hydrate();
		const record = this.active.get(id) ?? this.completed.get(id);
		return record ? copyRecord(record) : undefined;
	}

	list(): MonitorLogRecord[] {
		this.hydrate();
		return [...this.completed.values(), ...this.active.values()].map(copyRecord);
	}

	private hydrate(): void {
		if (this.hydrated) return;
		this.hydrated = true;
		try {
			const entries = this.deps.entries();
			if (!Array.isArray(entries)) throw new Error("invalid session entries");
			for (const entry of entries) {
				try {
					if (!object(entry) || entry.type !== "custom" || entry.customType !== MONITOR_LOG_ENTRY) continue;
					// Charge even unknown/malformed versions and duplicate ids: ignoring a record
					// for retrieval does not remove its bytes from an append-only session.
					this.persistedCount++;
					this.persistedBytes += storageCost(entry.data);
					const record = parseMonitorLogRecord(entry.data);
					if (record) this.remember(record);
				} catch {
					// An unaccountable entry cannot safely reset the lifetime budget.
					this.historyWarning = HISTORY_WARNING;
				}
			}
		} catch {
			// Without a trustworthy baseline, appending could silently overrun the session quota.
			this.historyWarning = HISTORY_WARNING;
		}
	}

	private finish(record: MonitorLogRecord): void {
		// Settle BEFORE calling injected persistence; duplicate/reentrant callbacks are inert.
		this.active.delete(record.entry.id);
		this.remember(record);
		if (this.historyWarning !== undefined) {
			record.storageWarning = this.historyWarning;
			return;
		}
		const cost = storageCost(record);
		if (this.persistedCount >= MONITOR_LOG_MAX_RECORDS || this.persistedBytes + cost > MONITOR_LOG_MAX_BYTES) {
			record.storageWarning = BUDGET_WARNING;
			return;
		}
		// Reserve even when append throws: it may have committed before reporting failure.
		// This also bounds repeated failing append attempts over the runtime's lifetime.
		this.persistedCount++;
		this.persistedBytes += cost;
		try {
			this.deps.append(MONITOR_LOG_ENTRY, copyRecord(record));
		} catch {
			record.storageWarning = APPEND_WARNING;
		}
	}

	private remember(record: MonitorLogRecord): void {
		this.completed.delete(record.entry.id);
		this.completed.set(record.entry.id, record);
		while (this.completed.size > MONITOR_LOG_MAX_RECORDS) {
			const oldest = this.completed.keys().next().value;
			if (oldest !== undefined) this.completed.delete(oldest);
		}
	}
}

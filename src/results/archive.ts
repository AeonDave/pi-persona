import { randomUUID } from "node:crypto";
import {
	createTerminalResultRecord, isResultRef, pageStoredBody, parseTerminalResultInput,
	parseTerminalResultRecord, payloadBytes,
} from "./record.ts";
import {
	TERMINAL_RESULT_ENTRY, RESULT_MAX_ENTRIES, RESULT_MAX_PAYLOAD_BYTES, RESULT_LIST_DEFAULT, RESULT_LIST_MAX,
	type ArchiveEvidence, type ArchiveFailure, type ResultListRequest, type ResultPage, type ResultReadRequest,
	type ResultStorage, type ResultSummary, type ResultSummaryPage, type ResultWarning, type SaveOutcome,
	type TerminalResultArchiveDeps, type TerminalResultInput, type TerminalResultRecord,
} from "./types.ts";

interface RetainedResult {
	record: TerminalResultRecord;
	storage: ResultStorage;
	storageError?: string;
}
interface SourceResult { data: unknown; index: number; retained?: RetainedResult }
type Lookup = { kind: "missing" } | { kind: "ambiguous" | "corrupt" } | {
	kind: "found"; record: TerminalResultRecord; index: number; retained?: RetainedResult;
};

function identity(data: unknown): { ref?: string; originKey?: string } {
	try {
		if (data === null || typeof data !== "object") return {};
		const value = data as Record<string, unknown>;
		return {
			...(isResultRef(value.ref) ? { ref: value.ref } : {}),
			...(typeof value.originKey === "string" && value.originKey.length <= 1024 ? { originKey: value.originKey } : {}),
		};
	} catch { return {}; }
}

function summary(record: TerminalResultRecord, storage: ResultStorage): ResultSummary {
	// Parse again to detach optional usage too; callers never receive our mutable state.
	const copy = parseTerminalResultRecord(record)!;
	const { body: _body, payloadHash: _hash, ...metadata } = copy;
	return { ...metadata, storage };
}

function validQuery(value: unknown, keys: readonly string[]): boolean {
	try {
		if (value === null || typeof value !== "object") return false;
		const proto: unknown = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return false;
		return Reflect.ownKeys(value).every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return typeof key === "string" && keys.includes(key) && descriptor?.enumerable === true && "value" in descriptor;
		});
	} catch { return false; }
}

function errorDetail(error: unknown): string {
	try {
		const text = error instanceof Error ? error.message : String(error);
		return text.slice(0, 2048);
	} catch { return "Storage callback threw an unreadable error"; }
}

/** One session-file owner, fixed at construction by the adapter. No filesystem, Pi imports,
 * replay, wake or worker lifecycle. Native history is scanned without caching report bodies;
 * even over-quota/corrupt histories leave valid unrelated reports queryable. Local accepted
 * records and uncertain append reservations are bounded by the SAME count/byte ceilings.
 * The native entry array is a host-owned immutable snapshot: its initial length is pinned so
 * a host that appends to that same array cannot double-charge our own reserved writes.
 */
export class TerminalResultArchive {
	private readonly deps: TerminalResultArchiveDeps;
	private hydrated = false;
	private hydrating = false;
	private history: readonly unknown[] = [];
	private historyLength = 0;
	private historyCount = 0;
	private chargedEntries = 0;
	private chargedPayloadBytes: number | null = 0;
	private localBytes = 0;
	private readonly retained: RetainedResult[] = [];
	private readonly warnings = new Set<ResultWarning>();
	private saving = false;

	constructor(deps: TerminalResultArchiveDeps) {
		// Copy callbacks/flags: mutating a caller's dependency object cannot retarget this owner.
		this.deps = { ...deps };
	}

	save(input: TerminalResultInput): SaveOutcome {
		if (this.saving || this.hydrating) return this.failure("busy", "A terminal result save or history accounting is already in progress");
		this.saving = true;
		try { this.hydrate(); return this.saveInput(input); }
		finally { this.saving = false; }
	}

	read(request: ResultReadRequest): ResultPage {
		if (this.hydrating) return this.failure("busy", "Terminal result history accounting is in progress");
		this.hydrate();
		if (!validQuery(request, ["ref", "offset", "limit"]) || !isResultRef(request.ref)) {
			return this.failure("invalid", "Expected result:<UUID> and an optional stored-body offset/limit");
		}
		const found = this.lookup("ref", request.ref);
		if (found.kind === "missing") return this.failure("unavailable", "Result reference is unavailable in this owning session");
		if (found.kind !== "found") return this.failure(found.kind, "Result identity is ambiguous or corrupt in this owning session");
		const page = pageStoredBody(found.record, request.offset, request.limit);
		if (!page) return this.failure("invalid", "Invalid stored-body UTF-16 offset or read limit (2..16000); surrogate pairs cannot be split");
		return {
			ok: true, summary: summary(found.record, this.storage(found.retained)), ...page,
			...this.evidence(found.record, found.retained),
		};
	}

	list(request: ResultListRequest = {}): ResultSummaryPage {
		if (this.hydrating) return this.failure("busy", "Terminal result history accounting is in progress");
		this.hydrate();
		if (!validQuery(request, ["cursor", "limit"])) return this.failure("invalid", "Expected a result-list query");
		const cursor = request.cursor === undefined ? 0 : request.cursor;
		const limit = request.limit === undefined ? RESULT_LIST_DEFAULT : request.limit;
		if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.historyCount + this.retained.length
			|| !Number.isInteger(limit) || limit < 1 || limit > RESULT_LIST_MAX) {
			return this.failure("invalid", "Invalid result list cursor or limit (1..50)");
		}
		const results: ResultSummary[] = [];
		let nextCursor: number | undefined;
		for (const source of this.sources()) {
			if (source.index < cursor) continue;
			const record = parseTerminalResultRecord(source.data);
			if (!record) continue;
			const found = this.lookup("ref", record.ref);
			if (found.kind !== "found" || found.index !== source.index) continue;
			if (results.length === limit) { nextCursor = source.index; break; }
			results.push(summary(record, this.storage(found.retained)));
		}
		return { ok: true, results, ...(nextCursor === undefined ? {} : { nextCursor }), ...this.evidence() };
	}

	private saveInput(value: unknown): SaveOutcome {
		const input = parseTerminalResultInput(value);
		if (!input) return this.failure("invalid", "Invalid terminal result projection or metadata limits");
		const existing = this.lookup("originKey", input.originKey);
		if (existing.kind === "ambiguous" || existing.kind === "corrupt") {
			return this.failure(existing.kind, "The origin already has an ambiguous or corrupt result");
		}
		if (existing.kind === "found") {
			const candidate = createTerminalResultRecord(input, existing.record.ref, input.createdAt ?? existing.record.createdAt);
			if (JSON.stringify(parseTerminalResultRecord(candidate)) !== JSON.stringify(existing.record)) {
				return this.failure("conflict", "The immutable origin already belongs to a different terminal payload");
			}
			return this.receipt(existing.record, existing.retained, true);
		}
		let record: TerminalResultRecord;
		try {
			const ref = this.deps.makeRef === undefined ? `result:${randomUUID()}` : this.deps.makeRef();
			if (!isResultRef(ref)) return this.failure("invalid", "Reference factory must return result:<UUID>");
			const collision = this.lookup("ref", ref);
			if (collision.kind !== "missing") return this.failure(collision.kind === "found" ? "conflict" : collision.kind, "Generated result reference is already occupied");
			record = createTerminalResultRecord(input, ref, input.createdAt ?? (this.deps.clock === undefined ? Date.now() : this.deps.clock()));
		} catch (error) { return this.failure("invalid", errorDetail(error)); }
		const cost = payloadBytes(record);
		if (this.chargedEntries >= RESULT_MAX_ENTRIES || this.localBytes + cost > RESULT_MAX_PAYLOAD_BYTES
			|| (this.chargedPayloadBytes !== null && this.chargedPayloadBytes + cost > RESULT_MAX_PAYLOAD_BYTES)) {
			return this.failure("quota", "Terminal result lifetime payload/count quota exhausted; append-only storage is not reclaimed");
		}
		// Reserve before invoking host code. A throw may occur AFTER a physical/session commit.
		// Never retry this origin into another entry or treat memory retention as proof of durability.
		this.chargedEntries++;
		if (this.chargedPayloadBytes !== null) this.chargedPayloadBytes += cost;
		this.localBytes += cost;
		const retained: RetainedResult = { record, storage: "memory-only" };
		this.retained.push(retained);
		if (this.deps.persistent && this.chargedPayloadBytes !== null) {
			try {
				this.deps.append(TERMINAL_RESULT_ENTRY, parseTerminalResultRecord(record)!);
				retained.storage = "session-entry";
			} catch (error) { retained.storageError = errorDetail(error); }
		}
		return this.receipt(record, retained, false);
	}

	private storage(retained: RetainedResult | undefined): ResultStorage {
		return retained?.storage ?? (this.deps.persistent ? "session-entry" : "memory-only");
	}

	private receipt(record: TerminalResultRecord, retained: RetainedResult | undefined, idempotent: boolean): SaveOutcome {
		const storage = this.storage(retained);
		return {
			ok: true, ref: record.ref, storage, summary: summary(record, storage), idempotent,
			...(retained?.storageError === undefined ? {} : { storageError: retained.storageError }),
			...this.evidence(record, retained),
		};
	}

	private hydrate(): void {
		if (this.hydrated) return;
		this.hydrated = true;
		this.hydrating = true;
		if (!this.deps.persistent) this.warnings.add("no-session-storage");
		try {
			const entries = this.deps.entries();
			if (!Array.isArray(entries)) throw new Error("Invalid owning-session entry list");
			this.history = entries;
			this.historyLength = entries.length;
			for (const source of this.sources()) {
				this.chargedEntries++;
				try {
					const cost = payloadBytes(source.data);
					if (this.chargedPayloadBytes !== null) this.chargedPayloadBytes += cost;
					if (!Number.isSafeInteger(this.chargedPayloadBytes)) this.disablePersistence();
				} catch { this.disablePersistence(); }
				if (!parseTerminalResultRecord(source.data)) this.warnings.add("invalid-history");
			}
			this.historyCount = this.chargedEntries;
		} catch { this.disablePersistence(); }
		finally { this.hydrating = false; }
	}

	private *sources(): Generator<SourceResult> {
		let index = 0;
		for (let i = 0; i < this.historyLength; i++) {
			try {
				const raw = this.history[i];
				if (raw === null || typeof raw !== "object") continue;
				const entry = raw as Record<string, unknown>;
				if (entry.type !== "custom" || entry.customType !== TERMINAL_RESULT_ENTRY) continue;
				// Count the entry even when reading its data throws.
				let data: unknown;
				try { data = entry.data; } catch { this.disablePersistence(); }
				yield { data, index: index++ };
			} catch { this.disablePersistence(); }
		}
		for (const retained of this.retained) yield { data: retained.record, index: index++, retained };
	}

	/** Two bounded-memory scans, not a report cache or an unbounded identity index. */
	private lookup(key: "ref" | "originKey", value: string): Lookup {
		let first: { record: TerminalResultRecord; source: SourceResult } | undefined;
		for (const source of this.sources()) {
			if (identity(source.data)[key] !== value) continue;
			const record = parseTerminalResultRecord(source.data);
			if (!record) return { kind: "corrupt" };
			first = { record, source };
			break;
		}
		if (!first) return { kind: "missing" };
		const canonical = JSON.stringify(first.record);
		for (const source of this.sources()) {
			if (source.index === first.source.index) continue;
			const id = identity(source.data);
			if (id.ref !== first.record.ref && id.originKey !== first.record.originKey) continue;
			const record = parseTerminalResultRecord(source.data);
			if (!record) return { kind: "corrupt" };
			if (JSON.stringify(record) !== canonical) {
				this.warnings.add("ambiguous-history");
				return { kind: "ambiguous" };
			}
			this.warnings.add("duplicate-history");
		}
		return {
			kind: "found", record: first.record, index: first.source.index,
			...(first.source.retained === undefined ? {} : { retained: first.source.retained }),
		};
	}

	private disablePersistence(): void {
		this.chargedPayloadBytes = null;
		this.warnings.add("accounting-unavailable");
	}

	private evidence(record?: TerminalResultRecord, retained?: RetainedResult): ArchiveEvidence {
		const warnings = new Set(this.warnings);
		if (record?.truncated) warnings.add("body-truncated");
		if (retained?.storageError !== undefined) warnings.add("append-failed");
		return {
			accounting: {
				chargedEntries: this.chargedEntries, chargedPayloadBytes: this.chargedPayloadBytes,
				persistenceDisabled: !this.deps.persistent || this.chargedPayloadBytes === null,
			}, warnings: [...warnings],
		};
	}

	private failure(reason: ArchiveFailure["reason"], message: string): ArchiveFailure {
		return { ok: false, reason, message, ...this.evidence() };
	}
}

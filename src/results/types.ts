import type { ThinkingLevel } from "../core/types.ts";

export const TERMINAL_RESULT_ENTRY = "pi-persona-terminal-result";
export const RESULT_MAX_ENTRIES = 128;
/** UTF-8 JSON custom-entry DATA only; the host's JSONL envelope is excluded. */
export const RESULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const RESULT_MAX_RECORD_BYTES = 512 * 1024;
export const RESULT_MAX_BODY_CHARS = 262_144;
export const RESULT_READ_DEFAULT = 8_000;
export const RESULT_READ_MAX = 16_000;
export const RESULT_LIST_DEFAULT = 20;
export const RESULT_LIST_MAX = 50;

export type TerminalStatus = "done" | "failed" | "stopped";
export type ResultProvenance = "result-output" | "partial-output" | "error";
export type ResultStorage = "session-entry" | "memory-only";
export type ResultWarning = "no-session-storage" | "accounting-unavailable" | "invalid-history"
	| "duplicate-history" | "ambiguous-history" | "append-failed" | "body-truncated";

/** Cumulative usage only, never a context-window claim or per-token stream. */
export interface TerminalUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

/** Trusted caller projection, NOT an arbitrary AgentResult. Unknown fields are rejected.
 * Metadata ceilings (UTF-16): originKey 1024, originRunId/agent 128, label 256,
 * model 512, error 2048. Invalid metadata rejects the save rather than silently changing it. */
export interface TerminalResultInput {
	/** Immutable activation + run/phase identity. Routing labels are not identities. */
	originKey: string;
	originRunId?: string;
	status: TerminalStatus;
	agent: string;
	label?: string;
	model?: string;
	thinkingRequested?: ThinkingLevel;
	thinkingEffective?: ThinkingLevel;
	usage?: TerminalUsage;
	/** Epoch milliseconds. Omit to stamp a NEW record with the injected clock. */
	createdAt?: number;
	body: string;
	provenance: ResultProvenance;
	error?: string;
}

export interface TerminalResultRecord extends Omit<TerminalResultInput, "createdAt"> {
	version: 1;
	ref: string;
	createdAt: number;
	/** SHA-256 content identity includes the original body, even its discarded suffix.
	 * This is collision detection, not authentication of host history. */
	payloadHash: string;
	originalChars: number;
	storedChars: number;
	truncated: boolean;
}

export interface ResultSummary extends Omit<TerminalResultRecord, "body" | "payloadHash"> {
	storage: ResultStorage;
}

export interface ResultAccounting {
	/** Includes unknown/malformed/duplicate history and reserved append attempts. */
	chargedEntries: number;
	/** null means the lifetime baseline is unaccountable; persistence is disabled. */
	chargedPayloadBytes: number | null;
	persistenceDisabled: boolean;
}

export interface ArchiveEvidence {
	accounting: ResultAccounting;
	warnings: ResultWarning[];
}

export interface ArchiveFailure extends ArchiveEvidence {
	ok: false;
	reason: "invalid" | "unavailable" | "conflict" | "ambiguous" | "corrupt" | "quota" | "busy";
	message: string;
}

export type SaveOutcome = ArchiveFailure | (ArchiveEvidence & {
	ok: true;
	ref: string;
	/** session-entry means append returned normally or data came from native history.
	 * It is NOT an fsync/crash-survival guarantee. memory-only is never a durable receipt. */
	storage: ResultStorage;
	summary: ResultSummary;
	idempotent: boolean;
	storageError?: string;
});

export interface ResultReadRequest { ref: string; offset?: number; limit?: number }
export type ResultPage = ArchiveFailure | (ArchiveEvidence & {
	ok: true;
	summary: ResultSummary;
	/** Untrusted text; the integration must apply its shared fence on model delivery. */
	body: string;
	offset: number;
	nextOffset?: number;
	/** Reached the end of the STORED body, not necessarily the original report. */
	endOfStoredBody: boolean;
});

export interface ResultListRequest { cursor?: number; limit?: number }
export type ResultSummaryPage = ArchiveFailure | (ArchiveEvidence & {
	ok: true;
	results: ResultSummary[];
	/** Opaque-in-practice append ordinal, not a run id or a branch-local index. */
	nextCursor?: number;
});

export interface TerminalResultArchiveDeps {
	/** All branches in ONE owning session file. Never read parent/foreign files.
	 * History entries are immutable host data. Hydration is read-only and runs once.
	 * Recreate the archive on owner change; adapters must reject stale-owner writes. */
	entries: () => readonly unknown[];
	/** Native custom ENTRY, not a model message. May throw after partially committing. */
	append: (customType: string, data: unknown) => void;
	persistent: boolean;
	/** Must return result:<UUID>. The default uses node:crypto.randomUUID(). */
	makeRef?: () => string;
	clock?: () => number;
}

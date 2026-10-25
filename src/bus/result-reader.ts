/** Narrow result-read boundary. No archive ownership, discovery, paths or session identity.
 * The parent supplies a reader that checks CURRENT capabilities/owner and its explicit ref
 * grant on every call. The broker owns attachment, cancellation and wire validation only. */
import { isResultRef } from "../results/record.ts";
import { RESULT_READ_DEFAULT, RESULT_READ_MAX, type ResultReadRequest, type ResultProvenance,
	type TerminalStatus } from "../results/types.ts";

export type { ResultReadRequest } from "../results/types.ts";
export const RESULT_READ_TIMEOUT_MS = 10_000;
export const RESULT_READ_MAX_PENDING = 8;
export const RESULT_READ_MAX_FRAME_BYTES = 128 * 1024;
/** Bound replay tracking without ever evicting an id and accepting its replay. Exhaustion
 * ends the reader connection; it does not reconnect or retry. */
export const RESULT_READ_MAX_REQUESTS = 4096;

const ERROR_MESSAGES = {
	invalid: "Invalid result read request.",
	denied: "Result read is not authorized.",
	revoked: "Result reader was revoked.",
	unavailable: "Result reader is unavailable.",
	cancelled: "Result read was cancelled.",
	timeout: "Result read deadline exceeded.",
	busy: "Too many pending result reads.",
	protocol: "Invalid result reader protocol.",
} as const;
export type ReadErrorCode = keyof typeof ERROR_MESSAGES;
export type ReadReply = {
	ok: true; ref: string; body: string; offset: number; nextOffset?: number;
	storedChars: number; originalChars: number; truncated: boolean; endOfStoredBody: boolean;
	status: TerminalStatus; provenance: ResultProvenance;
} | { ok: false; code: ReadErrorCode; message: string };

export interface ScopedReader {
	read(request: ResultReadRequest, signal?: AbortSignal): Promise<ReadReply>;
	revoke(): void;
}

export interface PreparedResultReader {
	/** Private spawn environment only. Never put in tasks, receipts or diagnostics. */
	token: string;
	revoke(): void;
	/** Historical attachment evidence, not a promise of continued connectivity. */
	wasBound(): boolean;
}

export function readFailure(code: ReadErrorCode): ReadReply & { ok: false } {
	return { ok: false, code, message: ERROR_MESSAGES[code] };
}

/** Reject hidden/accessor fields too: this validator is also used on parent callback data. */
export function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every((key) => {
		const d = Object.getOwnPropertyDescriptor(value, key);
		return typeof key === "string" && keys.includes(key) && d?.enumerable === true && "value" in d;
	});
}
const counter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function isReadRequest(value: unknown): value is ResultReadRequest {
	return closedRecord(value, ["ref", "offset", "limit"]) && isResultRef(value.ref)
		&& (!("offset" in value) || counter(value.offset))
		&& (!("limit" in value) || (counter(value.limit) && value.limit >= 2 && value.limit <= RESULT_READ_MAX));
}

export function isReadReply(value: unknown): value is ReadReply {
	if (!closedRecord(value, ["ok", "ref", "body", "offset", "nextOffset", "storedChars", "originalChars",
		"truncated", "endOfStoredBody", "status", "provenance", "code", "message"])) return false;
	if (value.ok === false) return closedRecord(value, ["ok", "code", "message"])
		&& typeof value.code === "string" && Object.hasOwn(ERROR_MESSAGES, value.code)
		&& value.message === ERROR_MESSAGES[value.code as ReadErrorCode];
	if (value.ok !== true || "code" in value || "message" in value || !isResultRef(value.ref)
		|| typeof value.body !== "string" || value.body.length > RESULT_READ_MAX || !counter(value.offset)
		|| !counter(value.storedChars) || !counter(value.originalChars) || value.originalChars < value.storedChars
		|| value.truncated !== (value.originalChars > value.storedChars)
		|| (value.status !== "done" && value.status !== "failed" && value.status !== "stopped")
		|| (value.provenance !== "result-output" && value.provenance !== "partial-output" && value.provenance !== "error")) return false;
	const end = value.offset + value.body.length;
	if (!Number.isSafeInteger(end) || end > value.storedChars || value.endOfStoredBody !== (end === value.storedChars)) return false;
	return value.endOfStoredBody ? !("nextOffset" in value) : value.body.length > 0 && value.nextOffset === end;
}

/** Page offsets are UTF-16; the archive, not transport, owns surrogate-boundary slicing. */
export function isReadReplyFor(value: unknown, request: ResultReadRequest): value is ReadReply {
	return isReadReply(value) && (!value.ok || (value.ref === request.ref && value.offset === (request.offset ?? 0)
		&& value.body.length <= (request.limit ?? RESULT_READ_DEFAULT)));
}

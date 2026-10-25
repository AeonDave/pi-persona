import { createHash } from "node:crypto";
import { isThinkingLevel } from "../core/types.ts";
import {
	RESULT_MAX_BODY_CHARS, RESULT_MAX_RECORD_BYTES, RESULT_READ_DEFAULT, RESULT_READ_MAX,
	type TerminalResultInput, type TerminalResultRecord, type TerminalUsage,
} from "./types.ts";

const INPUT_KEYS = ["originKey", "originRunId", "status", "agent", "label", "model", "thinkingRequested",
	"thinkingEffective", "usage", "createdAt", "body", "provenance", "error"];
const RECORD_KEYS = [...INPUT_KEYS, "version", "ref", "payloadHash", "originalChars", "storedChars", "truncated"];
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"];
const REF_PATTERN = /^result:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isResultRef(value: unknown): value is string {
	return typeof value === "string" && REF_PATTERN.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Reflect.ownKeys(value).every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return typeof key === "string" && keys.includes(key) && descriptor?.enumerable === true && "value" in descriptor;
	});
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function counter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function usage(value: unknown): value is TerminalUsage {
	return object(value) && onlyKeys(value, USAGE_KEYS) && counter(value.input) && counter(value.output)
		&& ["cacheRead", "cacheWrite", "turns"].every((key) => value[key] === undefined || counter(value[key]))
		&& (value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost)
			&& value.cost >= 0 && value.cost <= Number.MAX_SAFE_INTEGER));
}

function validFields(value: Record<string, unknown>): boolean {
	return text(value.originKey, 1024) && text(value.agent, 128)
		&& (value.status === "done" || value.status === "failed" || value.status === "stopped")
		&& (value.provenance === "result-output" || value.provenance === "partial-output" || value.provenance === "error")
		&& typeof value.body === "string"
		&& (value.originRunId === undefined || text(value.originRunId, 128))
		&& (value.label === undefined || text(value.label, 256))
		&& (value.model === undefined || text(value.model, 512))
		&& (value.error === undefined || (typeof value.error === "string" && value.error.length <= 2048))
		&& (value.createdAt === undefined || counter(value.createdAt))
		&& (value.thinkingRequested === undefined || isThinkingLevel(value.thinkingRequested))
		&& (value.thinkingEffective === undefined || isThinkingLevel(value.thinkingEffective))
		&& (value.usage === undefined || usage(value.usage));
}

/** Fixed key order and detached metadata for canonical equality and caller immutability. */
function fields(value: TerminalResultInput): TerminalResultInput {
	const u = value.usage;
	return {
		originKey: value.originKey, status: value.status, agent: value.agent,
		...(value.originRunId === undefined ? {} : { originRunId: value.originRunId }),
		...(value.label === undefined ? {} : { label: value.label }),
		...(value.model === undefined ? {} : { model: value.model }),
		...(value.thinkingRequested === undefined ? {} : { thinkingRequested: value.thinkingRequested }),
		...(value.thinkingEffective === undefined ? {} : { thinkingEffective: value.thinkingEffective }),
		...(u === undefined ? {} : { usage: {
			input: u.input, output: u.output,
			...(u.cacheRead === undefined ? {} : { cacheRead: u.cacheRead }),
			...(u.cacheWrite === undefined ? {} : { cacheWrite: u.cacheWrite }),
			...(u.cost === undefined ? {} : { cost: u.cost }),
			...(u.turns === undefined ? {} : { turns: u.turns }),
		} }),
		...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
		body: value.body, provenance: value.provenance,
		...(value.error === undefined ? {} : { error: value.error }),
	};
}

export function parseTerminalResultInput(value: unknown): TerminalResultInput | undefined {
	try {
		if (!object(value) || !onlyKeys(value, INPUT_KEYS) || !validFields(value)) return undefined;
		return fields(value as unknown as TerminalResultInput);
	} catch { return undefined; }
}

/** Actual serialized DATA bytes. Undefined/circular/unserializable data has no safe cost. */
export function payloadBytes(value: unknown): number {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("Terminal result payload is not JSON serializable");
	return Buffer.byteLength(json, "utf8");
}

/** Cut positions are UTF-16 offsets; preserve an existing high/low surrogate pair. */
function safeEnd(body: string, end: number): number {
	const before = body.charCodeAt(end - 1);
	const after = body.charCodeAt(end);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}

export function createTerminalResultRecord(input: TerminalResultInput, ref: string, createdAt: number): TerminalResultRecord {
	if (!isResultRef(ref) || !counter(createdAt)) throw new Error("Invalid terminal result reference or timestamp");
	const canonical = fields(input);
	// Hash the original body separately so canonicalization need not allocate a JSON-escaped
	// copy of an arbitrarily large input. Hash UTF-16LE: distinct lone surrogates stay distinct.
	const bodyHash = createHash("sha256").update(canonical.body, "utf16le").digest("hex");
	// Timestamp equality is checked on the canonical record itself: explicitly supplying
	// the original default timestamp must not change content identity on a repeat save.
	const { createdAt: _timestamp, ...content } = canonical;
	const payloadHash = createHash("sha256").update(JSON.stringify({ ...content, body: bodyHash })).digest("hex");
	const record: TerminalResultRecord = {
		...canonical, version: 1, ref, createdAt, payloadHash,
		body: "", originalChars: input.body.length, storedChars: 0, truncated: input.body.length > 0,
	};
	const setLength = (length: number): void => {
		record.body = input.body.slice(0, safeEnd(input.body, length));
		record.storedChars = record.body.length;
		record.truncated = record.storedChars < record.originalChars;
	};
	let low = 0;
	let high = Math.min(input.body.length, RESULT_MAX_BODY_CHARS);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		setLength(mid);
		if (payloadBytes(record) <= RESULT_MAX_RECORD_BYTES) low = mid;
		else high = mid - 1;
	}
	setLength(low);
	if (payloadBytes(record) > RESULT_MAX_RECORD_BYTES) throw new Error("Terminal result metadata exceeds record quota");
	return record;
}

/** Strict, detached version-1 DATA. No rendering, instructions, callbacks or AgentResult blobs. */
export function parseTerminalResultRecord(value: unknown): TerminalResultRecord | undefined {
	try {
		if (!object(value) || !onlyKeys(value, RECORD_KEYS) || !validFields(value)
			|| value.version !== 1 || !isResultRef(value.ref) || !counter(value.createdAt)
			|| typeof value.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadHash)
			|| !counter(value.originalChars) || !counter(value.storedChars) || typeof value.truncated !== "boolean"
			|| typeof value.body !== "string" || value.body.length > RESULT_MAX_BODY_CHARS
			|| value.storedChars !== value.body.length || value.originalChars < value.storedChars
			|| value.truncated !== (value.originalChars > value.storedChars)
			|| payloadBytes(value) > RESULT_MAX_RECORD_BYTES) return undefined;
		return {
			...fields(value as unknown as TerminalResultInput), version: 1, ref: value.ref, createdAt: value.createdAt,
			payloadHash: value.payloadHash, originalChars: value.originalChars,
			storedChars: value.storedChars, truncated: value.truncated,
		};
	} catch { return undefined; }
}

export interface StoredBodyPage { body: string; offset: number; nextOffset?: number; endOfStoredBody: boolean }

export function pageStoredBody(record: TerminalResultRecord, offset = 0, limit = RESULT_READ_DEFAULT): StoredBodyPage | undefined {
	if (!counter(offset) || offset > record.body.length || safeEnd(record.body, offset) !== offset
		|| !Number.isInteger(limit) || limit < 2 || limit > RESULT_READ_MAX) return undefined;
	const end = safeEnd(record.body, Math.min(record.body.length, offset + limit));
	return {
		body: record.body.slice(offset, end), offset, endOfStoredBody: end === record.body.length,
		...(end < record.body.length ? { nextOffset: end } : {}),
	};
}

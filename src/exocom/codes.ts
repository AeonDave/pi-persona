/**
 * Persistent four-character Exocom join aliases.
 *
 * The alias is presentation-only: the durable value is the existing 24-hex scope id.  Alias
 * files are intentionally kept out of the registry directory because this allocator owns a
 * different invariant: once a code has been assigned, it is never assigned to another scope.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const JOIN_CODE_LENGTH = 4;
export const JOIN_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const MAX_JOIN_CODE_ATTEMPTS = 256;
const MAPPING_MAX_BYTES = 4 * 1024;
const CODES_DIRECTORY = "codes";
const USED_DIRECTORY = ".used";
const MAPPING_VERSION = 1;
const JOIN_CODE_PATTERN = /^[0-9A-Za-z]{4}$/;
const SCOPE_ID_PATTERN = /^[0-9a-f]{24}$/i;

type Mapping = { code: string; scope_id: string; version: number };
type Reservation = { code: string; scope_id: string; version: number };
type ReadState<T> = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: T };

/** Return true only for the public, case-sensitive four-character Base62 grammar. */
export function isJoinCode(value: unknown): value is string {
	return typeof value === "string" && JOIN_CODE_PATTERN.test(value);
}

/** Validate and return a join code; callers that accept untrusted input should catch this error. */
export function validateJoinCode(value: unknown): string {
	if (!isJoinCode(value)) throw new TypeError("join code must be exactly four Base62 characters");
	return value;
}

function normalizeScopeId(value: unknown): string {
	if (typeof value !== "string" || !SCOPE_ID_PATTERN.test(value)) {
		throw new TypeError("scope id must be exactly 24-hex characters");
	}
	return value.toLowerCase();
}

function codesDirectory(agentDir: string): string {
	return join(agentDir, "persona", "exocom", CODES_DIRECTORY);
}

function usedDirectory(agentDir: string): string {
	return join(codesDirectory(agentDir), USED_DIRECTORY);
}

/** Encode each ASCII byte so a mixed-case alias is never used as a case-folding filesystem name. */
export function encodeJoinCode(code: string): string {
	return Buffer.from(validateJoinCode(code), "ascii").toString("hex");
}

export function joinCodePath(agentDir: string, code: string): string {
	return join(codesDirectory(agentDir), `${encodeJoinCode(code)}.json`);
}

export function joinCodeReservationPath(agentDir: string, code: string): string {
	return join(usedDirectory(agentDir), `${encodeJoinCode(code)}.json`);
}

function candidateBytes(scopeId: string, attempt: number): Buffer {
	return createHash("sha256")
		.update("pi-persona-exocom-join-code-v1\0", "utf8")
		.update(scopeId, "utf8")
		.update("\0", "utf8")
		.update(String(attempt), "utf8")
		.digest();
}

/** Generate the deterministic candidate for one bounded allocation attempt. */
export function candidateJoinCode(scopeId: string, attempt = 0): string {
	const normalizedScope = normalizeScopeId(scopeId);
	if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_JOIN_CODE_ATTEMPTS) {
		throw new RangeError(`join-code attempt must be an integer from 0 to ${MAX_JOIN_CODE_ATTEMPTS - 1}`);
	}
	let value = BigInt(`0x${candidateBytes(normalizedScope, attempt).toString("hex")}`);
	let code = "";
	for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
		const index = Number(value % BigInt(JOIN_CODE_ALPHABET.length));
		code = `${JOIN_CODE_ALPHABET[index]!}${code}`;
		value /= BigInt(JOIN_CODE_ALPHABET.length);
	}
	return code;
}

function ensureDirectory(path: string): void {
	try {
		const existing = lstatSync(path);
		if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`unsafe join-code directory: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(path, { recursive: true, mode: 0o700 });
		const created = lstatSync(path);
		if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`unsafe join-code directory: ${path}`);
	}
}

function readJson<T>(path: string, parse: (value: unknown) => T | undefined): ReadState<T> {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid" };
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAPPING_MAX_BYTES) return { kind: "invalid" };
	const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	let fd: number | undefined;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | noFollow);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > MAPPING_MAX_BYTES) return { kind: "invalid" };
		const parsed: unknown = JSON.parse(readFileSync(fd, { encoding: "utf8" }));
		const value = parse(parsed);
		return value === undefined ? { kind: "invalid" } : { kind: "valid", value };
	} catch {
		return { kind: "invalid" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parseMapping(expectedCode: string): (value: unknown) => Mapping | undefined {
	return (value) => {
		if (!value || typeof value !== "object") return undefined;
		const candidate = value as Record<string, unknown>;
		if (candidate.version !== MAPPING_VERSION || candidate.code !== expectedCode) return undefined;
		if (typeof candidate.scope_id !== "string" || !SCOPE_ID_PATTERN.test(candidate.scope_id)) return undefined;
		return { version: MAPPING_VERSION, code: expectedCode, scope_id: candidate.scope_id.toLowerCase() };
	};
}

function reservationState(agentDir: string, code: string): ReadState<Reservation> {
	return readJson(joinCodeReservationPath(agentDir, code), (value) => {
		if (!value || typeof value !== "object") return undefined;
		const candidate = value as Record<string, unknown>;
		if (candidate.version !== MAPPING_VERSION || candidate.code !== code) return undefined;
		if (typeof candidate.scope_id !== "string" || !SCOPE_ID_PATTERN.test(candidate.scope_id)) return undefined;
		return { version: MAPPING_VERSION, code, scope_id: candidate.scope_id.toLowerCase() };
	});
}

/** Publish complete JSON at an unused path. A hard-link makes the fully written inode visible in one
 * step, avoiding the open-before-write window where another Pi could observe an empty reservation. */
function publishJsonExclusive(path: string, value: unknown): boolean {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
		writeFileSync(fd, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
		fsyncSync(fd);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	try {
		linkSync(tempPath, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		try { unlinkSync(tempPath); } catch { /* a crash-equivalent orphan is harmless */ }
	}
}

/** Reserve a code with an atomic exclusive publish; a failed/invalid reservation remains occupied. */
function reserveCode(agentDir: string, code: string, scopeId: string): boolean {
	return publishJsonExclusive(
		joinCodeReservationPath(agentDir, code),
		{ version: MAPPING_VERSION, code, scope_id: scopeId },
	);
}

function mappingState(agentDir: string, code: string): ReadState<Mapping> {
	return readJson(joinCodePath(agentDir, code), parseMapping(code));
}

/** Create a mapping once, preserving a raced/existing path rather than overwriting it. */
function createMapping(agentDir: string, code: string, scopeId: string): boolean {
	return publishJsonExclusive(
		joinCodePath(agentDir, code),
		{ version: MAPPING_VERSION, code, scope_id: scopeId },
	);
}

/** Complete a same-scope reservation that won the race before its mapping was written. */
function recoverReservedCode(agentDir: string, code: string, scopeId: string): boolean {
	const reserved = reservationState(agentDir, code);
	if (reserved.kind !== "valid" || reserved.value.scope_id !== scopeId) return false;
	const existing = mappingState(agentDir, code);
	if (existing.kind === "valid") return existing.value.scope_id === scopeId;
	if (existing.kind !== "missing") return false;
	if (createMapping(agentDir, code, scopeId)) return true;
	const raced = mappingState(agentDir, code);
	return raced.kind === "valid" && raced.value.scope_id === scopeId;
}

/**
 * Allocate (or recover) the persistent alias for a full scope id.
 *
 * Existing files and reservations are never overwritten.  Every collision advances to the next
 * candidate derived from the same scope id, and reservations are retained even if mapping write
 * fails so a code cannot later be recycled for another scope.
 */
export function allocateJoinCode(agentDir: string, scopeId: string, options: { maxAttempts?: number } = {}): string {
	const normalizedScope = normalizeScopeId(scopeId);
	const maxAttempts = options.maxAttempts ?? MAX_JOIN_CODE_ATTEMPTS;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_JOIN_CODE_ATTEMPTS) {
		throw new RangeError(`maxAttempts must be an integer from 1 to ${MAX_JOIN_CODE_ATTEMPTS}`);
	}
	ensureDirectory(codesDirectory(agentDir));
	ensureDirectory(usedDirectory(agentDir));
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const code = candidateJoinCode(normalizedScope, attempt);
		const reservation = reservationState(agentDir, code);
		if (reservation.kind !== "missing") {
			if (recoverReservedCode(agentDir, code, normalizedScope)) return code;
			continue;
		}
		const existing = mappingState(agentDir, code);
		if (existing.kind !== "missing") {
			// Adopt old mappings into the tombstone set before returning or skipping them.
			const reservationScope = existing.kind === "valid" ? existing.value.scope_id : normalizedScope;
			if (!reserveCode(agentDir, code, reservationScope)) {
				if (recoverReservedCode(agentDir, code, normalizedScope)) return code;
				continue;
			}
			if (existing.kind === "valid" && existing.value.scope_id === normalizedScope) return code;
			continue;
		}
		if (!reserveCode(agentDir, code, normalizedScope)) {
			if (recoverReservedCode(agentDir, code, normalizedScope)) return code;
			continue;
		}
		if (recoverReservedCode(agentDir, code, normalizedScope)) return code;
	}
	throw new Error(`unable to allocate an Exocom join code after ${maxAttempts} attempts`);
}

/** Resolve a public alias to its canonical 24-hex scope id; every malformed state fails closed. */
export function resolveJoinCode(agentDir: string, code: unknown): string | undefined {
	if (!isJoinCode(code)) return undefined;
	const state = mappingState(agentDir, code);
	return state.kind === "valid" ? state.value.scope_id : undefined;
}

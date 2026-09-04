/**
 * Workspace work ledger — pure state transitions plus a bounded, locked JSONL store.
 * Chat `message` never mutates it.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { attributePeer } from "../core/fence.ts";
import { findWriteSetOverlaps, writeSetPathError } from "../core/ownership.ts";
import { isSemanticFrame, truncateForInject, type ExocomAsk, type ExocomClaim, type ExocomSemanticFrame } from "./envelope.ts";

export type LedgerEvent = ExocomSemanticFrame;

export interface LedgerClaim {
	work_key: string; from_session: string; from_name: string; write_set: string[]; slice: string; msg_id: string; ts: string;
}
export interface LedgerAsk {
	ask_id: string; work_key: string; from_session: string; from_name: string; to_session: string; question: string; msg_id: string; ts: string;
}
/** Durable answer/decline receipt. `ok: false` is a normal decline outcome. */
export interface LedgerAnswer {
	ask_id: string; work_key: string;
	requester_session: string;
	/** Present on receipts written by this kernel; optional for backwards-compatible callers. */
	requester_name?: string; to_session?: string; question?: string; ask_msg_id?: string; ask_ts?: string;
	from_session: string; from_name?: string; ok: boolean; evidence: string; msg_id: string; ts: string;
}
export interface LedgerState {
	claims: LedgerClaim[];
	asks: LedgerAsk[];
	answers: LedgerAnswer[];
	/** Accepted ask ids, including completed asks, so ids cannot be recycled in this retained ledger window. */
	askIds: string[];
	seen: string[];
}

export type LedgerWake = { kind: "answer"; work_key: string; ask_id: string } | { kind: "release"; work_key: string };
export type ApplyResult =
	| { ok: true; state: LedgerState; duplicate?: true; wake?: LedgerWake }
	| { ok: false; error: string };

/** Explicit in-memory and on-disk bounds. The store fails closed rather than silently dropping a transition. */
export const LEDGER_LIMITS = {
	maxBytes: 1_048_576,
	maxClaims: 128,
	maxAsks: 128,
	maxResults: 256,
	maxAskIds: 4_096,
	maxSeen: 4_096,
	/** Pending asks from one session to another — stops a peer from hostage-taking a constrained turn. */
	maxAsksFromTo: 3,
	lockAttempts: 24,
	lockBackoffMs: 20,
	lockBackoffMaxMs: 80,
	staleLockMs: 120_000,
} as const;

export function emptyLedger(): LedgerState {
	return { claims: [], asks: [], answers: [], askIds: [], seen: [] };
}

function remember(state: LedgerState, msgId: string): LedgerState {
	const seen = state.seen.includes(msgId) ? state.seen : [...state.seen, msgId];
	return { ...state, seen: seen.length > LEDGER_LIMITS.maxSeen ? seen.slice(-LEDGER_LIMITS.maxSeen) : seen };
}
function claimOf(event: ExocomClaim): LedgerClaim {
	return { work_key: event.work_key, from_session: event.from_session, from_name: event.from_name, write_set: [...event.write_set], slice: event.slice, msg_id: event.msg_id, ts: event.ts };
}
function askOf(event: ExocomAsk): LedgerAsk {
	return { ask_id: event.ask_id, work_key: event.work_key, from_session: event.from_session, from_name: event.from_name, to_session: event.to_session, question: event.question, msg_id: event.msg_id, ts: event.ts };
}
function answerOf(event: Extract<LedgerEvent, { kind: "answer" }>, ask: LedgerAsk): LedgerAnswer {
	return {
		ask_id: event.ask_id,
		work_key: event.work_key,
		requester_session: ask.from_session,
		requester_name: ask.from_name,
		to_session: ask.to_session,
		question: ask.question,
		ask_msg_id: ask.msg_id,
		ask_ts: ask.ts,
		from_session: event.from_session,
		from_name: event.from_name,
		ok: event.ok,
		evidence: event.evidence,
		msg_id: event.msg_id,
		ts: event.ts,
	};
}

/** Apply one signed-or-local semantic event. Fail-closed; idempotent on msg_id. */
export function applyLedgerEvent(state: LedgerState, event: LedgerEvent): ApplyResult {
	if (!isSemanticFrame(event)) {
		const raw = event && typeof event === "object"
			? event as Partial<Extract<LedgerEvent, { kind: "claim" }>>
			: undefined;
		if (raw?.kind === "claim" && Array.isArray(raw.write_set) && raw.write_set.length === 0) {
			return { ok: false, error: "claim write_set is empty" };
		}
		return { ok: false, error: "malformed ledger event" };
	}
	if (state.seen.includes(event.msg_id)) return { ok: true, state, duplicate: true };
	switch (event.kind) {
		case "claim": {
			if (state.claims.length >= LEDGER_LIMITS.maxClaims) return { ok: false, error: "ledger claim limit reached" };
			for (const path of event.write_set) {
				const err = writeSetPathError(path);
				if (err) return { ok: false, error: `claim write_set path "${path}" is ${err}` };
			}
			const owners = [...state.claims.map((claim) => ({ agent: claim.from_session, writeSet: claim.write_set })), { agent: event.from_session, writeSet: event.write_set }];
			const overlap = findWriteSetOverlaps(owners)[0];
			if (overlap) {
				const other = state.claims[overlap.firstIndex];
				return { ok: false, error: `claim overlaps open claim by "${other?.from_session ?? "?"}" on "${overlap.firstPath}" / "${overlap.secondPath}"` };
			}
			return { ok: true, state: remember({ ...state, claims: [...state.claims, claimOf(event)] }, event.msg_id) };
		}
		case "ask": {
			if (state.askIds.includes(event.ask_id)) return { ok: false, error: `ask_id "${event.ask_id}" was already used` };
			if (state.askIds.length >= LEDGER_LIMITS.maxAskIds) return { ok: false, error: "ledger ask id history limit reached" };
			if (state.asks.length >= LEDGER_LIMITS.maxAsks) return { ok: false, error: "ledger ask limit reached" };
			if (!event.to_session || event.to_session === "*") return { ok: false, error: "ask to_session is missing" };
			if (event.to_session === event.from_session) return { ok: false, error: "ask to_session cannot be self" };
			const fromTo = state.asks.filter((ask) => ask.from_session === event.from_session && ask.to_session === event.to_session).length;
			if (fromTo >= LEDGER_LIMITS.maxAsksFromTo) return { ok: false, error: `ask limit from "${event.from_session}" to "${event.to_session}" reached` };
			if (state.asks.some((ask) => ask.work_key === event.work_key && ask.to_session === event.to_session)) return { ok: false, error: `ask already pending for (${event.work_key}, ${event.to_session})` };
			return { ok: true, state: remember({ ...state, asks: [...state.asks, askOf(event)], askIds: [...state.askIds, event.ask_id] }, event.msg_id) };
		}
		case "answer": {
			const ask = state.asks.find((candidate) => candidate.ask_id === event.ask_id);
			if (!ask) return { ok: false, error: `answer for unknown ask_id "${event.ask_id}"` };
			if (ask.work_key !== event.work_key) return { ok: false, error: "answer work_key does not match the ask" };
			if (event.from_session !== ask.to_session) return { ok: false, error: "answer from_session is not the ask's to_session" };
			const asks = state.asks.filter((candidate) => candidate.ask_id !== event.ask_id);
			const answers = [...state.answers, answerOf(event, ask)].slice(-LEDGER_LIMITS.maxResults);
			return { ok: true, state: remember({ ...state, asks, answers }, event.msg_id), wake: { kind: "answer", work_key: event.work_key, ask_id: event.ask_id } };
		}
		case "release": {
			const owned = state.claims.filter((claim) => claim.work_key === event.work_key && claim.from_session === event.from_session);
			const outbound = state.asks.filter((ask) => ask.work_key === event.work_key && ask.from_session === event.from_session);
			if (owned.length === 0 && outbound.length === 0) return { ok: false, error: "release: no owned claim or outbound ask on that work_key" };
			const claims = state.claims.filter((claim) => !(claim.work_key === event.work_key && claim.from_session === event.from_session));
			const asks = state.asks.filter((ask) => !(ask.work_key === event.work_key && ask.from_session === event.from_session));
			return { ok: true, state: remember({ ...state, claims, asks }, event.msg_id), wake: { kind: "release", work_key: event.work_key } };
		}
		case "progress": return { ok: true, state: remember(state, event.msg_id) };
	}
}

interface LedgerSnapshot {
	kind: "ledger_snapshot_v1";
	claims: LedgerClaim[];
	asks: LedgerAsk[];
	answers: LedgerAnswer[];
	ask_ids: string[];
	seen: string[];
}

function token(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

/** A snapshot is accepted only by replaying every durable semantic fact through the ordinary reducer. */
function parseSnapshot(raw: unknown): LedgerState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const snapshot = raw as Partial<LedgerSnapshot>;
	if (snapshot.kind !== "ledger_snapshot_v1" || !Array.isArray(snapshot.claims) || !Array.isArray(snapshot.asks)
		|| !Array.isArray(snapshot.answers) || !Array.isArray(snapshot.ask_ids) || !Array.isArray(snapshot.seen)
		|| snapshot.claims.length > LEDGER_LIMITS.maxClaims || snapshot.asks.length > LEDGER_LIMITS.maxAsks
		|| snapshot.answers.length > LEDGER_LIMITS.maxResults || snapshot.ask_ids.length > LEDGER_LIMITS.maxAskIds
		|| snapshot.seen.length > LEDGER_LIMITS.maxSeen || !snapshot.ask_ids.every(token) || !snapshot.seen.every(token)
		|| new Set(snapshot.ask_ids).size !== snapshot.ask_ids.length || new Set(snapshot.seen).size !== snapshot.seen.length) return undefined;
	let state = emptyLedger();
	for (const value of snapshot.answers) {
		if (!value || typeof value !== "object") return undefined;
		const answer = value as LedgerAnswer;
		const reopened: unknown = {
			kind: "ask", ask_id: answer.ask_id, work_key: answer.work_key, from_session: answer.requester_session,
			from_name: answer.requester_name, to_session: answer.to_session, question: answer.question,
			msg_id: answer.ask_msg_id, ts: answer.ask_ts,
		};
		const receipt: unknown = {
			kind: "answer", ask_id: answer.ask_id, work_key: answer.work_key, from_session: answer.from_session,
			from_name: answer.from_name, ok: answer.ok, evidence: answer.evidence, msg_id: answer.msg_id, ts: answer.ts,
		};
		if (!isSemanticFrame(reopened) || reopened.kind !== "ask" || !isSemanticFrame(receipt) || receipt.kind !== "answer") return undefined;
		const opened = applyLedgerEvent(state, reopened);
		if (!opened.ok) return undefined;
		const closed = applyLedgerEvent(opened.state, receipt);
		if (!closed.ok) return undefined;
		state = closed.state;
	}
	for (const value of snapshot.claims) {
		if (!value || typeof value !== "object") return undefined;
		const claim = value as LedgerClaim;
		const frame: unknown = {
			kind: "claim", work_key: claim.work_key, from_session: claim.from_session, from_name: claim.from_name,
			write_set: claim.write_set, slice: claim.slice, msg_id: claim.msg_id, ts: claim.ts,
		};
		if (!isSemanticFrame(frame) || frame.kind !== "claim") return undefined;
		const applied = applyLedgerEvent(state, frame);
		if (!applied.ok) return undefined;
		state = applied.state;
	}
	for (const value of snapshot.asks) {
		if (!value || typeof value !== "object") return undefined;
		const ask = value as LedgerAsk;
		const frame: unknown = {
			kind: "ask", ask_id: ask.ask_id, work_key: ask.work_key, from_session: ask.from_session,
			from_name: ask.from_name, to_session: ask.to_session, question: ask.question, msg_id: ask.msg_id, ts: ask.ts,
		};
		if (!isSemanticFrame(frame) || frame.kind !== "ask") return undefined;
		const applied = applyLedgerEvent(state, frame);
		if (!applied.ok) return undefined;
		state = applied.state;
	}
	const requiredAskIds = new Set(state.askIds);
	if (![...requiredAskIds].every((askId) => snapshot.ask_ids!.includes(askId))) return undefined;
	return { ...state, askIds: [...snapshot.ask_ids], seen: [...snapshot.seen] };
}

function snapshotOf(state: LedgerState): LedgerSnapshot {
	return {
		kind: "ledger_snapshot_v1",
		claims: state.claims,
		asks: state.asks,
		answers: state.answers,
		ask_ids: state.askIds,
		seen: state.seen,
	};
}

/** Reconstruct state from JSONL. Junk events are ignored; a corrupt authoritative snapshot fails closed. */
export function parseLedger(text: string): LedgerState {
	if (Buffer.byteLength(text, "utf8") > LEDGER_LIMITS.maxBytes) throw new Error("ledger exceeds bounded size");
	let state = emptyLedger();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let raw: unknown;
		try { raw = JSON.parse(trimmed); }
		catch { continue; }
		if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "ledger_snapshot_v1") {
			const restored = parseSnapshot(raw);
			if (!restored) throw new Error("malformed ledger snapshot");
			state = restored;
			continue;
		}
		if (!isSemanticFrame(raw)) continue;
		const result = applyLedgerEvent(state, raw);
		if (result.ok) state = result.state;
	}
	return state;
}

export function pendingAsksTo(state: LedgerState, sessionId: string): LedgerAsk[] {
	return state.asks.filter((ask) => ask.to_session === sessionId);
}
/** Return the retained terminal receipt for an ask, including declines. */
export function answerFor(state: LedgerState, askId: string, requesterSession?: string): LedgerAnswer | undefined {
	return state.answers.find((answer) => answer.ask_id === askId && (requesterSession === undefined || answer.requester_session === requesterSession));
}

export interface LedgerPruneOptions { now: number; ttlMs: number; liveSessions: ReadonlySet<string>; }
function isFresh(ts: string, now: number, ttlMs: number): boolean {
	const at = Date.parse(ts);
	return Number.isFinite(at) && now - at <= ttlMs;
}
/** Pure stale-state reconciliation for a future registry/heartbeat integration layer. */
export function pruneLedger(state: LedgerState, options: LedgerPruneOptions): LedgerState {
	const now = Number.isFinite(options.now) ? options.now : 0;
	const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 0;
	// The registry heartbeat is the ownership lease. Event age must not evict a healthy long-running
	// claim or question; only retained terminal receipts use a storage TTL.
	const claims = state.claims.filter((claim) => options.liveSessions.has(claim.from_session));
	const asks = state.asks.filter((ask) => options.liveSessions.has(ask.from_session) && options.liveSessions.has(ask.to_session));
	const answers = state.answers.filter((answer) => isFresh(answer.ts, now, ttlMs)).slice(-LEDGER_LIMITS.maxResults);
	const askIds = [...new Set([...asks.map((ask) => ask.ask_id), ...answers.map((answer) => answer.ask_id)])];
	return { ...state, claims, asks, answers, askIds };
}

// `question` is capped at 4,096 UTF-16 code units on the wire. Three UTF-8 bytes per
// code unit covers its worst valid encoding, so the one ask we expose remains complete.
const PENDING_ASK_QUESTION_MAX_BYTES = 12_288;

/** Short machine-readable pending-ask block. Shows one resolvable ask at a time so a peer cannot consume a turn. */
export function pendingAskBlock(
	asks: readonly LedgerAsk[],
	resolvePeerName: (sessionId: string) => string | undefined = (sessionId) => sessionId,
): string | undefined {
	if (asks.length === 0) return undefined;
	const ask = asks[0]!;
	const lines = ["[exocom-pending-ask]"];
	lines.push(`ask_id=${ask.ask_id} work_key=${ask.work_key} from_session=${ask.from_session}`);
	lines.push(attributePeer(resolvePeerName(ask.from_session) ?? ask.from_session, truncateForInject(ask.question, PENDING_ASK_QUESTION_MAX_BYTES).text));
	if (asks.length > 1) lines.push(`omitted=${asks.length - 1}`);
	lines.push("[/exocom-pending-ask]");
	return lines.join("\n");
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
type LedgerWriter = (fd: number, payload: Buffer, offset: number, length: number) => number;

function writeAllSync(fd: number, payload: Buffer, writer: LedgerWriter = writeSync): void {
	let offset = 0;
	while (offset < payload.length) {
		const written = writer(fd, payload, offset, payload.length - offset);
		if (written <= 0) throw new Error("ledger short write");
		offset += written;
	}
}
function unsafe(path: string): Error { return new Error(`ledger unsafe file: ${path}`); }
function assertSafeStat(path: string, stat: { isFile(): boolean; nlink: number }): void {
	if (!stat.isFile() || stat.nlink > 1) throw unsafe(path);
}
function noFollowFlag(): number { return constants.O_NOFOLLOW ?? 0; }

/** Open a ledger only after link/inode checks; returns undefined for a genuinely absent file. */
function openLedger(path: string, append: boolean): number | undefined {
	let before: ReturnType<typeof lstatSync>;
	try { before = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!append) return undefined;
		const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
		try { assertSafeStat(path, fstatSync(fd)); return fd; } catch (err) { closeSync(fd); throw err; }
	}
	if (before.isSymbolicLink()) throw unsafe(path);
	assertSafeStat(path, before);
	const fd = openSync(path, constants.O_RDWR | (append ? constants.O_APPEND : 0) | noFollowFlag());
	try {
		const opened = fstatSync(fd);
		assertSafeStat(path, opened);
		if (opened.dev !== before.dev || opened.ino !== before.ino) throw unsafe(path);
		return fd;
	} catch (err) { closeSync(fd); throw err; }
}

function backoffMs(attempt: number): number {
	return Math.min(LEDGER_LIMITS.lockBackoffMs * attempt, LEDGER_LIMITS.lockBackoffMaxMs);
}

/** Same liveness probe the registry uses: ESRCH is dead, EPERM is a live process we cannot signal. */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function lockOwnerPid(lock: string): number | undefined {
	try {
		const first = readFileSync(lock, "utf8").trim().split(/\s+/)[0];
		const pid = Number(first);
		if (Number.isInteger(pid) && pid > 0) return pid;
	} catch { /* unreadable lock is pid-unknown */ }
	return undefined;
}

function sharingViolation(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EAGAIN";
}

/** Release only while the sidecar still carries our token — inode is 0 on Windows, so path+payload is the identity. */
function releaseLockFile(lock: string, payload: string, held: { dev: number; ino: number }): void {
	try {
		const current = lstatSync(lock);
		if (current.isSymbolicLink() || !current.isFile() || current.nlink > 1) return;
		if (held.ino !== 0 && (current.dev !== held.dev || current.ino !== held.ino)) return;
		if (readFileSync(lock, "utf8") !== payload) return;
		unlinkSync(lock);
	} catch { /* successor already replaced this sidecar */ }
}

/** A short `wx` sidecar lock serializes transactions on POSIX and Windows.
 * Live owners are never stolen from mtime alone; a dead pid is reclaimed immediately; release is token-checked. */
function acquireLedgerLock(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	for (let attempt = 1; attempt <= LEDGER_LIMITS.lockAttempts; attempt++) {
		try {
			const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
			const payload = `${process.pid} ${randomUUID()}\n`;
			try {
				writeSync(fd, payload, null, "utf8");
				fsyncSync(fd);
				const held = fstatSync(fd);
				assertSafeStat(lock, held);
				return () => { try { closeSync(fd); } finally { releaseLockFile(lock, payload, held); } };
			} catch (error) {
				closeSync(fd); try { unlinkSync(lock); } catch { /* best-effort cleanup */ } throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let steal = false;
			try {
				const held = lstatSync(lock);
				if (held.isSymbolicLink() || !held.isFile() || held.nlink > 1) throw unsafe(lock);
				const pid = lockOwnerPid(lock);
				if (pid !== undefined && pid !== process.pid && pidAlive(pid)) steal = false;
				else if (pid !== undefined && (pid === process.pid || !pidAlive(pid))) steal = true;
				else steal = Date.now() - held.mtimeMs > LEDGER_LIMITS.staleLockMs;
				if (steal) unlinkSync(lock);
			} catch (lockError) {
				if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw lockError;
			}
			if (steal) continue;
			if (attempt < LEDGER_LIMITS.lockAttempts) sleepSync(backoffMs(attempt));
		}
	}
	throw new Error(`ledger lock unavailable: ${lock}`);
}

/** Strict read: absent is empty; linked, oversized, or unreadable files fail closed.
 * Sharing violations (Windows rename vs reader) retry; a corrupt snapshot still fails closed. */
export function loadLedger(path: string): LedgerState {
	let last: unknown;
	for (let attempt = 1; attempt <= LEDGER_LIMITS.lockAttempts; attempt++) {
		try {
			const fd = openLedger(path, false);
			if (fd === undefined) return emptyLedger();
			try {
				if (fstatSync(fd).size > LEDGER_LIMITS.maxBytes) throw new Error("ledger exceeds bounded size");
				return parseLedger(readFileSync(fd, "utf8"));
			} finally { closeSync(fd); }
		} catch (error) {
			last = error;
			if (attempt < LEDGER_LIMITS.lockAttempts && sharingViolation(error)) {
				sleepSync(backoffMs(attempt));
				continue;
			}
			throw error;
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function appendLocked(path: string, event: LedgerEvent, io?: LedgerFileIO): void {
	const payload = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
	const fd = openLedger(path, true);
	if (fd === undefined) throw new Error("ledger unavailable");
	let originalSize: number | undefined;
	let originalIdentity: { dev: number; ino: number } | undefined;
	try {
		const original = fstatSync(fd);
		originalSize = original.size;
		originalIdentity = { dev: original.dev, ino: original.ino };
		if (originalSize + payload.length > LEDGER_LIMITS.maxBytes) throw new Error("ledger bounded size reached");
		writeAllSync(fd, payload, io?.write);
		fsyncSync(fd);
	} catch (error) {
		try {
			if (originalSize !== undefined && originalIdentity !== undefined) {
				// Windows cannot reliably truncate the O_APPEND descriptor. Reopen with the normal
				// safety checks, then additionally prove it is still the exact file we appended to.
				const rollbackFd = openLedger(path, false);
				if (rollbackFd === undefined) throw new Error("ledger disappeared during append rollback");
				try {
					const current = fstatSync(rollbackFd);
					if (current.dev !== originalIdentity.dev || current.ino !== originalIdentity.ino) {
						throw new Error("ledger changed during append rollback");
					}
					ftruncateSync(rollbackFd, originalSize);
					fsyncSync(rollbackFd);
				} finally { closeSync(rollbackFd); }
			}
		} catch { /* retained below after the original append failure */ }
		throw error;
	} finally { closeSync(fd); }
}

/** A writer may have died after writing only part of its newline-terminated record.
 * With the transaction lock held, repair that tail before the next commit. Returns the size
 * observed before repair so a transaction still compacts history it had to trim. */
function recoverIncompleteTrailingRecordLocked(path: string): number {
	const fd = openLedger(path, false);
	if (fd === undefined) return 0;
	try {
		const size = fstatSync(fd).size;
		if (size === 0) return 0;
		if (size > LEDGER_LIMITS.maxBytes) throw new Error("ledger exceeds bounded size");
		const content = readFileSync(fd);
		if (content[content.length - 1] === 0x0a) return size;
		const lastNewline = content.lastIndexOf(0x0a);
		const tail = content.subarray(lastNewline + 1);
		if (tail.toString("utf8").trim().length === 0) {
			ftruncateSync(fd, lastNewline + 1);
			fsyncSync(fd);
			return size;
		}
		try {
			JSON.parse(tail.toString("utf8"));
			// The record itself is complete and only its terminator was lost. Preserve it and
			// restore the delimiter before any O_APPEND writer can concatenate the next record.
			// At the hard size ceiling, leave it byte-identical: commitLedgerEvent uses the
			// returned pre-repair size to compact it before another append.
			if (size < LEDGER_LIMITS.maxBytes) {
				writeSync(fd, Buffer.from("\n"), 0, 1, size);
				fsyncSync(fd);
			}
			return size;
		} catch { /* handled below */ }
		// Every record this writer emits starts with `{`. Unknown garbage must fail closed:
		// appending to it could return success while making the new event unreplayable.
		if (tail[0] !== 0x7b) throw new Error("ledger has an unknown unterminated tail");
		ftruncateSync(fd, lastNewline + 1);
		fsyncSync(fd);
		return size;
	} finally { closeSync(fd); }
}

function fileSizeLocked(path: string): number {
	const fd = openLedger(path, false);
	if (fd === undefined) return 0;
	try { return fstatSync(fd).size; } finally { closeSync(fd); }
}

/** Write a complete compact snapshot to a same-directory temp and atomically replace the journal.
 * There is deliberately no in-place fallback: on a Windows sharing violation the original journal
 * remains authoritative and the caller receives a NACK instead of a torn file. */
function replaceWithSnapshotLocked(path: string, state: LedgerState, io?: LedgerFileIO): void {
	const payload = Buffer.from(`${JSON.stringify(snapshotOf(state))}\n`, "utf8");
	if (payload.length > LEDGER_LIMITS.maxBytes) throw new Error("ledger compact snapshot exceeds bounded size");
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
		writeAllSync(fd, payload, io?.write);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		for (let attempt = 1; ; attempt++) {
			try {
				(io?.rename ?? renameSync)(tmp, path);
				return;
			} catch (error) {
				if (attempt < LEDGER_LIMITS.lockAttempts && sharingViolation(error)) {
					sleepSync(backoffMs(attempt));
					continue;
				}
				throw error;
			}
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(tmp); } catch { /* successful rename already consumed it */ }
	}
}
/** Strict append for callers that already have a validated event but no state transition. */
export function appendLedgerEvent(path: string, event: LedgerEvent): void {
	if (!isSemanticFrame(event)) throw new Error("malformed ledger event");
	const release = acquireLedgerLock(path);
	try {
		recoverIncompleteTrailingRecordLocked(path);
		appendLocked(path, event);
	} finally { release(); }
}
/** Atomic cross-process read/apply/append transaction. I/O failures become an explicit NACK. */
export interface LedgerCommitOptions {
	/** Applied under the same transaction lock before validating the new event. */
	prune?: LedgerPruneOptions;
	/** Test/operations override; defaults to half the maximum journal size. */
	compactAtBytes?: number;
	/** Fault-injection seam for short-write and Windows replacement regression tests. */
	io?: LedgerFileIO;
}

export interface LedgerFileIO {
	write?: LedgerWriter;
	rename?: (from: string, to: string) => void;
}

function pruningChanged(before: LedgerState, after: LedgerState): boolean {
	return before.claims.length !== after.claims.length || before.asks.length !== after.asks.length
		|| before.answers.length !== after.answers.length || before.askIds.length !== after.askIds.length;
}

export function commitLedgerEvent(path: string, event: LedgerEvent, options: LedgerCommitOptions = {}): ApplyResult {
	let release: (() => void) | undefined;
	try {
		release = acquireLedgerLock(path);
		const sizeBeforeRecovery = recoverIncompleteTrailingRecordLocked(path);
		const loaded = loadLedger(path);
		const pruned = options.prune ? pruneLedger(loaded, options.prune) : loaded;
		const result = applyLedgerEvent(pruned, event);
		const compactAt = Number.isFinite(options.compactAtBytes) && options.compactAtBytes !== undefined
			? Math.max(1, Math.floor(options.compactAtBytes)) : Math.floor(LEDGER_LIMITS.maxBytes / 2);
		const eventBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
		const mustCompact = pruningChanged(loaded, pruned)
			|| (result.ok && result.duplicate !== true && Math.max(sizeBeforeRecovery, fileSizeLocked(path)) + eventBytes >= compactAt);
		if (mustCompact) replaceWithSnapshotLocked(path, result.ok ? result.state : pruned, options.io);
		else if (result.ok && result.duplicate !== true) appendLocked(path, event, options.io);
		return result;
	} catch (error) {
		return { ok: false, error: `ledger transaction failed: ${error instanceof Error ? error.message : String(error)}` };
	} finally { release?.(); }
}

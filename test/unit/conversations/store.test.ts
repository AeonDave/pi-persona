import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONVERSATION_ENTRY, CONVERSATION_MAX_FILE_BYTES, CONVERSATION_MAX_LINEAGES, CONVERSATION_RETENTION_MS, ConversationStore } from "../../../src/conversations/store.ts";

test("conversation leases persist, reject concurrent and stale continuations, and honor branches", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-"));
	try {
		const entries: unknown[] = [];
		const options = { sessionId: "session-a", sessionFile: join(dir, "parent.jsonl"), entries: () => entries,
			append: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
		const first = new ConversationStore(options);
		const leaseResult = first.create();
		assert.equal(leaseResult.ok, true);
		if (!leaseResult.ok) return;
		const lease = leaseResult.value;
		writeFileSync(lease.file, "{\"type\":\"session\"}\n");
		const saved = lease.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "a".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" });
		assert.equal(saved.ok, true);
		const second = new ConversationStore(options);
		assert.equal(second.acquire("run-1").ok, false);
		assert.equal(second.listAll()[0]?.reason, "busy");
		assert.deepEqual(second.list(), []);
		lease.release();
		const resumed = second.acquire("run-1");
		assert.equal(resumed.ok, true);
		if (!resumed.ok) return;
		assert.equal(resumed.value.lease.commit({ ...saved.value, runId: "run-2", previousRunId: "run-1" }).ok, true);
		resumed.value.lease.release();
		assert.equal(first.acquire("run-1").ok, false);
		assert.equal(first.acquire("run-2", entries.slice(0, 1)).ok, false);
		assert.deepEqual(first.list(entries.slice(0, 1)), []);
		assert.equal(first.list().at(0)?.runId, "run-2");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a verifiably stale lock remains visible as resumable without a listing mutation", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-stale-lock-"));
	try {
		const entries: unknown[] = [];
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: (customType, data) => { entries.push({ type: "custom", customType, data }); } });
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "saved");
		assert.ok(created.value.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "a".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" }).ok);
		created.value.release();
		const lock = created.value.file.replace(/\.jsonl$/, ".lock");
		writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "stale" }));
		assert.equal(store.listAll()[0]?.available, true);
		assert.equal(existsSync(lock), true, "listing never removes a lock");
		const acquired = store.acquire("run-1");
		assert.ok(acquired.ok);
		acquired.value.lease.release();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two stale-lock reclaimers cannot both admit a transcript writer", () => {
	const h = storeFixture("persona-conversation-reclaim-race-");
	try {
		const saved = h.commit();
		const path = saved.file.replace(/\.jsonl$/, ".lock");
		writeFileSync(path, DEAD);
		const original = fs.unlinkSync;
		let contender: ReturnType<ConversationStore["acquire"]> | undefined;
		let injected = false;
		fs.unlinkSync = ((candidate: PathLike) => {
			if (!injected && String(candidate) === path) {
				injected = true;
				contender = h.store.acquire(saved.runId);
			}
			original(candidate);
		}) as typeof original;
		syncBuiltinESMExports();
		try {
			const first = h.store.acquire(saved.runId);
			assert.equal(injected, true, "the competing admission ran immediately before stale lock removal");
			assert.equal(Number(first.ok) + Number(contender?.ok), 1, "exactly one writer may own the transcript");
			assert.equal(h.store.acquire(saved.runId).ok, false, "the winning lease must still exclude a third writer");
			if (first.ok) first.value.lease.release();
			if (contender?.ok) contender.value.lease.release();
			assert.equal(h.store.listAll()[0]?.available, true);
		} finally { fs.unlinkSync = original; syncBuiltinESMExports(); }
	} finally { h.close(); }
});

test("failed post-lock continuation validation releases its lease without deleting the saved transcript", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-admission-error-"));
	try {
		const entries: unknown[] = [];
		let failAfterLock = false;
		let file: string;
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"),
			entries: () => {
				if (failAfterLock && existsSync(file.replace(/\.jsonl$/, ".lock"))) throw new Error("history temporarily unavailable");
				return entries;
			},
			append: (customType, data) => { entries.push({ type: "custom", customType, data }); } });
		const created = store.create();
		assert.ok(created.ok);
		file = created.value.file;
		writeFileSync(file, "saved transcript");
		assert.ok(created.value.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "a".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" }).ok);
		created.value.release();
		failAfterLock = true;
		const rejected = store.acquire("run-1");
		assert.equal(rejected.ok, false);
		assert.equal(existsSync(file.replace(/\.jsonl$/, ".lock")), false, "no writer was admitted, so the failed admission must release its lease");
		assert.equal(existsSync(file), true, "saved transcripts remain available for another admission");
		failAfterLock = false;
		const resumed = store.acquire("run-1");
		assert.ok(resumed.ok);
		resumed.value.lease.release();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sessionless storage and invalid model metadata fail closed", () => {
	const store = new ConversationStore({ sessionId: "s", sessionFile: undefined, entries: () => [], append: () => {} });
	assert.equal(store.create().ok, false);
});

test("releasing an unindexed fresh attempt removes its transcript and frees its quota", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-failed-"));
	try {
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => [], append: () => { throw new Error("disk full"); } });
		for (let i = 0; i < 65; i++) {
			const created = store.create();
			assert.ok(created.ok);
			writeFileSync(created.value.file, "failed transcript");
			assert.equal(created.value.commit({ rootRunId: `run-${i}`, runId: `run-${i}`, cwd: dir, persona: null,
				fingerprint: "a".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" }).ok, false);
			created.value.release();
			assert.equal(existsSync(created.value.file), false);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function storeFixture(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	// Reclaim confirms an unindexed key against the session file, which Pi has written by the first turn.
	writeFileSync(join(dir, "parent"), SESSION_HEADER);
	const entries: unknown[] = [];
	let now = 1_000;
	let corrupt = false;
	const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), now: () => now,
		entries: () => corrupt ? [...entries, { type: "custom", customType: CONVERSATION_ENTRY, data: { owner: (entries[0] as { data: { owner: string } }).data.owner } }] : entries,
		append: (customType, data) => { entries.push({ type: "custom", customType, data }); } });
	let runs = 0;
	const commit = (worktree?: { path: string; root: string; baseCommit: string }) => {
		const created = store.create();
		assert.ok(created.ok, created.ok ? "" : created.error);
		writeFileSync(created.value.file, "saved");
		const runId = `run-${++runs}`;
		assert.ok(created.value.commit({ rootRunId: runId, runId, cwd: dir, persona: null, fingerprint: "a".repeat(64),
			spec: { agent: "scout", task: "inspect" }, model: "provider/model", ...(worktree ? { worktree } : {}) }).ok);
		created.value.release();
		return { file: created.value.file, runId };
	};
	const orphan = (owner: string | undefined) => {
		const key = randomUUID();
		const file = join(dir, "persona-workers", workerDirName(dir), `${key}.jsonl`);
		writeFileSync(file, "orphaned transcript");
		if (owner !== undefined) writeFileSync(file.replace(/\.jsonl$/, ".lock"), owner);
		return file;
	};
	return { dir, store, commit, orphan, advance: (ms: number) => { now += ms; }, corrupt: (value: boolean) => { corrupt = value; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function workerDirName(dir: string): string {
	return readdirSync(join(dir, "persona-workers"))[0]!;
}
const DEAD = JSON.stringify({ pid: 2147483647, token: "dead" });
const SESSION_HEADER = '{"type":"session","id":"owner"}\n';

test("releasing a fresh uncommitted lease does not read session history", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-stale-ctx-"));
	try {
		let stale = false;
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"),
			entries: () => { if (stale) throw new Error("This extension ctx is stale"); return []; }, append: () => {} });
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "aborted transcript");
		stale = true;
		created.value.release();
		assert.equal(existsSync(created.value.file), false);
		assert.equal(existsSync(created.value.file.replace(/\.jsonl$/, ".lock")), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("admission reclaims a dead-owner orphan at the lineage ceiling and never touches live, unknown or indexed files", () => {
	const h = storeFixture("persona-conversation-reclaim-");
	try {
		const saved = h.commit();
		const live = h.orphan(JSON.stringify({ pid: process.pid, token: "live" }));
		const malformed = h.orphan("{not json");
		const dead = h.orphan(DEAD);
		const deadLockOnly = h.orphan(DEAD);
		unlinkSync(deadLockOnly);
		h.corrupt(true);
		const blocked = h.store.create();
		assert.ok(blocked.ok, "quota headroom: only reclaim's own guard decides whether the orphan survives");
		blocked.value.release();
		assert.equal(existsSync(dead), true, "corrupt history deletes nothing");
		h.corrupt(false);
		for (let i = 1; i < CONVERSATION_MAX_LINEAGES - 3; i++) h.commit();
		const admitted = h.store.create();
		assert.ok(admitted.ok, admitted.ok ? "" : admitted.error);
		admitted.value.release();
		assert.equal(existsSync(dead), false);
		assert.equal(existsSync(dead.replace(/\.jsonl$/, ".lock")), false);
		assert.equal(existsSync(deadLockOnly.replace(/\.jsonl$/, ".lock")), false);
		for (const kept of [live, malformed, saved.file]) assert.equal(existsSync(kept), true, `${kept} must survive`);
		assert.equal(existsSync(live.replace(/\.jsonl$/, ".lock")), true);
		assert.ok(h.store.acquire(saved.runId).ok);
	} finally { h.close(); }
});

test("reclaim keeps an unindexed transcript that the session file mentions or cannot confirm absent", () => {
	const h = storeFixture("persona-conversation-stale-view-");
	try {
		h.commit();
		const other = h.orphan(undefined);
		const key = /([0-9a-f-]{36})\.jsonl$/.exec(other)![1]!;
		const admit = () => { const r = h.store.create(); assert.ok(r.ok, r.ok ? "" : r.error); r.value.release(); };
		writeFileSync(join(h.dir, "parent"), `${SESSION_HEADER}{"type":"custom","data":{"key":"${key}"}}\n`);
		admit();
		assert.equal(existsSync(other), true, "another process committed it, so this stale view must not delete it");
		unlinkSync(join(h.dir, "parent"));
		admit();
		assert.equal(existsSync(other), true, "an unreadable session file fails closed");
		writeFileSync(join(h.dir, "parent"), SESSION_HEADER);
		admit();
		assert.equal(existsSync(other), false, "confirmed absent from the session file");
	} finally { h.close(); }
});

test("a dead supervisor with an unpublished child PID leaves the writer lease fenced", () => {
	const h = storeFixture("persona-conversation-launching-writer-");
	try {
		h.commit();
		const file = h.orphan(JSON.stringify({ ...JSON.parse(DEAD), externalWriter: "launching" }));
		const hold = h.store.create();
		assert.ok(hold.ok);
		hold.value.release();
		assert.equal(existsSync(file), true, "launcher crash does not establish child quiescence");
		writeFileSync(file.replace(/\.jsonl$/, ".lock"), JSON.stringify({ ...JSON.parse(DEAD), externalWriter: 2147483647 }));
		const reclaim = h.store.create();
		assert.ok(reclaim.ok);
		reclaim.value.release();
		assert.equal(existsSync(file), false, "both PIDs are now known dead");
	} finally { h.close(); }
});

test("reclaim continues past a transcript that cannot be unlinked, frees its lock and retries it next admission", () => {
	const h = storeFixture("persona-conversation-unlink-fail-");
	try {
		h.commit();
		const stuck = h.orphan(DEAD), removable = h.orphan(DEAD);
		const realUnlink = fs.unlinkSync;
		let failing = true;
		fs.unlinkSync = ((path: PathLike) => {
			if (failing && String(path) === stuck) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
			return realUnlink(path);
		}) as typeof fs.unlinkSync;
		syncBuiltinESMExports();
		try {
			const first = h.store.create();
			assert.ok(first.ok, first.ok ? "" : first.error);
			first.value.release();
			assert.equal(existsSync(removable), false, "the sweep continues past the failure");
			assert.equal(existsSync(stuck), true);
			assert.equal(existsSync(stuck.replace(/\.jsonl$/, ".lock")), false, "the failed key's lock is released");
			failing = false;
			const second = h.store.create();
			assert.ok(second.ok, second.ok ? "" : second.error);
			second.value.release();
			assert.equal(existsSync(stuck), false, "the next admission retries it");
		} finally { fs.unlinkSync = realUnlink; syncBuiltinESMExports(); }
	} finally { h.close(); }
});

test("admission reclaims an expired transcript without a worktree and keeps a worktree-bearing one", async () => {
	const h = storeFixture("persona-conversation-expired-");
	try {
		const plain = h.commit();
		const retained = h.commit({ path: join(h.dir, "worktree"), root: h.dir, baseCommit: "a".repeat(40) });
		h.advance(CONVERSATION_RETENTION_MS + 1);
		const admitted = h.store.create();
		assert.ok(admitted.ok);
		admitted.value.release();
		assert.equal(existsSync(plain.file), false);
		assert.equal(existsSync(retained.file), true);
		assert.deepEqual(h.store.listAll().map((item) => item.reason), ["expired", "expired"]);
		assert.equal((await h.store.forget(plain.runId)).ok, true);
	} finally { h.close(); }
});

test("invalid metadata and oversized transcript cannot be advertised", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-"));
	try {
		const entries: unknown[] = [];
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: (customType, data) => { entries.push({ type: "custom", customType, data }); } });
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "x");
		const input = { rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "b".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "not-qualified" };
		assert.equal(created.value.commit(input).ok, false);
		truncateSync(created.value.file, CONVERSATION_MAX_FILE_BYTES + 1);
		assert.equal(created.value.commit({ ...input, model: "provider/model" }).ok, false);
		assert.deepEqual(store.list(), []);
		created.value.release();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a transcript changed by a failed turn cannot resume from an old receipt", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-"));
	try {
		const entries: unknown[] = [];
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: (customType, data) => { entries.push({ type: "custom", customType, data }); } });
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "settled");
		assert.ok(created.value.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "c".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" }).ok);
		created.value.release();
		const resumed = store.acquire("run-1");
		assert.ok(resumed.ok);
		writeFileSync(resumed.value.lease.file, "interrupted");
		resumed.value.lease.release();
		assert.equal(store.acquire("run-1").ok, false);
		assert.deepEqual(store.list(), []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt history, a different owner, and expiry fail closed", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-"));
	try {
		let now = 1_000;
		const entries: unknown[] = [];
		const options = { sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); }, now: () => now };
		const store = new ConversationStore(options);
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "settled");
		assert.ok(created.value.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "d".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model" }).ok);
		created.value.release();
		assert.equal(new ConversationStore({ ...options, sessionId: "other" }).acquire("run-1").ok, false);
		now += 8 * 24 * 60 * 60 * 1000;
		assert.equal(store.acquire("run-1").ok, false);
		now = 1_000;
		entries.push({ type: "custom", customType: "pi-persona:conversation:v1", data: { owner: "bad" } });
		// Foreign-owner records are ignored; a malformed owning record must block all lookup.
		const saved = entries[0] as { data: { owner: string } };
		entries.push({ type: "custom", customType: "pi-persona:conversation:v1", data: { owner: saved.data.owner } });
		assert.equal(store.acquire("run-1").ok, false);
		assert.deepEqual(store.list(), []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit forget checks branch, lock and worktree cleanup before deleting a transcript", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-forget-"));
	try {
		const entries: unknown[] = [];
		let cleanupWorks = false;
		let now = 1_000;
		const store = new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: (customType, data) => { entries.push({ type: "custom", customType, data }); }, now: () => now,
			removeWorktree: async () => cleanupWorks ? { ok: true } : { ok: false, error: "cannot remove" } });
		const created = store.create();
		assert.ok(created.ok);
		writeFileSync(created.value.file, "settled");
		assert.ok(created.value.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "d".repeat(64), spec: { agent: "scout", task: "inspect" }, model: "provider/model",
			worktree: { path: join(dir, "worktree"), root: dir, baseCommit: "a".repeat(40) } }).ok);
		assert.equal((await store.forget("run-1")).ok, false);
		created.value.release();
		assert.equal((await new ConversationStore({ sessionId: "owner", sessionFile: join(dir, "parent"), entries: () => entries,
			append: () => {} }).forget("run-1")).ok, false);
		assert.equal((await store.forget("run-1", [])).ok, false);
		assert.equal((await store.forget("run-1")).ok, false);
		const acquired = store.acquire("run-1");
		assert.ok(acquired.ok);
		acquired.value.lease.release();
		now += 8 * 24 * 60 * 60 * 1000;
		assert.equal(store.listAll()[0]?.reason, "expired");
		cleanupWorks = true;
		assert.equal((await store.forget("run-1")).ok, true);
		assert.equal(store.acquire("run-1").ok, false);
		assert.deepEqual(store.listAll(), []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

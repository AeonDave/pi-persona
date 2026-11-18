import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONVERSATION_MAX_FILE_BYTES, ConversationStore } from "../../../src/conversations/store.ts";

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

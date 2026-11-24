import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CONVERSATION_RETENTION_MS, ConversationStore } from "../../src/conversations/store.ts";
import type { ConversationCommit, ConversationLease } from "../../src/conversations/types.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "persona-concurrent-worker-"));
	const first = SessionManager.create(dir, dir);
	first.appendMessage({ role: "user", content: "start", timestamp: 1 });
	const file = first.getSessionFile()!;
	let now = 10_000;
	let removals = 0;
	const makeStore = (manager: SessionManager, throwAfterAppend = false) => new ConversationStore({
		sessionFile: file,
		sessionId: manager.getSessionId(),
		now: () => now,
		entries: () => manager.getEntries(),
		append: (type, data) => {
			manager.appendCustomEntry(type, data);
			if (throwAfterAppend) throw new Error("interrupted after append");
		},
		removeWorktree: async () => { removals++; return { ok: true }; },
	});
	const commit = (lease: ConversationLease, runId: string, extra: Partial<ConversationCommit> = {}) =>
		lease.commit({ rootRunId: runId, runId, cwd: dir, persona: null, fingerprint: "a".repeat(64),
			spec: { agent: "scout", task: "inspect" }, model: "provider/model", ...extra });
	return {
		dir, file, first, makeStore, commit,
		advance: (ms: number) => { now += ms; },
		removals: () => removals,
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function newConversation(store: ConversationStore): ConversationLease {
	const created = store.create();
	assert.ok(created.ok, created.ok ? undefined : created.error);
	writeFileSync(created.value.file, "worker transcript\n");
	return created.value;
}

test("admission cannot prune an expired local snapshot when another native supervisor just saved a newer turn", () => {
	const h = fixture();
	try {
		const first = h.makeStore(h.first);
		const lease = newConversation(first);
		assert.ok(h.commit(lease, "run-1").ok);
		lease.release();

		const secondManager = SessionManager.open(h.file);
		const second = h.makeStore(secondManager);
		h.advance(CONVERSATION_RETENTION_MS - 1);
		const continuation = second.acquire("run-1", secondManager.getBranch());
		assert.ok(continuation.ok);
		writeFileSync(lease.file, "continued transcript\n");
		assert.ok(h.commit(continuation.value.lease, "run-2", { rootRunId: "run-1", previousRunId: "run-1" }).ok);
		continuation.value.lease.release();
		h.advance(2);

		const admitted = first.create();
		assert.ok(admitted.ok, admitted.ok ? undefined : admitted.error);
		admitted.value.release();
		assert.equal(existsSync(lease.file), true, "the stale supervisor must preserve the newer turn's transcript");
		assert.equal(second.list(secondManager.getBranch())[0]?.runId, "run-2");
	} finally { h.close(); }
});

test("forget checks the native ledger under the lease before deleting a stale turn's retained worktree", async () => {
	const h = fixture();
	try {
		const first = h.makeStore(h.first);
		const lease = newConversation(first);
		const worktree = { path: join(h.dir, "worktree"), root: h.dir, baseCommit: "a".repeat(40) };
		assert.ok(h.commit(lease, "run-1", { worktree }).ok);
		lease.release();
		const secondManager = SessionManager.open(h.file);
		const second = h.makeStore(secondManager);
		const continuation = second.acquire("run-1", secondManager.getBranch());
		assert.ok(continuation.ok);
		writeFileSync(lease.file, "continued in worktree\n");
		assert.ok(h.commit(continuation.value.lease, "run-2", { rootRunId: "run-1", previousRunId: "run-1", worktree }).ok);
		continuation.value.lease.release();

		const forgotten = await first.forget("run-1", h.first.getBranch());
		assert.equal(forgotten.ok ? "removed" : forgotten.code, "stale");
		assert.equal(h.removals(), 0, "no call to worktree removal for an outdated receipt");
		assert.equal(existsSync(lease.file), true);
		assert.equal(second.list(secondManager.getBranch())[0]?.runId, "run-2");
	} finally { h.close(); }
});

test("a native append that commits before throwing cannot make release delete the indexed transcript", () => {
	const h = fixture();
	try {
		const lease = newConversation(h.makeStore(h.first, true));
		assert.equal(h.commit(lease, "run-1").ok, false);
		lease.release();

		const reopened = SessionManager.open(h.file);
		const resumed = h.makeStore(reopened).acquire("run-1", reopened.getBranch());
		assert.ok(resumed.ok, resumed.ok ? undefined : resumed.error);
		resumed.value.lease.release();
	} finally { h.close(); }
});

test("two native supervisors cannot record different lineages under one run id", () => {
	const h = fixture();
	try {
		const first = h.makeStore(h.first);
		const other = h.makeStore(SessionManager.open(h.file));
		const a = newConversation(first);
		const b = newConversation(other);
		assert.ok(h.commit(a, "run-1").ok);
		a.release();
		const result = h.commit(b, "run-1");
		b.release();
		assert.equal(result.ok ? "saved" : result.code, "conflict");
		const reopened = SessionManager.open(h.file);
		const available = h.makeStore(reopened).listAll();
		assert.equal(available.length, 1);
		assert.equal(available[0]?.record.key, a.key);
	} finally { h.close(); }
});

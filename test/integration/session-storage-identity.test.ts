import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CONVERSATION_ENTRY, ConversationStore } from "../../src/conversations/store.ts";
import { nativeRunOrdinals } from "../../src/extension/run-ordinals.ts";
import { NativeAppendBudget } from "../../src/io/native-append-budget.ts";
import { nativeSessionStorage } from "../../src/io/session-storage.ts";
import { tempDir } from "../setup/temp-dir.ts";

function sessionPaths() {
	const root = tempDir("persona-session-alias-");
	const sessions = join(root, "SessionFiles");
	const alias = join(root, "SessionAlias");
	mkdirSync(sessions);
	symlinkSync(sessions, alias, process.platform === "win32" ? "junction" : "dir");
	return { root, sessions, alias };
}

test("native supervisors opening one session through path aliases reserve distinct run IDs", () => {
	const { root, sessions, alias } = sessionPaths();
	const first = SessionManager.open(join(sessions, "SavedSession.jsonl"), sessions, root);
	first.appendMessage({ role: "user", content: "shared session", timestamp: 1 });
	const second = SessionManager.open(join(alias, process.platform === "win32" ? "savedsession.jsonl" : "SavedSession.jsonl"));
	const reserve = (manager: SessionManager) => nativeRunOrdinals(manager.getSessionFile(), manager.getSessionId())!(1, 1);
	assert.equal(first.getSessionId(), second.getSessionId());
	assert.equal(reserve(first), 1);
	assert.equal(reserve(second), 2);
	assert.deepEqual(nativeSessionStorage(first.getSessionFile(), first.getSessionId()), nativeSessionStorage(second.getSessionFile(), second.getSessionId()));
});

test("native storage identity survives Pi's first flush when the session directory is an alias", () => {
	const { root, sessions, alias } = sessionPaths();
	const manager = SessionManager.create(root, alias);
	const path = manager.getSessionFile()!;
	const sessionId = manager.getSessionId();
	const pending = nativeSessionStorage(path, sessionId);
	assert.equal(nativeRunOrdinals(path, sessionId)!(1, 1), 1);
	manager.appendMessage({ role: "user", content: "flush the session", timestamp: 1 });
	const reopened = SessionManager.open(join(sessions, basename(path)));
	assert.deepEqual(nativeSessionStorage(reopened.getSessionFile(), reopened.getSessionId()), pending);
	assert.equal(nativeRunOrdinals(reopened.getSessionFile(), reopened.getSessionId())!(1, 1), 2);
});

test("multiply linked session files cannot reserve independent IDs or spend the archive budget twice", () => {
	const root = tempDir("persona-hardlinked-session-");
	const first = SessionManager.create(root, root);
	first.appendMessage({ role: "user", content: "flush the session", timestamp: 1 });
	const file = first.getSessionFile()!;
	const alias = join(root, "hardlink.jsonl");
	linkSync(file, alias);
	for (const path of [file, alias]) {
		const manager = SessionManager.open(path);
		const reserve = nativeRunOrdinals(manager.getSessionFile(), manager.getSessionId())!;
		const budget = new NativeAppendBudget(path, manager.getSessionId(), { customType: "test", maxEntries: 1, maxBytes: 8, cost: () => 1 });
		assert.throws(() => reserve(1, 1), /single link/);
		assert.throws(() => budget.append(1, () => assert.fail("unsafe append")), /single link/);
	}
	unlinkSync(alias);
	assert.equal(nativeRunOrdinals(file, first.getSessionId())!(1, 1), 1);
});

test("a session reopened with its original spelling retains an existing worker transcript while a fork or copy cannot claim it", async () => {
	const { root, sessions } = sessionPaths();
	const file = join(sessions, "SavedSession.jsonl");
	const initial = SessionManager.open(file, sessions, root);
	initial.appendMessage({ role: "user", content: "start", timestamp: 1 });
	// On POSIX exercise the previous layout for a file symlink located in another directory.
	const originalPath = process.platform === "win32" ? join(sessions, "savedsession.jsonl") : join(root, "resume.jsonl");
	if (process.platform !== "win32") symlinkSync(file, originalPath);
	const manager = SessionManager.open(originalPath);
	const owner = createHash("sha256").update(`${realpathSync(originalPath)}\0${manager.getSessionId()}`).digest("hex");
	const dir = join(dirname(originalPath), "persona-workers", owner);
	mkdirSync(dir, { recursive: true });
	const store = (m: SessionManager) => new ConversationStore({
		sessionFile: m.getSessionFile(), sessionId: m.getSessionId(), entries: () => m.getEntries(),
		append: (type, data) => { m.appendCustomEntry(type, data); },
	});
	const fresh = store(manager).create();
	assert.ok(fresh.ok);
	assert.equal(dirname(fresh.value.file), nativeSessionStorage(originalPath, manager.getSessionId())?.directory);
	fresh.value.release();
	const key = randomUUID();
	const transcript = join(dir, `${key}.jsonl`);
	writeFileSync(transcript, "worker\n");
	manager.appendCustomEntry(CONVERSATION_ENTRY, {
		owner, key, rootRunId: "run-1", runId: "run-1", cwd: root, persona: null, model: "provider/model",
		fingerprint: "a".repeat(64), transcriptHash: createHash("sha256").update("worker\n").digest("hex"),
		updatedAt: Date.now(), spec: { agent: "scout", task: "inspect" },
	});
	const saved = store(manager);
	assert.equal(saved.list()[0]?.runId, "run-1");
	const acquired = saved.acquire("run-1", manager.getBranch());
	assert.ok(acquired.ok);
	assert.equal(realpathSync.native(acquired.value.lease.file), realpathSync.native(transcript));
	acquired.value.lease.release();
	const copy = join(sessions, "copy.jsonl");
	copyFileSync(file, copy);
	for (const other of [SessionManager.open(copy), SessionManager.forkFrom(file, root, sessions)]) {
		const unrelated = store(other);
		assert.deepEqual(unrelated.list(), []);
		assert.equal(unrelated.acquire("run-1").ok, false);
		assert.equal((await unrelated.forget("run-1")).ok, false);
	}
	assert.ok(existsSync(transcript));
});

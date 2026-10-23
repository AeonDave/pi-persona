import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager, type CustomEntry, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { MonitorEntry } from "../../src/core/monitor.ts";
import { MONITOR_LOG_ENTRY, MonitorArchive, type MonitorLogRecord } from "../../src/monitor/archive.ts";

// Real development Pi storage, without AgentSession, provider registration, or model requests.
// SessionManager has no close/dispose API: its synchronous writes close their file descriptors.
// Returning from the writer scope below and opening a fresh manager is the reload boundary.
function archiveFor(manager: SessionManager): MonitorArchive {
	return new MonitorArchive({
		entries: () => manager.getEntries(),
		append: (type, data) => { manager.appendCustomEntry(type, data); },
	});
}

function monitor(cwd: string, id: string): MonitorEntry {
	return {
		id, label: `synthetic ${id}`, command: "never-executed-monitor-fixture",
		args: ["--literal", "argument with spaces"], cwd, mode: "exit",
		startedAtEpochMs: 1_700_000_000_000, expiresAtEpochMs: 1_700_000_060_000, maxEvents: 1,
	};
}

function conversation(manager: SessionManager): [UserMessage, AssistantMessage] {
	const user: UserMessage = { role: "user", content: "Ordinary session storage fixture request.", timestamp: 1_700_000_000_100 };
	const assistant: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text: "Ordinary session storage fixture reply." }],
		api: "openai-responses", provider: "synthetic-no-provider", model: "session-storage-fixture",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop", timestamp: 1_700_000_000_200,
	};
	// Pi deliberately buffers setup/custom entries until a normal conversation starts.
	// Supply both roles to exercise a complete offline transcript without a model call.
	manager.appendMessage(user);
	manager.appendMessage(assistant);
	return [user, assistant];
}

function logEntries(manager: SessionManager) {
	return manager.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === MONITOR_LOG_ENTRY);
}

function inventory(root: string): string[] {
	// Include directories too: an empty extension log/artifact directory is a sidecar as well.
	return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

function readJsonl(path: string): FileEntry[] {
	return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FileEntry);
}

test("real Pi JSONL owns terminal monitor logs across reopen, excludes them from context, and leaves no sidecars on deletion", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-persona-monitor-log-session-"));
	try {
		const cwd = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(sessionDir);
		const baseline = inventory(root);
		const stdout = "MONITOR_STDOUT_SESSION_ONLY_5d76\rprogress 50%\nraw <fixture> ✓\n";
		const stderr = "MONITOR_STDERR_SESSION_ONLY_5d76\n";
		const terminalText = "MONITOR_TERMINAL_SESSION_ONLY_5d76: exited with code 0";

		const saved = (() => {
			const manager = SessionManager.create(cwd, sessionDir);
			assert.equal(manager.isPersisted(), true);
			const path = manager.getSessionFile();
			assert.ok(path);
			const archive = archiveFor(manager);
			const entry = monitor(cwd, "session-proof-exit");
			archive.armed(entry);
			archive.output({ id: entry.id, stream: "stdout", text: stdout.slice(0, 20) });
			archive.output({ id: entry.id, stream: "stdout", text: stdout.slice(20) });
			archive.output({ id: entry.id, stream: "stderr", text: stderr });
			assert.deepEqual(logEntries(manager), [], "raw chunks must not create session entries");
			archive.event({ id: entry.id, label: entry.label, kind: "exit", atEpochMs: entry.startedAtEpochMs + 500, text: terminalText, terminal: true });
			const expected: MonitorLogRecord = { version: 1, entry, outcome: "exit", text: terminalText, stdout, stderr, truncated: false };
			assert.deepEqual(archive.result(entry.id), expected);
			assert.equal(logEntries(manager).length, 1, "terminal snapshot is a real custom session entry");
			assert.equal(existsSync(path), false, "a custom-only session follows Pi's deferred conversation flush");
			assert.deepEqual(inventory(root), baseline);

			const messages = conversation(manager);
			assert.equal(existsSync(path), true, "ordinary user/assistant messages flush the buffered log to disk");
			assert.equal(readJsonl(path).filter((item) => item.type === "custom" && item.customType === MONITOR_LOG_ENTRY).length, 1);
			const beforeAppend = readFileSync(path, "utf8");

			// Also exercise a terminal append after the session has already been flushed.
			const cancelled = monitor(cwd, "session-proof-cancelled");
			archive.armed(cancelled);
			archive.output({ id: cancelled.id, stream: "stdout", text: "MONITOR_CANCELLED_SESSION_ONLY_5d76" });
			assert.equal(readFileSync(path, "utf8"), beforeAppend, "arming/output do not write per-chunk entries");
			archive.removed(cancelled);
			const cancelledRecord: MonitorLogRecord = {
				version: 1, entry: cancelled, outcome: "cancelled", text: "",
				stdout: "MONITOR_CANCELLED_SESSION_ONLY_5d76", stderr: "", truncated: false,
			};
			assert.deepEqual(archive.result(cancelled.id), cancelledRecord);
			const afterAppend = readFileSync(path, "utf8");
			assert.ok(afterAppend.startsWith(beforeAppend), "archive persistence only appends to the existing JSONL");
			assert.equal(afterAppend.slice(beforeAppend.length).trim().split("\n").length, 1, "one cancellation snapshot, not stream sidecars");
			archive.removed(cancelled);
			archive.event({ id: entry.id, label: entry.label, kind: "exit", atEpochMs: entry.startedAtEpochMs + 600, text: "duplicate", terminal: true });
			assert.equal(readFileSync(path, "utf8"), afterAppend, "duplicate terminal callbacks do not append again");
			assert.deepEqual(manager.buildSessionContext().messages, messages);
			return { path, sessionId: manager.getSessionId(), records: [expected, cancelledRecord], messages };
		})();

		const reopened = SessionManager.open(saved.path);
		assert.equal(reopened.getSessionId(), saved.sessionId);
		assert.equal(reopened.getSessionFile(), saved.path);
		const restored = archiveFor(reopened);
		const beforeRestore = readFileSync(saved.path, "utf8");
		assert.deepEqual(restored.list(), saved.records);
		for (const record of saved.records) assert.deepEqual(restored.result(record.entry.id), record);
		assert.equal(restored.result("unowned-monitor"), undefined);
		assert.equal(readFileSync(saved.path, "utf8"), beforeRestore, "hydration is read-only, not a re-append");
		const diskLogs = readJsonl(saved.path).filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === MONITOR_LOG_ENTRY);
		assert.deepEqual(diskLogs.map((entry) => entry.data), saved.records);
		assert.equal(diskLogs.length, 2, "exactly one plain custom entry per terminal lifecycle");
		assert.deepEqual(reopened.buildSessionContext().messages, saved.messages, "ordinary conversation survives but raw logs never enter model context");
		const projectedLogs = reopened.buildSessionProjection().entries.filter((item) => item.sourceEntry.type === "custom" && item.sourceEntry.customType === MONITOR_LOG_ENTRY);
		assert.equal(projectedLogs.length, 2, "logs are selected on the active branch, not absent because of branch filtering");
		for (const item of projectedLogs) assert.deepEqual(item.messages, [], "plain custom entries project to zero model messages");

		assert.deepEqual(inventory(root), [...baseline, join("sessions", basename(saved.path))].sort(), "the owning JSONL is the only added artifact");
		// Delete ONLY the session file, before recursive fixture cleanup. Session entries cannot
		// be individually removed. This is unlink ownership proof, not secure erase or OS trash.
		unlinkSync(saved.path);
		assert.equal(existsSync(saved.path), false);
		assert.deepEqual(inventory(root), baseline, "deleting the JSONL leaves no extension log/artifact files or directories");
		assert.deepEqual(await SessionManager.list(cwd, sessionDir), [], "deleted logs have no resumable session owner");
		assert.deepEqual(archiveFor(SessionManager.inMemory(cwd)).list(), [], "fresh storage cannot recover deleted logs from an extension cache");
		// Existing manager/archive objects deliberately still have their in-memory copies.
		// External session copies, backups, exported transcripts and trash are outside this proof.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const scenario of [
	{ name: "record", perBranch: 32, payload: "diagnostic" },
	{ name: "byte", perBranch: 8, payload: "x".repeat(16_384) },
]) {
	test(`monitor archive is session-wide across sibling branches and shares the ${scenario.name} budget after reopen`, () => {
		const root = mkdtempSync(join(tmpdir(), "pi-persona-monitor-branches-"));
		try {
			const manager = SessionManager.create(root, root);
			conversation(manager);
			const common = manager.appendMessage({ role: "user", content: "shared ancestor", timestamp: 1_700_000_001_000 });
			manager.appendMessage({ role: "user", content: "branch A", timestamp: 1_700_000_001_100 });
			const finish = (archive: MonitorArchive, id: string): void => {
				const entry = monitor(root, id);
				archive.armed(entry);
				archive.output({ id, stream: "stdout", text: scenario.payload });
				archive.output({ id, stream: "stderr", text: scenario.payload });
				archive.event({ id, label: entry.label, kind: "exit", atEpochMs: entry.startedAtEpochMs + 1, text: scenario.payload, terminal: true });
			};
			const branchA = archiveFor(manager);
			for (let i = 0; i < scenario.perBranch; i++) finish(branchA, `a-${i}`);
			const aId = `a-${scenario.perBranch - 1}`;
			assert.equal(branchA.result(aId)?.storageWarning, undefined);
			const aEntry = logEntries(manager).find((entry) => (entry.data as MonitorLogRecord).entry.id === aId);
			assert.ok(aEntry);

			manager.branch(common);
			manager.appendMessage({ role: "user", content: "branch B", timestamp: 1_700_000_001_200 });
			assert.equal(manager.getBranch().some((entry) => entry.id === aEntry.id), false);
			// A new archive on branch B must charge AND expose branch A's session-owned logs.
			const branchB = archiveFor(manager);
			assert.equal(branchB.result(aId)?.stdout, scenario.payload);
			for (let i = 0; i < scenario.perBranch; i++) finish(branchB, `b-${i}`);
			finish(branchB, "overflow");
			assert.match(branchB.result("overflow")?.storageWarning ?? "", /budget exhausted/);
			const persisted = logEntries(manager);
			if (scenario.name === "record") assert.equal(persisted.length, 64);
			else assert.ok(persisted.length < scenario.perBranch * 2, "byte limit applies across both branches, before the record limit");
			assert.equal(persisted.some((entry) => (entry.data as MonitorLogRecord).entry.id === "overflow"), false);

			const path = manager.getSessionFile();
			assert.ok(path);
			const reopened = SessionManager.open(path);
			const restored = archiveFor(reopened);
			assert.equal(restored.result(aId)?.stdout, scenario.payload, "sibling log is recoverable after reopening branch B");
			assert.equal(restored.result("b-0")?.stdout, scenario.payload);
			assert.equal(restored.result("overflow"), undefined, "runtime-only overflow is not presented as durable");
			const ids = restored.list().map((record) => record.entry.id).sort();
			reopened.branch(aEntry.id);
			assert.equal(reopened.getBranch().some((entry) => entry.type === "custom" && (entry.data as MonitorLogRecord).entry?.id === "b-0"), false);
			assert.deepEqual(restored.list().map((record) => record.entry.id).sort(), ids, "navigation changes the transcript, not session-wide archive visibility");
			assert.deepEqual(archiveFor(reopened).list().map((record) => record.entry.id).sort(), ids);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("real nonpersistent Pi SessionManager retains monitor logs only in memory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-persona-monitor-log-memory-"));
	try {
		const manager = SessionManager.inMemory(root);
		assert.equal(manager.isPersisted(), false);
		assert.equal(manager.getSessionFile(), undefined);
		const archive = archiveFor(manager);
		const entry = monitor(root, "memory-only-monitor");
		archive.armed(entry);
		archive.output({ id: entry.id, stream: "stdout", text: "MONITOR_MEMORY_ONLY_5d76\n" });
		archive.event({ id: entry.id, label: entry.label, kind: "exit", atEpochMs: entry.startedAtEpochMs + 1, text: "memory complete", terminal: true });
		const expected: MonitorLogRecord = {
			version: 1, entry, outcome: "exit", text: "memory complete",
			stdout: "MONITOR_MEMORY_ONLY_5d76\n", stderr: "", truncated: false,
		};
		const messages = conversation(manager);
		assert.equal(logEntries(manager).length, 1, "real appendCustomEntry still records memory-only state");
		assert.deepEqual(archive.result(entry.id), expected);
		assert.deepEqual(archiveFor(manager).list(), [expected], "same-session reload can read its in-memory entries");
		assert.deepEqual(manager.buildSessionContext().messages, messages);
		assert.equal(manager.getSessionFile(), undefined, "conversation does not make a nonpersistent manager persistent");
		assert.deepEqual(inventory(root), [], "no session, log sidecar or artifact directory is written");
		const fresh = archiveFor(SessionManager.inMemory(root));
		assert.equal(fresh.result(entry.id), undefined);
		assert.deepEqual(fresh.list(), [], "a fresh session does not inherit another manager's logs");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

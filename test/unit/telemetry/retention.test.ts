import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { tempDir } from "../../setup/temp-dir.ts";
import { killProcessTree } from "../../../src/engine/child.ts";
import { TelemetryProducer, flushTelemetryRetention } from "../../../src/telemetry/producer.ts";
import { telemetrySessionFileKey, telemetryWorkspaceId } from "../../../src/telemetry/paths.ts";

const old = new Date("2020-01-01T00:00:00.000Z");
const now = Date.parse("2025-01-01T00:00:00.000Z");
const retention = 30 * 24 * 60 * 60 * 1000;

function log(root: string, workspace: string, producer: string, session: string): string {
	const dir = join(root, "telemetry", "v2", workspace, producer);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${session}.jsonl`);
	writeFileSync(path, "old\n");
	utimesSync(path, old, old);
	return path;
}

function marker(file: string, kind: "writer" | "prune", pid = process.pid): string {
	const dir = `${file}.leases`;
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${kind}-${pid}-${randomUUID()}`);
	writeFileSync(path, "", { flag: "wx" });
	return path;
}

test("retention removes only old well-scoped logs across workspaces and empty owned directories", async () => {
	const root = tempDir("pi-persona-retention-old-");
	const owned = log(root, "a".repeat(24), "pi-persona", "a".repeat(16));
	const fresh = log(root, "b".repeat(24), "pi-persona", "b".repeat(16));
	utimesSync(fresh, new Date(now), new Date(now));
	const foreign = log(root, "c".repeat(24), "other-producer", "c".repeat(16));
	const malformed = log(root, "bad", "pi-persona", "d".repeat(16));
	await flushTelemetryRetention(root, "pi-persona", retention, now);
	assert.equal(existsSync(owned), false);
	assert.equal(existsSync(dirname(dirname(owned))), false, "empty stale workspace is removed nonrecursively");
	for (const path of [fresh, foreign, malformed]) assert.equal(readFileSync(path, "utf8"), "old\n");
});

test("cleanup rejects unsafe producer segments before inspecting files", async () => {
	const root = tempDir("pi-persona-retention-scope-");
	const sentinel = log(root, "a".repeat(24), "pi-persona", "a".repeat(16));
	for (const producer of ["", ".", "..", "../pi-persona", "pi/persona", "pi\\persona"]) {
		await assert.rejects(flushTelemetryRetention(root, producer, 1, now), /producer/i);
	}
	assert.equal(readFileSync(sentinel, "utf8"), "old\n");
});

test("orphan backup, scratch and dead lease groups are reclaimed without a primary log", async () => {
	const root = tempDir("pi-persona-retention-orphans-");
	for (const suffix of [".previous", ".trim-123-456"]) {
		const file = log(root, "a".repeat(24), "pi-persona", suffix === ".previous" ? "a".repeat(16) : "b".repeat(16));
		writeFileSync(`${file}${suffix}`, "backup\n");
		utimesSync(`${file}${suffix}`, old, old);
		unlinkSync(file);
	}
	const orphan = log(root, "b".repeat(24), "pi-persona", "c".repeat(16));
	const lease = marker(orphan, "writer", 2_000_000_000);
	unlinkSync(orphan);
	await flushTelemetryRetention(root, "pi-persona", retention, now);
	assert.equal(existsSync(lease), false);
	assert.deepEqual(readdirSync(join(root, "telemetry", "v2")), []);
});

test("a fresh backup or scratch retains the entire old session group; cutoff is exclusive", async () => {
	const root = tempDir("pi-persona-retention-group-");
	for (const suffix of [".previous", ".trim-123-456"]) {
		const file = log(root, "a".repeat(24), "pi-persona", suffix === ".previous" ? "a".repeat(16) : "b".repeat(16));
		writeFileSync(`${file}${suffix}`, "fresh\n");
		utimesSync(`${file}${suffix}`, new Date(now), new Date(now));
	}
	const boundary = log(root, "b".repeat(24), "pi-persona", "c".repeat(16));
	utimesSync(boundary, new Date(now - retention), new Date(now - retention));
	await flushTelemetryRetention(root, "pi-persona", retention, now);
	assert.equal(existsSync(boundary), true);
	assert.equal(readdirSync(join(root, "telemetry", "v2", "a".repeat(24), "pi-persona")).filter((name) => name.endsWith(".jsonl")).length, 2);
});

test("symlink and hardlink log sentinels are never pruned", async () => {
	const root = tempDir("pi-persona-retention-links-");
	const target = join(root, "outside.jsonl");
	writeFileSync(target, "outside\n");
	const dir = join(root, "telemetry", "v2", "a".repeat(24), "pi-persona");
	mkdirSync(dir, { recursive: true });
	const symlink = join(dir, `${"b".repeat(16)}.jsonl`);
	const hardlink = join(dir, `${"c".repeat(16)}.jsonl`);
	symlinkSync(target, symlink);
	linkSync(target, hardlink);
	utimesSync(target, old, old);
	await flushTelemetryRetention(root, "pi-persona", 1, now);
	for (const path of [target, symlink, hardlink]) assert.equal(readFileSync(path, "utf8"), "outside\n");
});

test("writer admission rejects linked namespace ancestors and logs before mutating them", () => {
	const root = tempDir("pi-persona-retention-admission-");
	const outside = tempDir("pi-persona-retention-sentinel-");
	const workspace = telemetryWorkspaceId("/linked-work");
	mkdirSync(join(root, "telemetry", "v2"), { recursive: true });
	symlinkSync(outside, join(root, "telemetry", "v2", workspace), "junction");
	assert.throws(() => new TelemetryProducer({ agentDir: root, cwd: "/linked-work", sessionId: "s", emit: () => {} }), /unsafe|linked/i);
	assert.deepEqual(readdirSync(outside), [], "no producer/lease directory may be created outside the namespace");
	const file = log(root, "b".repeat(24), "pi-persona", "b".repeat(16));
	const options = { agentDir: root, cwd: "/hardlinked-work", sessionId: "s", emit: () => {}, retentionMs: 0 };
	const targetDir = join(root, "telemetry", "v2", telemetryWorkspaceId(options.cwd), "pi-persona");
	mkdirSync(targetDir, { recursive: true });
	linkSync(file, join(targetDir, `${telemetrySessionFileKey(options.sessionId)}.jsonl`));
	assert.throws(() => new TelemetryProducer(options), /unsafe|linked/i);
	assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("failed writer admission removes its newly created empty lease directory", () => {
	const root = tempDir("pi-persona-retention-admission-cleanup-");
	const cwd = "/linked-log-work";
	const sessionId = "linked-log";
	const workspace = telemetryWorkspaceId(cwd);
	const fileKey = telemetrySessionFileKey(sessionId);
	const dir = join(root, "telemetry", "v2", workspace, "pi-persona");
	const outside = join(root, "outside.jsonl");
	mkdirSync(dir, { recursive: true });
	writeFileSync(outside, "outside\n");
	linkSync(outside, join(dir, `${fileKey}.jsonl`));

	assert.throws(() => new TelemetryProducer({ agentDir: root, cwd, sessionId, emit: () => {}, retentionMs: 0 }), /unsafe|linked/i);
	assert.equal(existsSync(`${join(dir, `${fileKey}.jsonl`)}.leases`), false, "the failed admission must not leave its empty lease directory");
	assert.equal(readFileSync(outside, "utf8"), "outside\n", "the linked stream target remains untouched");
});

test("retention duration validation rejects negative, fractional, and unsafe values", async () => {
	const root = tempDir("pi-persona-retention-validation-");
	const invalid = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY];
	for (let index = 0; index < invalid.length; index += 1) {
		const retentionMs = invalid[index]!;
		assert.throws(() => new TelemetryProducer({
			agentDir: join(root, `agent-${index}`), cwd: `/retention-${index}`, sessionId: "s", emit: () => {}, retentionMs,
		}), /retentionMs/);
		await assert.rejects(flushTelemetryRetention(join(root, `flush-${index}`), "pi-persona", retentionMs), /retentionMs/);
	}
	assert.deepEqual(readdirSync(root), [], "invalid durations are rejected before filesystem mutation");
});

test("zero retention disables cleanup but still publishes writer protection", async () => {
	const root = tempDir("pi-persona-retention-off-");
	const path = log(root, "a".repeat(24), "pi-persona", "a".repeat(16));
	await flushTelemetryRetention(root, "pi-persona", 0, now);
	assert.equal(readFileSync(path, "utf8"), "old\n");
	const p = new TelemetryProducer({ agentDir: root, cwd: "/off", sessionId: "off", emit: () => {}, retentionMs: 0 });
	assert.equal(readdirSync(`${p.filePath}.leases`).some((name) => name.startsWith("writer-")), true);
	await p.stop();
});

test("pruner-first admission fails before emit/read/repair and leaves the existing stream intact", () => {
	const root = tempDir("pi-persona-retention-pruner-first-");
	const cwd = "/claimed";
	const sessionId = "claimed";
	const file = log(root, telemetryWorkspaceId(cwd), "pi-persona", telemetrySessionFileKey(sessionId));
	const claim = marker(file, "prune");
	let emitted = 0;
	assert.throws(() => new TelemetryProducer({ agentDir: root, cwd, sessionId, emit: () => { emitted++; } }), /prune/i);
	assert.equal(emitted, 0);
	assert.equal(readFileSync(file, "utf8"), "old\n");
	assert.deepEqual(readdirSync(`${file}.leases`), [claim.slice(claim.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1)]);
});

test("active old producer protects its group and keeps its lease until terminal writes finish", async () => {
	const root = tempDir("pi-persona-retention-lease-");
	const p = new TelemetryProducer({ agentDir: root, cwd: "/old-work", sessionId: "active", emit: () => {}, heartbeatMs: 0 });
	p.publish("instance.heartbeat", { contextPercent: 1 });
	await p.flush();
	utimesSync(p.filePath, old, old);
	await flushTelemetryRetention(root, p.producerId, 1, now);
	assert.equal(readFileSync(p.filePath, "utf8").length > 0, true);
	const stopped = p.stop();
	assert.equal(readdirSync(`${p.filePath}.leases`).some((name) => name.startsWith("writer-")), true);
	await stopped;
	assert.equal(existsSync(`${p.filePath}.leases`), false);
});

test("shutdown flushes terminal writes and releases its lease without joining an unfinished retention sweep", async (t) => {
	const root = tempDir("pi-persona-retention-shutdown-");
	const p = new TelemetryProducer({ agentDir: root, cwd: "/shutdown", sessionId: "shutdown", emit: () => {}, heartbeatMs: 0 });
	const actualRetention = p.flushRetention();
	// Instrument the private maintenance promise only in the test: detect either a public
	// flushRetention() join or a direct await without adding a production-only test hook.
	const maintenance = p as unknown as { retentionSweep: PromiseLike<void> };
	const originalSweep = maintenance.retentionSweep;
	let releaseWrites!: () => void;
	let releaseRetention!: () => void;
	let observeRetentionWait!: () => void;
	const writesReady = new Promise<void>((resolve) => { releaseWrites = resolve; });
	const retentionReady = new Promise<void>((resolve) => { releaseRetention = resolve; });
	const retentionWaited = new Promise<void>((resolve) => { observeRetentionWait = resolve; });
	const flush = p.flush.bind(p);
	// Real filesystem writes and lease cleanup still run behind the controlled barriers.
	t.mock.method(p, "flush", async () => { await writesReady; await flush(); });
	maintenance.retentionSweep = {
		then: (fulfilled, rejected) => {
			observeRetentionWait();
			return retentionReady.then(fulfilled, rejected);
		},
	};
	const stopped = p.stop();
	try {
		assert.equal(readdirSync(`${p.filePath}.leases`).some((name) => name.startsWith("writer-")), true, "the lease protects pending terminal writes");
		releaseWrites();
		const outcome = await Promise.race([
			stopped.then(() => "stopped"),
			retentionWaited.then(() => "waiting for retention"),
		]);
		assert.equal(outcome, "stopped", "background cleanup must not gate shutdown");
		assert.equal(existsSync(`${p.filePath}.leases`), false);
		assert.match(readFileSync(p.filePath, "utf8"), /"type":"instance.stopped"/, "the terminal event is on disk before shutdown resolves");
		assert.equal(p.publish("instance.heartbeat", {}), undefined, "a stopped producer cannot reopen its write stream");
		await p.stop();
	} finally {
		releaseWrites();
		releaseRetention();
		maintenance.retentionSweep = originalSweep;
		await stopped;
		await actualRetention;
	}
});

test("unknown marker ownership and indeterminate process liveness protect old data", async (t) => {
	const root = tempDir("pi-persona-retention-unknown-");
	const file = log(root, "a".repeat(24), "pi-persona", "a".repeat(16));
	const lease = marker(file, "writer", 123_456);
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
	await flushTelemetryRetention(root, "pi-persona", retention, now);
	assert.equal(existsSync(file), true);
	assert.equal(existsSync(lease), true);
	unlinkSync(lease);
	writeFileSync(join(`${file}.leases`, "unknown-owner"), "");
	await flushTelemetryRetention(root, "pi-persona", retention, now);
	assert.equal(existsSync(file), true);
});

test("concurrent pruners reclaim dead claims idempotently and preserve unrelated artifacts", async () => {
	const root = tempDir("pi-persona-retention-concurrent-");
	const file = log(root, "a".repeat(24), "pi-persona", "a".repeat(16));
	const dead = marker(file, "prune", 2_000_000_000);
	const unrelated = join(dirname(file), "notes.txt");
	writeFileSync(unrelated, "keep");
	await Promise.all([flushTelemetryRetention(root, "pi-persona", retention, now), flushTelemetryRetention(root, "pi-persona", retention, now)]);
	assert.equal(existsSync(file), false);
	assert.equal(existsSync(dead), false);
	assert.equal(readFileSync(unrelated, "utf8"), "keep");
});

test("cross-process writer lease survives prune until an IPC-controlled clean stop", { timeout: 15_000 }, async (t) => {
	const root = tempDir("pi-persona-retention-ipc-");
	const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/telemetry-lease-worker.mjs", root, "/ipc-work", "cross-process"], {
		cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"], detached: process.platform !== "win32", windowsHide: true,
	});
	let stderr = "";
	child.stderr!.setEncoding("utf8").on("data", (text) => { stderr += text; });
	const received = new Map<string, any>();
	const waiting = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
	const fail = (error: Error) => { for (const waiter of waiting.values()) waiter.reject(error); waiting.clear(); };
	child.on("message", (message: any) => {
		const waiter = waiting.get(message.type);
		if (waiter) { waiting.delete(message.type); waiter.resolve(message); }
		else received.set(message.type, message);
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once("error", (error) => { fail(error); resolve(-1); });
		child.once("exit", (code) => { fail(new Error(`lease worker exited: ${code}: ${stderr}`)); resolve(code); });
	});
	t.signal.addEventListener("abort", () => fail(new Error("IPC test deadline exceeded")), { once: true });
	t.after(() => { if (child.exitCode === null && child.pid) killProcessTree(child.pid); });
	const next = (type: string) => received.has(type) ? Promise.resolve(received.get(type)) : new Promise<any>((resolve, reject) => waiting.set(type, { resolve, reject }));
	const ready = await next("READY");
	utimesSync(ready.file, old, old);
	await flushTelemetryRetention(root, "pi-persona", 1, now);
	assert.equal(existsSync(ready.file), true);
	const stopped = next("STOPPED");
	child.send("stop");
	await stopped;
	assert.equal(await exited, 0);
	utimesSync(ready.file, old, old); // terminal publication refreshed mtime; expire only after shutdown
	await flushTelemetryRetention(root, "pi-persona", 1, now);
	assert.equal(existsSync(ready.file), false);
});

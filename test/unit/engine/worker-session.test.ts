import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateWorkerSession } from "../../../src/engine/worker-session.ts";

test("worker session preflight rejects missing, colliding, malformed and unfinished sessions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-worker-session-"));
	try {
		const file = join(dir, "worker.jsonl");
		await validateWorkerSession({ file, resume: false }, dir);
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
		writeFileSync(file, "");
		await assert.rejects(validateWorkerSession({ file, resume: false }, dir));
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
		writeFileSync(file, "not json\n");
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
		writeFileSync(file, JSON.stringify({ type: "session", cwd: dir }) + "\n");
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker session accepts a real Pi transcript and rejects a different cwd, damaged tail and size overflow", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-worker-session-"));
	try {
		const file = join(dir, "worker.jsonl");
		const manager = SessionManager.open(file, undefined, dir);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		await validateWorkerSession({ file, resume: true }, dir);
		await assert.rejects(validateWorkerSession({ file, resume: true }, join(dir, "other")));
		writeFileSync(file, "{broken\n", { flag: "a" });
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
		writeFileSync(file, "x".repeat(8 * 1024 * 1024 + 1));
		await assert.rejects(validateWorkerSession({ file, resume: true }, dir));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker session refuses non-regular files and symbolic links", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-worker-session-"));
	try {
		const file = join(dir, "target.jsonl");
		writeFileSync(file, "");
		await assert.rejects(validateWorkerSession({ file: dir, resume: true }, dir));
		if (process.platform !== "win32") {
			const link = join(dir, "link.jsonl");
			symlinkSync(file, link);
			await assert.rejects(validateWorkerSession({ file: link, resume: true }, dir));
			await assert.rejects(validateWorkerSession({ file: link, resume: false }, dir));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

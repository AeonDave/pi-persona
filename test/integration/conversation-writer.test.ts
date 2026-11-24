import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../../src/conversations/store.ts";
import { processState } from "../../src/io/process-state.ts";

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(existsSync(path), true, `${path} was not published`);
}

test("admission after supervisor death cannot reclaim a live child engine's transcript", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-orphan-writer-"));
	const sessionFile = join(dir, "parent.jsonl");
	const sessionId = "test-owner";
	writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
	const ready = join(dir, "writer-ready");
	const proceed = join(dir, "writer-proceed");
	const written = join(dir, "writer-proceeded");
	const helper = fileURLToPath(new URL("../fixtures/conversation-writer.mjs", import.meta.url));
	const supervisor = spawn(process.execPath, ["--experimental-strip-types", helper, "supervisor", sessionFile, sessionId, ready, proceed, written], { windowsHide: true });
	const exited = once(supervisor, "exit");
	let diagnostic = "";
	supervisor.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString("utf8"); });
	let workerPid: number | undefined;
	try {
		await Promise.race([waitForFile(ready), exited.then(() => { throw new Error(diagnostic || "The fixture supervisor exited"); })]);
		const { pid, transcript } = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; transcript: string };
		workerPid = pid;
		assert.equal(supervisor.kill("SIGKILL"), true);
		await exited;
		const workerState = processState(pid);
		const store = new ConversationStore({ sessionFile, sessionId, entries: () => [], append() {} });
		const admission = store.create();
		assert.ok(admission.ok, admission.ok ? undefined : admission.error);
		admission.value.release();
		if (process.platform === "win32" && workerState === "dead") {
			assert.equal(existsSync(transcript), false, "Windows reaped the worker with its supervisor, so reclamation is safe");
			return;
		}
		assert.equal(workerState, "alive", "the worker survives the supervisor process");
		assert.equal(existsSync(transcript), true, "an active writer's transcript must survive orphan reclamation");
		writeFileSync(proceed, "continue");
		await waitForFile(written);
		assert.match(readFileSync(transcript, "utf8"), /began\nworker continued after loss of supervisor/);
	} finally {
		if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
		await exited;
		if (workerPid !== undefined) {
			try { process.kill(workerPid, "SIGKILL"); } catch { /* fixture already ended */ }
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
	}
});

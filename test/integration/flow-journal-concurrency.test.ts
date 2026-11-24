import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { readJournal } from "../../src/orchestration/flow-journal.ts";
import { tempDir } from "../setup/temp-dir.ts";

test("journal cleanup in one process keeps every checkpoint appended by another", { timeout: 30_000 }, async () => {
	const file = join(tempDir("flow-journal-process-"), "flow.journal.jsonl");
	const count = 40;
	const source = `
		import assert from "node:assert/strict";
		import { clearJournal, journalWriter } from "./src/orchestration/flow-journal.ts";
		const [file, task, count] = process.argv.slice(1);
		const write = journalWriter(file);
		process.once("message", () => {
			for (let i = 0; i < Number(count); i++) {
				assert.ok(write({ phase: "phase-" + i, hash: task, ok: true, output: task + i }));
				if (task === "finished") assert.ok(clearJournal(file, task));
			}
			process.disconnect();
		});
		process.send("ready");
	`;
	const children = ["finished", "pending"].map((task) => spawn(process.execPath,
		["--input-type=module", "-e", source, file, task, String(count)],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true }));
	const exits = children.map((child) => once(child, "exit"));
	try {
		await Promise.all(children.map((child, index) => Promise.race([
			once(child, "message"),
			exits[index]!.then(([code]) => { throw new Error(`Journal worker exited before readiness (${code})`); }),
		])));
		for (const child of children) child.send("start");
		assert.deepEqual((await Promise.all(exits)).map(([code]) => code), [0, 0]);
		const resumed = readJournal(file, "pending");
		assert.deepEqual(Object.values(resumed).map((phase) => phase.output),
			Array.from({ length: count }, (_, i) => `pending${i}`));
		assert.deepEqual(readJournal(file, "finished"), {});
	} finally {
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
		await Promise.allSettled(exits);
	}
});

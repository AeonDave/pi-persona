import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../../src/conversations/store.ts";
import { runChildAgent } from "../../src/engine/child.ts";

if (process.argv[2] === "supervisor") {
	const [, , , sessionFile, sessionId, ready, proceed, written] = process.argv;
	const store = new ConversationStore({ sessionFile, sessionId, entries: () => [], append() {} });
	const created = store.create();
	if (!created.ok) throw new Error(created.error);
	const lease = created.value;
	const result = await runChildAgent({
		task: "write transcript", session: { file: lease.file, resume: false, setExternalWriter: lease.setExternalWriter },
	}, undefined, {
		resolveInvocation: (args) => ({
			command: process.execPath,
			args: ["--experimental-strip-types", fileURLToPath(import.meta.url), "worker", ready, proceed, written, ...args],
		}),
	});
	if (!result.ok) throw new Error(result.errorMessage ?? result.stderr ?? "fixture worker failed");
} else {
	const [, , , ready, proceed, written] = process.argv;
	const transcript = process.argv[process.argv.indexOf("--session") + 1];
	writeFileSync(transcript, "worker began\n");
	writeFileSync(`${ready}.tmp`, JSON.stringify({ pid: process.pid, transcript }));
	renameSync(`${ready}.tmp`, ready);
	let advanced = false;
	const watch = setInterval(() => {
		if (advanced || !existsSync(proceed)) return;
		appendFileSync(transcript, "worker continued after loss of supervisor\n");
		writeFileSync(written, "done");
		advanced = true;
	}, 10);
	setTimeout(() => clearInterval(watch), 15_000);
}

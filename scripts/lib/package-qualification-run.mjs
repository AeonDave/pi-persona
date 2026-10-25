/** One real host CLI / one engine. Receipts and protocol events, never timer/peek polling. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForReceipt } from "./package-qualification.ts";
import { stopQualificationProcessTree } from "./package-qualification-process.ts";

const [hostRoot, packageRoot, fixtures, root, engine] = process.argv.slice(2);
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
const receipts = join(root, "receipts.jsonl");
await mkdir(join(agentDir, "persona", "agents"), { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(receipts, "");
await writeFile(join(agentDir, "settings.json"), JSON.stringify({
	packages: [packageRoot], extensions: [join(fixtures, "provider.mjs")],
	defaultProvider: "package-qualification", defaultModel: "local",
	retry: { enabled: false }, compaction: { enabled: false },
}));
await writeFile(join(agentDir, "persona", "agents", "package-supervisor.md"), "---\nname: package-supervisor\npersona: true\n---\nOffline qualification supervisor.\n");
await writeFile(join(agentDir, "persona", "agents", "package-worker.md"), "---\nname: package-worker\ntools: []\n---\nOffline qualification worker.\n");
const manifest = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
const cli = join(hostRoot, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--model", "package-qualification/local"], {
	cwd: workspace, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
	env: { ...process.env, PI_PERSONA_ENGINE: engine, PI_PERSONA_PERSIST: "off", PI_PERSONA_NUDGE: "off", PACKAGE_QUALIFICATION_RECEIPTS: receipts, NODE_OPTIONS: `--import=${pathToFileURL(join(fixtures, "tripwire.mjs")).href}` },
});
const outcome = { status: "FAIL", engine, hostVersion: manifest.version, cli, checks: {} };
const events = [], listeners = new Set();
let buffer = "", stderr = "", ended = false, failure, requestId = 0;
const closed = new Promise((resolve) => {
	child.on("error", (error) => { failure = error; });
	child.on("close", (code, signal) => { ended = true; failure ??= new Error(`Host exited (${code}, ${signal}): ${stderr.slice(-6000)}`); for (const listener of listeners) listener(); resolve({ code, signal }); });
});
child.stdin.on("error", (error) => { failure ??= error; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; appendFileSync(join(root, "host.stderr.log"), chunk); });
child.stdout.setEncoding("utf8").on("data", (chunk) => {
	appendFileSync(join(root, "host.jsonl"), chunk);
	buffer += chunk;
	while (buffer.includes("\n")) {
		const at = buffer.indexOf("\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line)); }
		catch { failure ??= new Error(`Invalid host JSONL: ${line.slice(0, 200)}`); }
		for (const listener of listeners) listener();
	}
});
function bounded(promise, label, ms = 15000) {
	let timer;
	return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded (${ms} ms); stderr=${stderr.slice(-6000)}`)), ms); })]).finally(() => clearTimeout(timer));
}
function wait(predicate, since = 0) {
	let check;
	const pending = new Promise((resolve, reject) => {
		check = () => {
			const event = events.slice(since).find(predicate);
			if (event) resolve(event); else if (failure) reject(failure);
		};
		listeners.add(check); check();
	});
	return bounded(pending, "Host event").finally(() => listeners.delete(check));
}
async function request(type, data = {}) {
	const id = `qualification-${++requestId}`;
	const response = wait((event) => event.type === "response" && event.id === id);
	child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
	const event = await response;
	assert.equal(event.success, true, JSON.stringify(event));
	return event.data;
}
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join("");
async function toolPrompt(message, toolName) {
	const since = events.length;
	await request("prompt", { message });
	const tool = await wait((event) => event.type === "tool_execution_end" && event.toolName === toolName, since);
	assert.equal(tool.isError, false, JSON.stringify(tool));
	await wait((event) => event.type === "agent_settled", since);
	return tool.result;
}
async function completion(runId, status, since) {
	const event = await wait((event) => event.type === "message_end" && event.message?.role === "custom" && textOf(event.message).includes(runId) && textOf(event.message).includes(status), since);
	assert.match(textOf(event.message), /untrusted/i);
	return event;
}
try {
	const commands = await request("get_commands");
	const personaCommand = commands.commands.find((command) => command.name === "persona");
	assert.ok(personaCommand, `Packed extension did not register /persona; stderr=${stderr}`);
	assert.equal(personaCommand.sourceInfo.origin, "package", "Extension bypassed package discovery");
	assert.equal(resolve(personaCommand.sourceInfo.path), resolve(join(packageRoot, "src", "extension.ts")));
	outcome.checks.packedExtensionPath = personaCommand.sourceInfo.path;
	await request("prompt", { message: "/persona package-supervisor" });
	const since = events.length;
	const normal = await toolPrompt("PACKAGE:complete", "delegate");
	assert.ok(normal.details.runId, JSON.stringify(normal));
	const worker = await waitForReceipt(receipts, (row) => row.event === "worker_started" && row.task === "complete", 10000);
	assert.equal(worker.pid === child.pid, engine === "inproc", "Wrong engine process boundary");
	await completion(normal.details.runId, "done", since);
	await toolPrompt(`PACKAGE:result:${normal.details.runId}`, "intercom").then((result) => {
		assert.equal(result.details.status, "done", JSON.stringify(result));
		assert.match(textOf(result), /PACKAGE_WORKER_OK:complete/);
	});
	outcome.checks.completed = true;
	const beforeCancel = events.length;
	const cancel = await toolPrompt("PACKAGE:cancel", "delegate");
	const cancelledWorker = await waitForReceipt(receipts, (row) => row.event === "worker_started" && row.task === "cancel", 10000);
	const stopped = await toolPrompt(`PACKAGE:stop:${cancel.details.runId}`, "intercom");
	assert.equal(stopped.details.ok, true, JSON.stringify(stopped));
	await completion(cancel.details.runId, "stopped", beforeCancel);
	assert.equal((await toolPrompt(`PACKAGE:result:${cancel.details.runId}`, "intercom")).details.status, "stopped");
	if (engine === "child") assert.throws(() => process.kill(cancelledWorker.pid, 0), /ESRCH/, "Stopped child process remains alive");
	else await waitForReceipt(receipts, (row) => row.event === "worker_aborted" && row.task === "cancel", 1000);
	outcome.checks.stop = engine === "child" ? "stopped result + worker process exited" : "stopped result + provider signal aborted";
	await toolPrompt("PACKAGE:shutdown", "delegate");
	await waitForReceipt(receipts, (row) => row.event === "worker_started" && row.task === "shutdown", 10000);
	// Public ExtensionContext shutdown, not SIGTERM/dispose masquerading as orderly teardown.
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/package-qualification-shutdown" })}\n`);
	const exit = await bounded(closed, "Orderly host shutdown");
	assert.equal(exit.code, 0, stderr);
	await waitForReceipt(receipts, (row) => row.event === "session_shutdown" && row.pid === child.pid && row.leg === false, 1000);
	outcome.checks.shutdown = true;
	const rows = (await readFile(receipts, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(rows.some((row) => row.event === "factory" && row.leg && row.disabled === "1" && (engine !== "child" || row.child === "1")), "Delegated-leg marker not observed during real plugin loading");
	assert.ok(rows.filter((row) => row.event === "session_start" && row.leg).every((row) => !row.tools.includes("delegate")), "Fork-bomb guard did not withdraw delegate");
	assert.ok(!rows.some((row) => row.event === "network_blocked"), "Network tripwire fired");
	const guardedPids = new Set(rows.filter((row) => row.event === "network_tripwire_armed").map((row) => row.pid));
	assert.ok(rows.filter((row) => row.event === "factory").every((row) => guardedPids.has(row.pid)), "A host/worker loaded without the network preloader");
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")), {}, "The faux provider must not persist credentials");
	outcome.checks.emptyCredentialStore = true;
	outcome.checks.tripwireProcesses = guardedPids.size;
	// The child engine force-kills a print CLI; a JS abort callback cannot be expected after
	// Windows taskkill. Its process exit and stopped result were both asserted above.
	if (engine === "inproc") assert.ok(rows.some((row) => row.event === "worker_aborted" && row.task === "shutdown"), "Shutdown did not abort in-process work");
	for (const pid of new Set(rows.map((row) => row.pid))) {
		if (pid === process.pid) continue;
		assert.throws(() => process.kill(pid, 0), /ESRCH/, `Host/worker process still alive after shutdown: ${pid}`);
	}
	outcome.checks.delegatedMarkers = true;
	outcome.checks.forkBombGuard = true;
	outcome.checks.processesReaped = true;
	outcome.requests = { faux: rows.filter((row) => row.event === "faux_request").length, network: rows.filter((row) => row.event === "network_blocked").length };
	outcome.checks.workerShutdownEvents = rows.filter((row) => row.event === "session_shutdown" && row.leg).length;
	outcome.auth = "native faux auth in memory; clean temporary CLI credential store";
	outcome.status = "PASS";
} catch (error) {
	outcome.error = error.stack ?? String(error);
	process.exitCode = 1;
} finally {
	if (!ended) {
		child.stdin.end();
		try { await bounded(closed, "Failure-path shutdown", 5000); }
		catch {
			stopQualificationProcessTree(child);
			await bounded(closed, "Forced failure-path shutdown", 5000);
		}
	}
	await writeFile(join(root, "outcome.json"), JSON.stringify(outcome, null, 2));
	process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

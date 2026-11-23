import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startMonitorProcess } from "../../src/monitor/process.ts";
import { MonitorManager, type MonitorEvent, type MonitorProcessHandlers, type MonitorSpec } from "../../src/core/monitor.ts";

function nodeSpec(script: string, mode: MonitorSpec["mode"]): MonitorSpec {
	return {
		command: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		label: "integration",
		mode,
	};
}

function waitForExit(install: (handlers: MonitorProcessHandlers) => void): Promise<{ code: number | null; signal?: string; stdout: string[]; stderr: string[]; errors: Error[] }> {
	return new Promise((resolve) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const errors: Error[] = [];
		install({
			onStdout: (chunk) => stdout.push(chunk),
			onStderr: (chunk) => stderr.push(chunk),
			onExit: (code, signal) => resolve({ code, ...(signal !== undefined ? { signal } : {}), stdout, stderr, errors }),
			onError: (error) => errors.push(error),
		});
	});
}

test("process adapter decodes UTF-8 without splitting process stream chunks", async () => {
	const result = await waitForExit((handlers) => {
		startMonitorProcess(
			nodeSpec(
				"process.stdout.write(Buffer.from([0xf0])); setTimeout(() => { process.stdout.write(Buffer.from([0x9f, 0x8c, 0x99])); process.stdout.write('\\n' + 'x'.repeat(5000) + '\\n'); }, 5)",
				"output",
			),
			handlers,
		);
	});

	assert.equal(result.code, 0);
	assert.deepEqual(result.errors, []);
	const output = result.stdout.join("");
	assert.match(output, /🌙\n/);
	assert.equal(output.split("\n")[1]?.length, 5_000, "the adapter forwards raw decoded chunks; manager bounds semantic lines");
});

test("process adapter forwards decoded stdout and stderr before process exit", async () => {
	const result = await waitForExit((handlers) => {
		startMonitorProcess(
			nodeSpec("process.stdout.write('result'); process.stderr.write('warning'); process.exit(7)", "exit"),
			handlers,
		);
	});

	assert.equal(result.code, 7);
	assert.equal(result.stdout.join(""), "result");
	assert.equal(result.stderr.join(""), "warning");
});

test("process adapter closes optional stdin and drains final output before exit", async () => {
	const result = await waitForExit((handlers) => {
		startMonitorProcess({
			...nodeSpec("process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { process.stdout.write(input); process.stderr.write('final stderr'); })", "exit"),
			stdin: "inline source\nwith newlines",
		}, handlers);
	});
	assert.equal(result.code, 0);
	assert.equal(result.stdout.join(""), "inline source\nwith newlines");
	assert.equal(result.stderr.join(""), "final stderr");
});

test("stop kills a running process and suppresses late callbacks", async () => {
	const events: string[] = [];
	const processHandle = startMonitorProcess(
		nodeSpec("setInterval(() => process.stdout.write('still running\\n'), 5)", "output"),
		{
			onStdout: () => events.push("stdout"),
			onStderr: () => events.push("stderr"),
			onExit: () => events.push("exit"),
			onError: () => events.push("error"),
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	processHandle.stop();
	const before = events.length;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(events.length, before, "callbacks after stop are ignored");
});

test("spawn errors are observable through onError", async () => {
	const errors = await new Promise<Error[]>((resolve) => {
		const seen: Error[] = [];
		startMonitorProcess(
			{
				command: "definitely-not-a-real-monitor-executable",
				args: [],
				cwd: process.cwd(),
				label: "missing",
				mode: "output",
			},
			{
				onStdout: () => {},
				onStderr: () => {},
				onExit: () => resolve(seen),
				onError: (error) => {
					seen.push(error);
					resolve(seen);
				},
			},
		);
	});
	assert.equal(errors.length, 1);
});

test("manager and process adapter deliver a bounded output wake", async () => {
	const event = await new Promise<MonitorEvent>((resolve) => {
		const manager = new MonitorManager({
			now: () => Date.now(),
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			start: startMonitorProcess,
			onEvent: resolve,
		});
		const result = manager.arm({
			...nodeSpec("process.stdout.write('x'.repeat(5000) + '\\n')", "output"),
			maxEvents: 1,
			timeoutMs: 10_000,
		});
		assert.equal(result.ok, true);
	});

	assert.equal(event.kind, "output");
	assert.equal(event.terminal, true);
	assert.equal(event.text.length, 4_000);
});

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A launcher that starts a detached descendant inheriting its stdout/stderr, prints the descendant pid, and exits.
 *  Detached, because Windows ends a plain child together with its launcher, which would close the pipes. */
function launcherSpec(descendantSource: string, mode: MonitorSpec["mode"] = "exit"): MonitorSpec {
	return nodeSpec(
		`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }); child.unref(); console.log('pid:' + child.pid);`,
		mode,
	);
}

const HOLD_OPEN = "setInterval(() => {}, 1000)";

function pidFrom(output: string): number | undefined {
	const match = /pid:(\d+)/.exec(output);
	return match?.[1] ? Number(match[1]) : undefined;
}

function killQuietly(pid: number | undefined): void {
	if (pid === undefined) return;
	try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); });
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function waitForPidDead(pid: number): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (!pidIsAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`descendant process ${pid} remained alive after monitor cancellation`);
}

test("cancellation kills an owned descendant process tree on every platform", async () => {
	let descendantPid: number | undefined;
	let output = "";
	const processHandle = startMonitorProcess(
		nodeSpec(
			"const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); setInterval(() => {}, 100000)",
			"output",
		),
		{
			onStdout: (chunk) => {
				output += chunk;
				const match = /(?:^|\n)(\d+)(?:\n|$)/.exec(output);
				if (match?.[1]) descendantPid = Number(match[1]);
			},
			onStderr: () => {},
			onExit: () => {},
			onError: (error) => assert.fail(`monitor process error: ${error.message}`),
		},
	);
	try {
		for (let i = 0; i < 40 && descendantPid === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(descendantPid !== undefined, `child pid was not reported: ${output}`);
		processHandle.stop();
		await waitForPidDead(descendantPid);
	} finally {
		processHandle.stop();
	}
});

test("the adapter settles on exit while a descendant holds the output pipes, and leaves the descendant running", async () => {
	let descendant: number | undefined;
	try {
		const settled = new Promise<{ code: number | null; lingering: boolean | undefined; stdout: string }>((resolve) => {
			let stdout = "";
			startMonitorProcess(launcherSpec(HOLD_OPEN), {
				onStdout: (chunk) => { stdout += chunk; },
				onStderr: () => {},
				onExit: (code, _signal, lingering) => resolve({ code, lingering, stdout }),
				onError: (error) => assert.fail(error.message),
			});
		});
		const result = await withDeadline(settled, 15_000, "exit with a pipe-holding descendant");
		descendant = pidFrom(result.stdout);
		assert.equal(result.code, 0);
		assert.equal(result.lingering, true);
		assert.ok(descendant !== undefined, `pid line missing from: ${result.stdout}`);
		assert.equal(pidIsAlive(descendant), true, "natural settlement does not kill a survivor");
	} finally {
		killQuietly(descendant);
	}
});

test("nothing is delivered after the drain bound, even while the descendant keeps writing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "monitor-drain-"));
	const marker = join(dir, "wrote-late");
	let descendant: number | undefined;
	try {
		const order: string[] = [];
		let stdout = "";
		const descendantSource = `const fs = require('node:fs'); process.stdout.on('error', () => {}); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('late-output'); }, 1500); setInterval(() => {}, 1000)`;
		const settled = new Promise<void>((resolve) => {
			startMonitorProcess(launcherSpec(descendantSource), {
				onStdout: (chunk) => { stdout += chunk; order.push("stdout"); },
				onStderr: () => order.push("stderr"),
				onExit: () => { order.push("exit"); resolve(); },
				onError: (error) => assert.fail(error.message),
			});
		});
		await withDeadline(settled, 15_000, "exit with a pipe-holding descendant");
		descendant = pidFrom(stdout);
		for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(existsSync(marker), true, "the descendant never reached its late write");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(order.at(-1), "exit", `callbacks arrived after exit: ${order.join(",")}`);
		assert.equal(stdout.includes("late-output"), false);
	} finally {
		killQuietly(descendant);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an ordinary exit is not lingering", async () => {
	const lingering = await new Promise<boolean | undefined>((resolve) => {
		startMonitorProcess(nodeSpec("process.stdout.write('ok'); process.exit(7)", "exit"), {
			onStdout: () => {},
			onStderr: () => {},
			onExit: (_code, _signal, flag) => resolve(flag),
			onError: (error) => assert.fail(error.message),
		});
	});
	assert.ok(!lingering);
});

test("a lingering exit releases the pipes so the owning process can end by itself", async () => {
	const processUrl = pathToFileURL(join(process.cwd(), "src/monitor/process.ts")).href;
	const launcher = launcherSpec(HOLD_OPEN);
	const program = `const { startMonitorProcess } = await import(${JSON.stringify(processUrl)}); let out = ''; startMonitorProcess(${JSON.stringify(launcher)}, { onStdout: (c) => { out += c; }, onStderr: () => {}, onError: (e) => { console.error(e.message); process.exit(2); }, onExit: () => { console.log(out); } });`;
	const run = await new Promise<{ stdout: string; error: Error | null }>((resolve) => {
		execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { timeout: 20_000, cwd: process.cwd() }, (error, stdout) => resolve({ stdout: String(stdout), error }));
	});
	killQuietly(pidFrom(run.stdout));
	assert.equal(run.error, null, `the process kept running after a lingering exit: ${run.error?.message}`);
	assert.ok(pidFrom(run.stdout) !== undefined, run.stdout);
});

/** Runs a host process that arms `launcher`, stops it `stopDelayMs` after the descendant pid line arrives, and
 *  does nothing else: it can only end by itself when stop() released every pipe and timer. */
async function runStoppedHost(launcher: MonitorSpec, stopDelayMs: number): Promise<{ stdout: string; error: Error | null; lateCallbacks: number | undefined }> {
	const processUrl = pathToFileURL(join(process.cwd(), "src/monitor/process.ts")).href;
	const program = `const fs = await import('node:fs'); const { startMonitorProcess } = await import(${JSON.stringify(processUrl)}); let out = ''; let stopped = false; let late = 0; const note = () => { if (stopped) late++; }; const handle = startMonitorProcess(${JSON.stringify(launcher)}, { onStdout: (c) => { note(); out += c; if (!stopped && /pid:\\d+/.test(out)) { fs.writeSync(1, out); setTimeout(() => { handle.stop(); stopped = true; }, ${stopDelayMs}); } }, onStderr: note, onError: (e) => { note(); fs.writeSync(2, e.message); }, onExit: note }); process.on('exit', () => fs.writeSync(1, '\\nlate:' + late));`;
	const run = await new Promise<{ stdout: string; error: Error | null }>((resolve) => {
		execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { timeout: 20_000, cwd: process.cwd() }, (error, stdout) => resolve({ stdout: String(stdout), error }));
	});
	const late = /late:(\d+)/.exec(run.stdout);
	return { ...run, lateCallbacks: late?.[1] === undefined ? undefined : Number(late[1]) };
}

test("stop() inside the drain window releases the pipes so the owning process can end by itself", async () => {
	let descendant: number | undefined;
	try {
		const run = await runStoppedHost(launcherSpec(HOLD_OPEN), 100);
		descendant = pidFrom(run.stdout);
		assert.equal(run.error, null, `the process kept running after stop(): ${run.error?.message}`);
		assert.ok(descendant !== undefined, run.stdout);
		assert.equal(run.lateCallbacks, 0, "no callback may fire after stop()");
	} finally {
		killQuietly(descendant);
	}
});

test("stop() while the launcher is alive and a descendant holds the pipes lets the owning process end by itself", async () => {
	let descendant: number | undefined;
	try {
		const launcher = nodeSpec(
			`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(HOLD_OPEN)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }); child.unref(); console.log('pid:' + child.pid); setInterval(() => {}, 1000)`,
			"exit",
		);
		const run = await runStoppedHost(launcher, 0);
		descendant = pidFrom(run.stdout);
		assert.equal(run.error, null, `the process kept running after stop(): ${run.error?.message}`);
		assert.ok(descendant !== undefined, run.stdout);
		assert.equal(run.lateCallbacks, 0, "no callback may fire after stop()");
	} finally {
		killQuietly(descendant);
	}
});

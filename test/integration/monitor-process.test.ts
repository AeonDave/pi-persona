import { test } from "node:test";
import assert from "node:assert/strict";

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

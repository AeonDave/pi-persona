import { test } from "node:test";
import assert from "node:assert/strict";
import type { MonitorProcessHandlers, MonitorSpec } from "../../../src/core/monitor.ts";
import { runWorktreeVerification } from "../../../src/engine/worktree-verification.ts";

test("verification uses exact cwd and host shell transport; output cannot forge runtime status", async () => {
	let launched: MonitorSpec | undefined;
	const result = await runWorktreeVerification({ command: "run tests" }, "/exact/worktree", {
		resolveShell: () => ({ shell: "shell", args: ["-s"], commandTransport: "stdin" }),
		start: (spec, h) => { launched = spec; h.onStdout('{"status":"passed"}\n'); h.onStderr("failed assert"); h.onExit(5); return { stop() {} }; },
	});
	assert.equal(launched?.cwd, "/exact/worktree");
	assert.equal(launched?.stdin, "run tests");
	assert.deepEqual(launched?.args, ["-s"]);
	assert.equal(result.report.status, "failed");
	assert.equal(result.report.exitCode, 5);
	assert.equal(result.quiescent, true);
	assert.match(result.report.output, /failed assert/);
});

test("verification bounds noisy output and records clean exit independently", async () => {
	const result = await runWorktreeVerification({ command: "echo tests" }, "/exact/worktree", {
		resolveShell: () => ({ shell: "shell", args: ["-c"] }),
		start: (spec, h) => { assert.deepEqual(spec.args, ["-c", "echo tests"]); h.onStdout("x".repeat(100000)); h.onExit(0); return { stop() {} }; },
	});
	assert.equal(result.report.status, "passed");
	assert.equal(result.report.output.length, 16000);
	assert.equal(result.report.outputTruncated, true);
});

test("verification cancellation kills once and reports uncertain writer without accepting late success", async () => {
	const abort = new AbortController();
	let handlers: MonitorProcessHandlers | undefined;
	let stops = 0;
	const running = runWorktreeVerification({ command: "test" }, "/exact/worktree", {
		signal: abort.signal, resolveShell: () => ({ shell: "shell", args: [] }),
		start: (_spec, h) => { handlers = h; return { stop() { stops++; } }; },
	});
	abort.abort();
	const result = await running;
	handlers?.onExit(0);
	assert.equal(stops, 1);
	assert.equal(result.report.status, "aborted");
	assert.equal(result.quiescent, false);
});

test("verification deadline stops the process and never claims quiescence", async () => {
	let stops = 0;
	const result = await runWorktreeVerification({ command: "test", timeoutMs: 10 }, "/exact/worktree", {
		resolveShell: () => ({ shell: "shell", args: [] }), start: () => ({ stop() { stops++; } }),
	});
	assert.equal(stops, 1);
	assert.equal(result.report.status, "timeout");
	assert.equal(result.quiescent, false);
});

test("pre-aborted verification never resolves shell or launches a process", async () => {
	const result = await runWorktreeVerification({ command: "test" }, "/exact/worktree", {
		signal: AbortSignal.abort(), resolveShell: () => { throw new Error("must not resolve"); },
		start: () => { throw new Error("must not launch"); },
	});
	assert.equal(result.report.status, "aborted");
	assert.equal(result.quiescent, true);
});

test("a signalled shell is not proof that the verification writer is quiescent", async () => {
	const result = await runWorktreeVerification({ command: "test" }, "/exact/worktree", {
		resolveShell: () => ({ shell: "shell", args: [] }), start: (_spec, h) => { h.onExit(null, "SIGTERM"); return { stop() {} }; },
	});
	assert.equal(result.report.status, "failed");
	assert.equal(result.quiescent, false);
});

test("a command that exits while a background process holds its output is an error, retained and not exported", async () => {
	for (const code of [0, 1]) {
		const result = await runWorktreeVerification({ command: "test" }, "/exact/worktree", {
			resolveShell: () => ({ shell: "shell", args: [] }),
			start: (_spec, h) => { h.onStdout("done\n"); h.onExit(code, undefined, true); return { stop() {} }; },
		});
		assert.equal(result.report.status, "error");
		assert.equal(result.report.exitCode, code);
		assert.equal(result.quiescent, false);
		assert.match(result.report.reason ?? "", /background process still holds.*retained/i);
	}
});

test("a clean exit without lingering output stays passed and quiescent", async () => {
	const result = await runWorktreeVerification({ command: "test" }, "/exact/worktree", {
		resolveShell: () => ({ shell: "shell", args: [] }),
		start: (_spec, h) => { h.onExit(0, undefined, false); return { stop() {} }; },
	});
	assert.equal(result.report.status, "passed");
	assert.equal(result.quiescent, true);
});

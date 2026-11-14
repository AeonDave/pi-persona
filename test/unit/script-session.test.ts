import assert from "node:assert/strict";
import { test } from "node:test";
import { createScriptSession } from "../../src/script/session.ts";
import { MonitorArchive, SCRIPT_LOG_ENTRY } from "../../src/monitor/archive.ts";

test("scripts retain separate bounded logs and wake only on exit", async () => {
	const handlers: any[] = [];
	const messages: string[] = [];
	const writes: any[] = [];
	const archive = new MonitorArchive({ source: "script", entries: () => [], append: (customType, data) => writes.push({ customType, data }) });
	const session = createScriptSession({
		isIdle: () => true, canRun: () => true, deliver: (text) => messages.push(text),
		start: (_spec, callbacks) => { handlers.push(callbacks); return { stop() {} }; },
		observe: { armed: (entry) => archive.armed(entry), output: (output) => archive.output(output), event: (event) => archive.event(event), removed: (entry, reason) => archive.removed(entry, reason) },
	});
	try {
		const result = session.arm({ command: "node", args: ["-e", "console.log('ok')"], label: "build", cwd: ".", mode: "exit" });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.match(result.entry.id, /^script-/);
		handlers[0].onStdout("first\n");
		await session.flush();
		assert.equal(messages.length, 0);
		handlers[0].onStderr("warning\n");
		handlers[0].onExit(7);
		await session.flush();
		assert.equal(messages.length, 1);
		assert.match(messages[0]!, /Script events/);
		assert.match(messages[0]!, /exit code 7/);
		assert.match(messages[0]!, /untrusted/);
		assert.equal(writes[0].customType, SCRIPT_LOG_ENTRY);
		assert.equal(archive.result(result.entry.id)?.stderr, "warning\n");
		assert.equal(session.list().length, 0);
	} finally { session.cancelAll(); }
});

test("script permission loss and shutdown cancel owned processes and queued completions", async () => {
	for (const shutdown of [false, true]) {
		let allowed = true;
		let stopped = 0;
		const messages: string[] = [];
		const handlers: any[] = [];
		const session = createScriptSession({ isIdle: () => false, canRun: () => allowed, deliver: (text) => messages.push(text), start: (_spec, callbacks) => { handlers.push(callbacks); return { stop: () => stopped++ }; } });
		try {
			session.arm({ command: "node", label: "queued", cwd: ".", mode: "exit" });
			handlers[0].onExit(0);
			session.arm({ command: "node", label: "running", cwd: ".", mode: "exit" });
			if (shutdown) session.cancelAll();
			else { allowed = false; session.reconcilePermissions(); }
			assert.equal(stopped, 2);
			assert.equal(session.pendingCount(), 0);
			assert.equal(session.list().length, 0);
			await session.flush();
			assert.equal(messages.length, 0);
		} finally { session.cancelAll(); }
	}
});

test("script logs hydrate only their own archive namespace", () => {
	const writes: any[] = [];
	const script = new MonitorArchive({ source: "script", entries: () => [], append: (customType, data) => writes.push({ type: "custom", customType, data }) });
	const entry = { id: "script-1", label: "job", command: "node", args: [], cwd: ".", mode: "exit" as const, maxEvents: 1, startedAtEpochMs: 0, expiresAtEpochMs: 1000 };
	script.armed(entry); script.removed(entry, { kind: "cancelled" });
	assert.equal(new MonitorArchive({ source: "script", entries: () => writes, append() {} }).list().length, 1);
	assert.equal(new MonitorArchive({ entries: () => writes, append() {} }).list().length, 0);
});

test("synchronous script startup failures are errors, never cancellations or duplicate wakes", async () => {
	for (const callbackFailure of [false, true]) {
		const archive = new MonitorArchive({ source: "script", entries: () => [], append() {} });
		const messages: string[] = [];
		const session = createScriptSession({
			isIdle: () => true, canRun: () => true, deliver: (text) => messages.push(text),
			start: (_spec, handlers) => { if (callbackFailure) { handlers.onError(new Error("cannot start")); return { stop() {} }; } throw new Error("cannot start"); },
			observe: { armed: (entry) => archive.armed(entry), event: (event) => archive.event(event), removed: (entry, reason) => archive.removed(entry, reason) },
		});
		try {
			const result = session.arm({ command: "node", cwd: ".", label: "fail", mode: "exit" });
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /could not start script/);
			const record = archive.list()[0];
			assert.equal(record?.outcome, "error");
			assert.match(record?.text ?? "", /cannot start/);
			await session.flush();
			assert.equal(messages.length, 0);
		} finally { session.cancelAll(); }
	}
});

test("script admission diagnostics identify scripts and keep their independent capacity bounded", () => {
	const session = createScriptSession({ isIdle: () => false, canRun: () => true, deliver() {}, start: () => ({ stop() {} }) });
	try {
		const invalid = session.arm({ command: "", label: "bad", cwd: ".", mode: "exit" });
		if (invalid.ok) assert.fail("invalid command was admitted");
		assert.match(invalid.error, /^script command/);
		for (let i = 0; i < 8; i++) assert.equal(session.arm({ command: "node", label: "job", cwd: ".", mode: "exit" }).ok, true);
		const overflow = session.arm({ command: "node", label: "extra", cwd: ".", mode: "exit" });
		if (overflow.ok) assert.fail("script capacity was exceeded");
		assert.match(overflow.error, /too many active scripts/);
	} finally { session.cancelAll(); }
});

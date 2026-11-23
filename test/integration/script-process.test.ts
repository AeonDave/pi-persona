import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MonitorArchive } from "../../src/monitor/archive.ts";
import { createScriptSession } from "../../src/script/session.ts";
import { registerScriptTool } from "../../src/tools/script.ts";
import type { MonitorEvent } from "../../src/core/monitor.ts";

function harness() {
	const messages: string[] = [];
	const archive = new MonitorArchive({ source: "script", entries: () => [], append() {} });
	let settle!: (event: MonitorEvent) => void;
	const terminal = new Promise<MonitorEvent>((resolve) => { settle = resolve; });
	const session = createScriptSession({
		canRun: () => true, isIdle: () => true, deliver: (text) => messages.push(text),
		observe: {
			armed: (entry) => archive.armed(entry), output: (chunk) => archive.output(chunk),
			event: (event) => { archive.event(event); if (event.terminal) settle(event); },
			removed: (entry, reason) => archive.removed(entry, reason),
		},
	});
	return { session, archive, messages, terminal };
}

test("a real async script preserves stdout/stderr and a nonzero exit after its tool receipt", async () => {
	const h = harness();
	try {
		const result = h.session.arm({ command: process.execPath, args: ["-e", "setTimeout(() => { process.stdout.write('final stdout'); process.stderr.write('final stderr'); process.exitCode = 7; }, 20)"], cwd: process.cwd(), label: "nonzero", mode: "exit" });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(h.archive.result(result.entry.id)?.outcome, "running");
		const event = await h.terminal;
		assert.equal(event.kind, "exit");
		await h.session.flush();
		assert.equal(h.messages.length, 1);
		const record = h.archive.result(result.entry.id);
		assert.equal(record?.stdout, "final stdout");
		assert.equal(record?.stderr, "final stderr");
		assert.match(record?.text ?? "", /exit code 7/);
	} finally { h.session.cancelAll(); }
});

test("inline script source uses the real host shell and gets one automatic completion", async () => {
	const h = harness();
	let tool: any;
	registerScriptTool({ registerTool: (value: any) => { tool = value; }, getSettings: () => ({}) } as ExtensionAPI, { lastCtx: undefined, scripts: h.session, archive: h.archive, canRun: () => true });
	try {
		const result = await tool.execute("call", { action: "run", code: "printf 'inline source finished'", label: "inline" }, undefined, undefined, { cwd: process.cwd(), hasUI: true });
		assert.equal(result.details.ok, true, result.content[0].text);
		await h.terminal;
		await h.session.flush();
		assert.equal(h.messages.length, 1);
		assert.equal(h.archive.result(result.details.id)?.stdout, "inline source finished");
	} finally { h.session.cancelAll(); }
});

test("spawn errors and deadlines settle script history with one failure completion", async () => {
	for (const timeout of [false, true]) {
		const h = harness();
		try {
			const result = h.session.arm({ command: timeout ? process.execPath : "definitely-not-an-installed-script-executable", args: timeout ? ["-e", "setInterval(() => {}, 10000)"] : [], cwd: process.cwd(), label: "failure", mode: "exit", timeoutMs: 1000 });
			assert.equal(result.ok, true);
			if (!result.ok) return;
			const event = await h.terminal;
			assert.equal(event.kind, timeout ? "timeout" : "error");
			await h.session.flush();
			assert.equal(h.messages.length, 1);
			assert.equal(h.archive.result(result.entry.id)?.outcome, event.kind);
			assert.equal(h.session.list().length, 0);
		} finally { h.session.cancelAll(); }
	}
});

test("a script whose command leaves a background process holding its output settles at the command exit", async () => {
	const h = harness();
	let descendant: number | undefined;
	try {
		const source = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }); child.unref(); console.log('pid:' + child.pid);";
		const result = h.session.arm({ command: process.execPath, args: ["-e", source], cwd: process.cwd(), label: "background", mode: "exit", timeoutMs: 30_000 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const event = await Promise.race([h.terminal, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("script did not settle at its exit")), 15_000).unref())]);
		const record = h.archive.result(result.entry.id);
		descendant = Number(/pid:(\d+)/.exec(record?.stdout ?? "")?.[1]);
		assert.equal(event.kind, "exit");
		assert.equal(record?.outcome, "exit");
		assert.match(record?.text ?? "", /a background process still holds its output; output after exit is not captured/);
	} finally {
		if (descendant) try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
		h.session.cancelAll();
	}
});

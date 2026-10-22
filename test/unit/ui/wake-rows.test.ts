import { test } from "node:test";
import assert from "node:assert/strict";

import type { MonitorEntry, MonitorEvent } from "../../../src/core/monitor.ts";
import type { TimerEntry } from "../../../src/core/timer.ts";
import { AgentTree } from "../../../src/ui/agent-tree.ts";
import { WakeRows, wakeNodeId } from "../../../src/ui/wake-rows.ts";

const ARMED = 1_700_000_000_000;
const DEADLINE = ARMED + 600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function exitEntry(over: Partial<MonitorEntry> = {}): MonitorEntry {
	return {
		id: "monitor-2",
		label: "wait for build",
		command: "npm",
		args: ["run", "build"],
		cwd: "/work/app",
		mode: "exit",
		startedAtEpochMs: ARMED,
		expiresAtEpochMs: DEADLINE,
		maxEvents: 1,
		...over,
	};
}

function outputEntry(over: Partial<MonitorEntry> = {}): MonitorEntry {
	return exitEntry({ id: "monitor-3", label: "tail deploy log", command: "tail", args: ["-f", "deploy.log"], mode: "output", maxEvents: 5, ...over });
}

function event(over: Partial<MonitorEvent> = {}): MonitorEvent {
	return { id: "monitor-3", label: "tail deploy log", kind: "output", atEpochMs: ARMED + 1_000, text: "ready", terminal: false, ...over };
}

function timerEntry(over: Partial<TimerEntry> = {}): TimerEntry {
	return { id: "timer-1", label: "status review", fireAtEpochMs: ARMED + 3_600_000, armedAtEpochMs: ARMED, message: "check the deploy", ...over };
}

test("wakeNodeId namespaces monitor and timer rows", () => {
	assert.equal(wakeNodeId("monitor", "monitor-2"), "monitor:monitor-2");
	assert.equal(wakeNodeId("timer", "timer-7"), "timer:timer-7");
});

test("monitorArmed (exit mode) shapes the row and the drill-in description", () => {
	const row = new WakeRows().monitorArmed(exitEntry());
	assert.deepEqual(row, {
		id: "monitor:monitor-2",
		label: "wait for build",
		kind: "monitor",
		status: "running",
		detail: "monitor-2 · exit",
		startedAt: ARMED,
		lastAdvanceAt: ARMED,
		dueAt: DEADLINE,
		output: [
			"monitor-2 · exit mode",
			"command: npm run build",
			"cwd: /work/app",
			`armed ${iso(ARMED)} · deadline ${iso(DEADLINE)}`,
		].join("\n"),
	});
});

test("monitorArmed (output mode) adds the events counter line", () => {
	const row = new WakeRows().monitorArmed(outputEntry());
	assert.equal(row.id, "monitor:monitor-3");
	assert.equal(row.detail, "monitor-3 · output");
	assert.equal(row.dueAt, DEADLINE);
	assert.equal(row.startedAt, ARMED);
	assert.equal(row.lastAdvanceAt, ARMED);
	assert.equal(
		row.output,
		[
			"monitor-3 · output mode",
			"command: tail -f deploy.log",
			"cwd: /work/app",
			`armed ${iso(ARMED)} · deadline ${iso(DEADLINE)}`,
			"events: 0/5",
		].join("\n"),
	);
});

test("monitorArmed omits the trailing space when there are no args", () => {
	const row = new WakeRows().monitorArmed(exitEntry({ command: "ls", args: [] }));
	assert.match(row.output ?? "", /^command: ls$/m);
});

test("monitorArmed clamps the command line to 2000 chars with a trailing ellipsis", () => {
	const args = [0, 1, 2].map(() => "a".repeat(8_000));
	const row = new WakeRows().monitorArmed(exitEntry({ command: "node", args }));
	const commandLine = (row.output ?? "").split("\n").find((line) => line.startsWith("command: "));
	assert.ok(commandLine);
	assert.equal(commandLine.length, 2_000);
	assert.ok(commandLine.endsWith("…"));
	assert.ok(commandLine.startsWith("command: node aaaa"));
	// The clamp never swallows the other lines.
	assert.match(row.output ?? "", /^cwd: \/work\/app$/m);
	assert.match(row.output ?? "", /^armed .* · deadline /m);
});

test("a non-finite timestamp renders as ? instead of throwing", () => {
	const rows = new WakeRows();
	const monitor = rows.monitorArmed(exitEntry({ expiresAtEpochMs: Number.NaN }));
	assert.match(monitor.output ?? "", new RegExp(`armed ${iso(ARMED)} · deadline \\?$`, "m"));
	const infinite = rows.monitorArmed(exitEntry({ id: "monitor-9", startedAtEpochMs: Number.POSITIVE_INFINITY }));
	assert.match(infinite.output ?? "", /armed \? · deadline /);
	const tooBig = rows.monitorArmed(exitEntry({ id: "monitor-10", expiresAtEpochMs: 8.64e15 + 1 }));
	assert.match(tooBig.output ?? "", /deadline \?$/m);
	const timer = rows.timerArmed(timerEntry({ fireAtEpochMs: Number.NaN }));
	assert.match(timer.output ?? "", /^timer-1 · fires \? \(armed /);
	rows.monitorArmed(outputEntry());
	const stamped = rows.monitorEvent(event({ atEpochMs: Number.NaN }));
	assert.match(stamped.patch.output ?? "", /^\[\?\] ready$/m);
});

test("monitorEvent (output) bumps the counter and appends the event line", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry());
	const first = rows.monitorEvent(event({ atEpochMs: ARMED + 1_000, text: "build started\nsecond line" }));
	assert.equal(first.id, "monitor:monitor-3");
	assert.equal(first.settled, false);
	assert.equal("status" in first.patch, false);
	assert.equal(first.patch.lastAdvanceAt, ARMED + 1_000);
	assert.equal(first.patch.detail, "monitor-3 · output · 1/5 events");
	assert.equal(
		first.patch.output,
		[
			"monitor-3 · output mode",
			"command: tail -f deploy.log",
			"cwd: /work/app",
			`armed ${iso(ARMED)} · deadline ${iso(DEADLINE)}`,
			"events: 1/5",
			`[${iso(ARMED + 1_000)}] build started`,
		].join("\n"),
	);

	const second = rows.monitorEvent(event({ atEpochMs: ARMED + 2_000, text: "build finished" }));
	assert.equal(second.patch.detail, "monitor-3 · output · 2/5 events");
	const lines = (second.patch.output ?? "").split("\n");
	assert.equal(lines.filter((line) => line.startsWith("events:")).length, 1, "the events line is replaced, never duplicated");
	assert.deepEqual(lines.slice(-3), ["events: 2/5", `[${iso(ARMED + 1_000)}] build started`, `[${iso(ARMED + 2_000)}] build finished`]);
});

test("monitorEvent clamps a long event line to 1000 chars", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry());
	const result = rows.monitorEvent(event({ text: "x".repeat(4_000) }));
	const eventLine = (result.patch.output ?? "").split("\n").pop() ?? "";
	const prefix = `[${iso(ARMED + 1_000)}] `;
	assert.ok(eventLine.startsWith(prefix));
	const body = eventLine.slice(prefix.length);
	assert.equal(body.length, 1_000);
	assert.ok(body.endsWith("…"));
});

test("monitorEvent keeps only the last 40 event lines, in order", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry({ maxEvents: 100 }));
	let last: ReturnType<WakeRows["monitorEvent"]> | undefined;
	for (let i = 0; i < 60; i++) {
		last = rows.monitorEvent(event({ atEpochMs: ARMED + i * 1_000, text: `line ${i}` }));
	}
	assert.ok(last);
	assert.equal(last.settled, false);
	assert.equal(last.patch.detail, "monitor-3 · output · 60/100 events");
	const lines = (last.patch.output ?? "").split("\n");
	const eventsAt = lines.indexOf("events: 60/100");
	assert.equal(eventsAt, 4, "description lines stay intact above the counter");
	const kept = lines.slice(eventsAt + 1);
	const expected = Array.from({ length: 40 }, (_, k) => `[${iso(ARMED + (k + 20) * 1_000)}] line ${k + 20}`);
	assert.deepEqual(kept, expected);
	assert.equal(lines.includes(`[${iso(ARMED + 19 * 1_000)}] line 19`), false);
});

test("monitorEvent terminal outcomes map to done/failed and settle the row", () => {
	const cases: Array<{ name: string; entry: MonitorEntry; event: MonitorEvent; status: "done" | "failed"; detail: string }> = [
		{
			name: "exit 0",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "exit", text: "process exited with exit code 0", terminal: true }),
			status: "done",
			detail: "monitor-2 · process exited with exit code 0",
		},
		{
			name: "exit 1",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "exit", text: "process exited with exit code 1\nstderr:\nboom", terminal: true }),
			status: "failed",
			detail: "monitor-2 · process exited with exit code 1",
		},
		{
			name: "killed by signal",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "exit", text: "process exited by SIGTERM", terminal: true }),
			status: "failed",
			detail: "monitor-2 · process exited by SIGTERM",
		},
		{
			name: "diagnostics that mention exit code 0 do not turn a failure into a success",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "exit", text: "process exited with exit code 2\nstdout:\nchild reported exit code 0", terminal: true }),
			status: "failed",
			detail: "monitor-2 · process exited with exit code 2",
		},
		{
			name: "timeout",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "timeout", text: "monitor timed out after 600000ms", terminal: true }),
			status: "failed",
			detail: "monitor-2 · monitor timed out after 600000ms",
		},
		{
			name: "error",
			entry: exitEntry(),
			event: event({ id: "monitor-2", kind: "error", text: "monitor process error: spawn ENOENT", terminal: true }),
			status: "failed",
			detail: "monitor-2 · monitor process error: spawn ENOENT",
		},
		{
			name: "max events reached",
			entry: outputEntry({ maxEvents: 1 }),
			event: event({ terminal: true, text: "all green" }),
			status: "done",
			detail: "monitor-3 · 1/1 events · watch ended",
		},
	];
	for (const c of cases) {
		const rows = new WakeRows();
		rows.monitorArmed(c.entry);
		const result = rows.monitorEvent(c.event);
		assert.equal(result.settled, true, c.name);
		assert.equal(result.patch.status, c.status, c.name);
		assert.equal(result.patch.detail, c.detail, c.name);
		assert.equal(result.patch.lastAdvanceAt, c.event.atEpochMs, c.name);
		assert.equal(result.id, wakeNodeId("monitor", c.event.id), c.name);
	}
});

test("a terminal event shows why the watch ended in the drill-in, once", () => {
	const rows = new WakeRows();
	rows.monitorArmed(exitEntry());
	const ended = rows.monitorEvent(event({ id: "monitor-2", kind: "exit", atEpochMs: ARMED + 5_000, text: "process exited with exit code 0\nstdout:\ndone", terminal: true }));
	const lines = (ended.patch.output ?? "").split("\n");
	assert.equal(lines.at(-1), `[${iso(ARMED + 5_000)}] process exited with exit code 0`);
	assert.equal(lines.some((line) => line.startsWith("events:")), false, "exit mode has no events counter");

	const out = new WakeRows();
	out.monitorArmed(outputEntry({ maxEvents: 2 }));
	out.monitorEvent(event({ atEpochMs: ARMED + 1_000, text: "one" }));
	const final = out.monitorEvent(event({ atEpochMs: ARMED + 2_000, text: "two", terminal: true }));
	const finalLines = (final.patch.output ?? "").split("\n");
	assert.deepEqual(finalLines.slice(-3), ["events: 2/2", `[${iso(ARMED + 1_000)}] one`, `[${iso(ARMED + 2_000)}] two`]);
});

test("a long terminal summary is clamped to 120 chars", () => {
	const rows = new WakeRows();
	rows.monitorArmed(exitEntry());
	const result = rows.monitorEvent(event({ id: "monitor-2", kind: "error", text: `monitor process error: ${"z".repeat(500)}`, terminal: true }));
	const summary = (result.patch.detail ?? "").slice("monitor-2 · ".length);
	assert.equal(summary.length, 120);
	assert.ok(summary.endsWith("…"));
});

test("a non-terminal event is not settled and carries no status", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry());
	const result = rows.monitorEvent(event());
	assert.equal(result.settled, false);
	assert.equal("status" in result.patch, false);
});

test("a terminal event forgets the remembered state", () => {
	const rows = new WakeRows();
	rows.monitorArmed(exitEntry());
	rows.monitorEvent(event({ id: "monitor-2", kind: "exit", text: "process exited with exit code 0", terminal: true }));
	const stray = rows.monitorEvent(event({ id: "monitor-2", text: "late" }));
	assert.equal("output" in stray.patch, false);
});

test("an event for an id that was never armed does not throw", () => {
	const rows = new WakeRows();
	const live = rows.monitorEvent(event({ id: "monitor-42", text: "hello" }));
	assert.equal(live.id, "monitor:monitor-42");
	assert.equal(live.settled, false);
	assert.equal("output" in live.patch, false);
	assert.equal(live.patch.detail, "monitor-42 · output · 1/? events");

	const ended = rows.monitorEvent(event({ id: "monitor-42", terminal: true, text: "bye" }));
	assert.equal(ended.settled, true);
	assert.equal(ended.patch.status, "done");
	assert.equal(ended.patch.detail, "monitor-42 · 1/? events · watch ended");
	assert.equal("output" in ended.patch, false);

	const exited = rows.monitorEvent(event({ id: "monitor-43", kind: "exit", terminal: true, text: "process exited with exit code 3" }));
	assert.equal(exited.patch.status, "failed");
	assert.equal(exited.patch.detail, "monitor-43 · process exited with exit code 3");
});

test("monitorRemoved settles the row as cancelled and forgets the state", () => {
	const rows = new WakeRows();
	const entry = outputEntry();
	rows.monitorArmed(entry);
	rows.monitorEvent(event({ text: "one" }));
	assert.deepEqual(rows.monitorRemoved(entry), {
		id: "monitor:monitor-3",
		patch: { status: "stopped", detail: "monitor-3 · cancelled" },
	});
	const stray = rows.monitorEvent(event({ text: "after removal" }));
	assert.equal("output" in stray.patch, false, "no lines are appended once the state is forgotten");
});

test("timerArmed shapes a labelled alarm with detail = id", () => {
	const row = new WakeRows().timerArmed(timerEntry());
	assert.deepEqual(row, {
		id: "timer:timer-1",
		label: "status review",
		kind: "timer",
		status: "running",
		detail: "timer-1",
		startedAt: ARMED,
		lastAdvanceAt: ARMED,
		dueAt: ARMED + 3_600_000,
		output: `timer-1 · fires ${iso(ARMED + 3_600_000)} (armed ${iso(ARMED)})\nmessage: check the deploy`,
	});
});

test("timerArmed omits detail when the label is already the id", () => {
	const row = new WakeRows().timerArmed(timerEntry({ label: "timer-1" }));
	assert.equal("detail" in row, false);
	assert.equal(row.label, "timer-1");
});

test("timerArmed keeps the (long) message in output only", () => {
	const message = "m".repeat(4_000);
	const row = new WakeRows().timerArmed(timerEntry({ message }));
	assert.ok((row.output ?? "").endsWith(`message: ${message}`));
	assert.equal(row.label, "status review");
	assert.equal(row.detail, "timer-1");
});

test("timerFired and timerCancelled settle the row", () => {
	const rows = new WakeRows();
	const entry = timerEntry();
	assert.deepEqual(rows.timerFired(entry), {
		id: "timer:timer-1",
		patch: { status: "done", detail: "timer-1 · fired" },
	});
	assert.deepEqual(rows.timerCancelled(entry), {
		id: "timer:timer-1",
		patch: { status: "stopped", detail: "timer-1 · cancelled" },
	});
});

test("rows drive the AgentTree end to end", () => {
	const tree = new AgentTree(() => ARMED);
	const rows = new WakeRows();
	const entry = outputEntry({ maxEvents: 2 });
	tree.add(rows.monitorArmed(entry));
	tree.add(rows.timerArmed(timerEntry()));

	const mid = rows.monitorEvent(event({ atEpochMs: ARMED + 1_000, text: "first" }));
	tree.update(mid.id, mid.patch);
	const armedNode = tree.snapshot().find((n) => n.id === "monitor:monitor-3");
	assert.equal(armedNode?.kind, "monitor");
	assert.equal(armedNode?.dueAt, DEADLINE);
	assert.equal(armedNode?.status, "running");
	assert.equal(armedNode?.detail, "monitor-3 · output · 1/2 events");
	assert.equal(armedNode?.lastAdvanceAt, ARMED + 1_000);

	const end = rows.monitorEvent(event({ atEpochMs: ARMED + 2_000, text: "second", terminal: true }));
	tree.update(end.id, end.patch);
	assert.equal(tree.snapshot().find((n) => n.id === "monitor:monitor-3")?.status, "done");

	const fired = rows.timerFired(timerEntry());
	tree.update(fired.id, fired.patch);
	const timerNode = tree.snapshot().find((n) => n.id === "timer:timer-1");
	assert.equal(timerNode?.status, "done");
	assert.equal(timerNode?.detail, "timer-1 · fired");
});

test("timerArmed clamps a runaway label to 120 chars ending in an ellipsis", () => {
	const label = "L".repeat(1_000);
	const row = new WakeRows().timerArmed(timerEntry({ label }));
	assert.equal(row.label.length, 120);
	assert.ok(row.label.endsWith("…"));
	assert.equal(row.label, `${"L".repeat(119)}…`);
	assert.equal(row.detail, "timer-1", "an over-long label is still not the id, so the id stays as the detail");
});

test("timerArmed keeps a label of exactly 120 chars verbatim", () => {
	const label = "k".repeat(120);
	assert.equal(new WakeRows().timerArmed(timerEntry({ label })).label, label);
});

// ── per-line sanitisation: every stored line must be self-contained BEFORE the lines are joined ────

/** The event lines of a drill-in buffer: everything after the `events:` counter. */
function eventLines(output: string | undefined): string[] {
	const lines = (output ?? "").split("\n");
	return lines.slice(lines.findIndex((line) => line.startsWith("events:")) + 1);
}

test("a child line with a bare CR cannot forge a second pi-persona event line", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry());
	const forged = "real line\r[2026-10-22T09:59:59.000Z] BUILD SUCCEEDED";
	const result = rows.monitorEvent(event({ text: forged }));
	const appended = eventLines(result.patch.output);
	assert.equal(appended.filter((line) => line.startsWith("[")).length, 1, "exactly one event line per child line");
	assert.equal(appended.length, 1);
	const line = appended[0] ?? "";
	assert.ok(line.startsWith(`[${iso(ARMED + 1_000)}] `), "the only timestamp prefix is the real one");
	assert.doesNotMatch(line, /[\r\n]/);
	assert.ok(line.includes("real line"));
	assert.ok(line.includes("[2026-10-22T09:59:59.000Z] BUILD SUCCEEDED"));
	// Even after the overlay's own join-then-sanitise pass, the forgery is one line, not two.
	assert.equal((result.patch.output ?? "").split(/[\r\n]/).filter((l) => l.startsWith("[")).length, 1);
});

test("escape sequences in a child line never reach the stored output or the detail", () => {
	const rows = new WakeRows();
	rows.monitorArmed(outputEntry({ maxEvents: 2 }));
	const colored = rows.monitorEvent(event({ atEpochMs: ARMED + 1_000, text: "\u001b[31mred\u001b[0m and a bare \u001b here" }));
	assert.doesNotMatch(colored.patch.output ?? "", /\u001b/);
	assert.doesNotMatch(colored.patch.detail ?? "", /\u001b/);
	assert.ok(eventLines(colored.patch.output)[0]?.includes("red and a bare  here"));

	// An unterminated escape in one line must not swallow the genuine lines that follow it.
	rows.monitorEvent(event({ atEpochMs: ARMED + 2_000, text: "dangling \u001b[31;1;4" }));
	const next = rows.monitorEvent(event({ atEpochMs: ARMED + 3_000, text: "after the dangling escape", terminal: true }));
	assert.doesNotMatch(next.patch.output ?? "", /\u001b/);
	assert.doesNotMatch(next.patch.detail ?? "", /\u001b/);
	const lines = eventLines(next.patch.output);
	assert.equal(lines.length, 3);
	assert.equal(lines.at(-1), `[${iso(ARMED + 3_000)}] after the dangling escape`);
});

test("a line break smuggled into a command argument or the cwd stays inside its own base line", () => {
	const rows = new WakeRows();
	const row = rows.monitorArmed(exitEntry({ command: "echo", args: ["\u001b[2J\nfake"], cwd: "/work/\r\u001b[31mapp" }));
	const output = row.output ?? "";
	assert.doesNotMatch(output, /\u001b/);
	const lines = output.split("\n");
	assert.equal(lines.length, 4, "mode, command, cwd and timing: no line was added by the smuggled break");
	assert.equal(lines.filter((line) => line.startsWith("command: ")).length, 1);
	const command = lines.find((line) => line.startsWith("command: ")) ?? "";
	assert.ok(command.includes("echo"));
	assert.ok(command.includes("fake"));
	assert.doesNotMatch(command, /[\r\n]/);
	assert.equal(lines.filter((line) => line.startsWith("cwd: ")).length, 1);
	assert.doesNotMatch(lines[2] ?? "", /[\r\n]/);
	assert.ok(lines[2]?.includes("app"));
	assert.match(lines[3] ?? "", /^armed .* · deadline /);
});

test("a terminal exit summary built from a hostile first line carries no escape", () => {
	const rows = new WakeRows();
	rows.monitorArmed(exitEntry());
	const result = rows.monitorEvent(event({ id: "monitor-2", kind: "exit", text: "process exited with exit code 1\u001b[0m\nstderr:\nboom", terminal: true }));
	assert.doesNotMatch(result.patch.detail ?? "", /\u001b/);
	assert.equal(result.patch.detail, "monitor-2 · process exited with exit code 1");
	assert.equal(result.patch.status, "failed");
	assert.doesNotMatch(result.patch.output ?? "", /\u001b/);
});

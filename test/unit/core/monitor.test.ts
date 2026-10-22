import { test } from "node:test";
import assert from "node:assert/strict";

import { MonitorManager, type MonitorEvent, type MonitorProcessHandlers, type MonitorSpec } from "../../../src/core/monitor.ts";

interface FakeProcess {
	handlers: MonitorProcessHandlers;
	stopped: number;
}

function harness(startNow = 1_000_000) {
	let now = startNow;
	let nextHandle = 0;
	const timers = new Map<number, { fn: () => void; at: number }>();
	const events: MonitorEvent[] = [];
	const processes: FakeProcess[] = [];
	const manager = new MonitorManager({
		now: () => now,
		setTimer: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, { fn, at: now + ms });
			return handle;
		},
		clearTimer: (handle) => timers.delete(handle as number),
		start: (_spec, handlers) => {
			const process: FakeProcess = { handlers, stopped: 0 };
			processes.push(process);
			return { stop: () => process.stopped++ };
		},
		onEvent: (event) => events.push(event),
	});
	return {
		manager,
		events,
		processes,
		setNow: (value: number) => {
			now = value;
		},
		advance: (ms: number) => {
			now += ms;
			for (const [handle, timer] of [...timers.entries()]) {
				if (timer.at <= now) {
					timers.delete(handle);
					timer.fn();
				}
			}
		},
		pendingTimers: () => timers.size,
	};
}

function spec(overrides: Partial<MonitorSpec> = {}): MonitorSpec {
	return {
		command: "producer",
		args: ["--watch"],
		cwd: "C:\\work",
		label: "build",
		mode: "output",
		...overrides,
	};
}

test("split output at the line limit stays bounded and explicitly marks truncation", () => {
	for (const initial of [3999, 4000]) {
		const h = harness();
		h.manager.arm(spec());
		h.processes[0]!.handlers.onStdout("x".repeat(initial));
		h.processes[0]!.handlers.onStdout("more\n");
		assert.equal(h.events.length, 1);
		assert.ok(h.events[0]!.text.length <= 4000);
		assert.match(h.events[0]!.text, /truncated/);
	}
});

test("deduplication is independent of a CRLF split across process chunks", () => {
	const h = harness();
	h.manager.arm(spec({ maxEvents: 3 }));
	h.processes[0]!.handlers.onStdout("event\r\n");
	h.processes[0]!.handlers.onStdout("event\r");
	h.processes[0]!.handlers.onStdout("\n");
	assert.equal(h.events.length, 1);
	h.manager.cancelAll();
});

test("arms a bounded monitor and exposes its expiry metadata", () => {
	const h = harness();
	const result = h.manager.arm(spec({ timeoutMs: 5_000, maxEvents: 3 }));

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.entry.id, "monitor-1");
	assert.equal(result.entry.startedAtEpochMs, 1_000_000);
	assert.equal(result.entry.expiresAtEpochMs, 1_005_000);
	assert.equal(result.entry.maxEvents, 3);
	assert.deepEqual(h.manager.list(), [result.entry]);
});

test("rejects invalid monitor specs and active-limit overflow", () => {
	const h = harness();
	assert.equal(h.manager.arm(spec({ command: "   " })).ok, false);
	assert.equal(h.manager.arm(spec({ cwd: "   " })).ok, false);
	assert.equal(h.manager.arm(spec({ label: "   " })).ok, false);
	assert.equal(h.manager.arm(spec({ mode: "invalid" as MonitorSpec["mode"] })).ok, false);
	assert.equal(h.manager.arm(spec({ timeoutMs: 500 })).ok, false);
	assert.equal(h.manager.arm(spec({ timeoutMs: 24 * 60 * 60 * 1000 + 1 })).ok, false);
	assert.equal(h.manager.arm(spec({ maxEvents: 0 })).ok, false);
	assert.equal(h.manager.arm(spec({ maxEvents: 21 })).ok, false);
	assert.equal(h.manager.arm(spec({ command: "x".repeat(4_097) })).ok, false);
	assert.equal(h.manager.arm(spec({ label: "x".repeat(121) })).ok, false);
	assert.equal(h.manager.arm(spec({ args: Array.from({ length: 65 }, () => "x") })).ok, false);
	assert.equal(h.manager.arm(spec({ args: ["x".repeat(8_193)] })).ok, false);
	assert.equal(h.manager.arm(spec({ args: ["x".repeat(24_001)] })).ok, false);
	assert.equal(h.manager.arm(spec({ command: "node\0" })).ok, false);

	for (let i = 0; i < 8; i++) assert.equal(h.manager.arm(spec({ label: `m${i}` })).ok, true);
	const overflow = h.manager.arm(spec({ label: "overflow" }));
	assert.equal(overflow.ok, false);
	assert.match(overflow.error ?? "", /maximum 8/);
});

test("output mode deduplicates lines and makes the max-events line terminal", () => {
	const h = harness();
	const result = h.manager.arm(spec({ maxEvents: 2 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);

	process.handlers.onStdout("same\n");
	process.handlers.onStdout("same\n");
	process.handlers.onStdout("next\n");
	process.handlers.onExit(0);

	assert.deepEqual(
		h.events.map(({ kind, text, terminal }) => ({ kind, text, terminal })),
		[
			{ kind: "output", text: "same", terminal: false },
			{ kind: "output", text: "next", terminal: true },
		],
	);
	assert.equal(process.stopped, 1, "max-events terminal output stops the process");
	assert.equal(h.manager.list().length, 0);
	assert.equal(h.pendingTimers(), 0);
});

test("exit mode suppresses output until exit and includes bounded diagnostics", () => {
	const h = harness();
	const result = h.manager.arm(spec({ mode: "exit", maxEvents: 4 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);

	process.handlers.onStdout("result\n");
	process.handlers.onStderr("warning\n");
	assert.equal(h.events.length, 0, "exit mode does not wake per output line");
	process.handlers.onExit(7, "SIGTERM");

	assert.equal(h.events.length, 1);
	assert.equal(h.events[0]?.kind, "exit");
	assert.equal(h.events[0]?.terminal, true);
	assert.match(h.events[0]?.text ?? "", /exit code 7/);
	assert.match(h.events[0]?.text ?? "", /SIGTERM/);
	assert.match(h.events[0]?.text ?? "", /result/);
	assert.match(h.events[0]?.text ?? "", /warning/);
});

test("output mode bounds an unterminated giant line before it is completed", () => {
	const h = harness();
	const result = h.manager.arm(spec());
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);

	process.handlers.onStdout("x".repeat(10_000));
	assert.equal(h.events.length, 0, "an incomplete line does not wake the session");
	process.handlers.onStdout("\n");
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0]?.kind, "output");
	assert.equal(h.events[0]?.text.length, 4_000);
	assert.match(h.events[0]?.text ?? "", /truncated/);
});

test("distinct giant lines remain distinct even when their emitted prefixes match", () => {
	const h = harness();
	const result = h.manager.arm(spec({ maxEvents: 2 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);
	const prefix = "x".repeat(5_000);
	process.handlers.onStdout(`${prefix}A\n`);
	process.handlers.onStdout(`${prefix}B\n`);
	assert.equal(h.events.length, 2, "dedupe uses the complete line identity, not the truncated display");
	assert.equal(h.events[1]?.terminal, true);
});

test("timeout retains bounded stderr diagnostics", () => {
	const h = harness();
	const result = h.manager.arm(spec({ mode: "exit", timeoutMs: 1_000 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);
	process.handlers.onStderr("warning".repeat(2_000));
	h.advance(1_000);
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0]?.kind, "timeout");
	assert.match(h.events[0]?.text ?? "", /stderr:/);
	assert.match(h.events[0]?.text ?? "", /truncated/);
	assert.ok((h.events[0]?.text.length ?? 0) < 5_000, "diagnostic text remains bounded");
});

test("an unterminated output line is reported as a diagnostic when the process exits", () => {
	const h = harness();
	const result = h.manager.arm(spec({ timeoutMs: 1_000 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);
	process.handlers.onStdout("partial result");
	assert.equal(h.events.length, 0);
	process.handlers.onExit(0);
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0]?.kind, "exit");
	assert.match(h.events[0]?.text ?? "", /partial stdout \(unterminated\)/);
	assert.match(h.events[0]?.text ?? "", /partial result/);
});

test("timeout stops the process, clears the timer, and ignores late callbacks", () => {
	const h = harness();
	const result = h.manager.arm(spec({ timeoutMs: 1_000 }));
	assert.ok(result.ok);
	if (!result.ok) return;
	const process = h.processes[0];
	assert.ok(process);

	h.advance(1_000);
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0]?.kind, "timeout");
	assert.equal(h.events[0]?.terminal, true);
	assert.equal(process.stopped, 1);
	assert.equal(h.pendingTimers(), 0);

	process.handlers.onStdout("late\n");
	process.handlers.onExit(0);
	process.handlers.onError(new Error("late"));
	assert.equal(h.events.length, 1, "callbacks after terminal cleanup cannot wake the session");
});

test("cancel removes a monitor without emitting a wake event", () => {
	const h = harness();
	const result = h.manager.arm(spec());
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(h.manager.cancel(result.entry.id), true);
	assert.equal(h.manager.cancel(result.entry.id), false);
	assert.equal(h.manager.list().length, 0);
	assert.equal(h.pendingTimers(), 0);
	assert.equal(h.processes[0]?.stopped, 1);
	h.processes[0]?.handlers.onExit(0);
	assert.equal(h.events.length, 0);
});

test("cancelAll stops every active process and clears every deadline", () => {
	const h = harness();
	assert.equal(h.manager.arm(spec({ label: "one" })).ok, true);
	assert.equal(h.manager.arm(spec({ label: "two" })).ok, true);
	h.manager.cancelAll();
	assert.equal(h.manager.list().length, 0);
	assert.equal(h.pendingTimers(), 0);
	assert.deepEqual(h.processes.map((p) => p.stopped), [1, 1]);
});

test("a synchronous start error rejects arm without queuing a duplicate error wake", () => {
	let stopped = 0;
	const events: MonitorEvent[] = [];
	const manager = new MonitorManager({
		now: () => 1_000_000,
		setTimer: () => 1,
		clearTimer: () => {},
		start: (_spec, handlers) => {
			handlers.onError(new Error("bad cwd"));
			return { stop: () => stopped++ };
		},
		onEvent: (event) => events.push(event),
	});

	const result = manager.arm(spec());
	assert.equal(result.ok, false);
	assert.match(result.error, /bad cwd/);
	assert.equal(stopped, 1);
	assert.deepEqual(events, []);
});

// ── admission/removal hooks: the seam the agent tree's monitor rows hang on ──────────────────────

function hookedHarness(opts: { startThrows?: boolean; startErrorsSync?: boolean; finishesSync?: boolean } = {}) {
	const armed: string[] = [];
	const removed: string[] = [];
	const events: MonitorEvent[] = [];
	/** Every hook, in the order it fired: the three arrays above cannot show relative order. */
	const log: string[] = [];
	const processes: FakeProcess[] = [];
	let now = 1_000_000;
	const timers = new Map<number, { fn: () => void; at: number }>();
	let nextHandle = 0;
	const manager = new MonitorManager({
		now: () => now,
		setTimer: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, { fn, at: now + ms });
			return handle;
		},
		clearTimer: (handle) => timers.delete(handle as number),
		start: (_spec, handlers) => {
			if (opts.startThrows) throw new Error("spawn exploded");
			const process: FakeProcess = { handlers, stopped: 0 };
			processes.push(process);
			if (opts.startErrorsSync) handlers.onError(new Error("ENOENT"));
			if (opts.finishesSync) handlers.onExit(0);
			return { stop: () => process.stopped++ };
		},
		onEvent: (event) => {
			events.push(event);
			log.push(`event:${event.id}:${event.kind}:${event.terminal}`);
		},
		onArmed: (entry) => {
			armed.push(entry.id);
			log.push(`armed:${entry.id}`);
		},
		onRemoved: (entry) => {
			removed.push(entry.id);
			log.push(`removed:${entry.id}`);
		},
	});
	return { manager, armed, removed, events, log, processes, advance: (ms: number) => { now += ms; for (const [h, t] of [...timers.entries()]) if (t.at <= now) { timers.delete(h); t.fn(); } } };
}

test("every admitted monitor is announced once and ends with exactly one of: a terminal event, or onRemoved", () => {
	const h = hookedHarness();
	assert.equal(h.manager.arm(spec({ label: "" })).ok, false, "a rejected spec is never announced");
	assert.deepEqual(h.armed, []);
	h.manager.arm(spec({ label: "cancelled by hand" }));
	h.manager.arm(spec({ label: "exits", mode: "exit" }));
	h.manager.arm(spec({ label: "times out" }));
	h.manager.arm(spec({ label: "cancelled in bulk", timeoutMs: 60 * 60 * 1_000 }));
	assert.deepEqual(h.armed, ["monitor-1", "monitor-2", "monitor-3", "monitor-4"]);

	assert.equal(h.manager.cancel("monitor-1"), true);
	assert.deepEqual(h.removed, ["monitor-1"], "an explicit cancel is a silent removal");
	assert.equal(h.manager.cancel("monitor-1"), false);
	assert.deepEqual(h.removed, ["monitor-1"], "…announced once");

	h.processes[1]!.handlers.onExit(0);
	assert.equal(h.events.filter((e) => e.terminal).map((e) => e.id).join(), "monitor-2");
	assert.deepEqual(h.removed, ["monitor-1"], "a terminal event is NOT also a removal: the observer settles the row from the event");

	h.advance(10 * 60 * 1_000);
	assert.deepEqual(h.events.filter((e) => e.terminal && e.kind === "timeout").map((e) => e.id), ["monitor-3"]);
	assert.deepEqual(h.removed, ["monitor-1"]);

	h.manager.cancelAll();
	assert.deepEqual(h.removed, ["monitor-1", "monitor-4"], "cancelAll announces each live monitor it dropped");
	h.manager.cancelAll();
	assert.deepEqual(h.removed, ["monitor-1", "monitor-4"]);

	// Order, not just membership: a row must exist (armed) before anything settles or removes it.
	const at = (entry: string): number => h.log.indexOf(entry);
	assert.ok(at("armed:monitor-1") >= 0 && at("armed:monitor-1") < at("removed:monitor-1"), "armed precedes the removal");
	assert.ok(at("armed:monitor-2") >= 0 && at("armed:monitor-2") < at("event:monitor-2:exit:true"), "armed precedes the terminal event");
});

test("a start that throws, or fails synchronously, is announced as armed then removed, so no row is orphaned", () => {
	const thrown = hookedHarness({ startThrows: true });
	assert.equal(thrown.manager.arm(spec()).ok, false);
	assert.deepEqual(thrown.armed, ["monitor-1"]);
	assert.deepEqual(thrown.removed, ["monitor-1"]);
	assert.deepEqual(thrown.events, []);
	assert.deepEqual(thrown.log, ["armed:monitor-1", "removed:monitor-1"], "armed THEN removed, in that order");

	const errored = hookedHarness({ startErrorsSync: true });
	assert.equal(errored.manager.arm(spec()).ok, false);
	assert.deepEqual(errored.armed, ["monitor-1"]);
	assert.deepEqual(errored.removed, ["monitor-1"]);
	assert.deepEqual(errored.events, []);
	assert.deepEqual(errored.log, ["armed:monitor-1", "removed:monitor-1"], "armed THEN removed, in that order");

	// A process that finishes before start() returns: the terminal event already settled it, so the
	// observer must see armed THEN the terminal event, and never a removal on top.
	const sync = hookedHarness({ finishesSync: true });
	assert.equal(sync.manager.arm(spec({ mode: "exit" })).ok, true);
	assert.deepEqual(sync.armed, ["monitor-1"]);
	assert.deepEqual(sync.events.map((e) => `${e.id}:${e.kind}:${e.terminal}`), ["monitor-1:exit:true"]);
	assert.deepEqual(sync.removed, []);
	assert.deepEqual(sync.log, ["armed:monitor-1", "event:monitor-1:exit:true"], "armed THEN the terminal event, in that order");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitorSession } from "../../src/monitor/session.ts";

function harness() {
	let idle = false;
	let allowed = true;
	let stopped = 0;
	const messages: string[] = [];
	const sources: any[] = [];
	const session = createMonitorSession({
		isIdle: () => idle, canRun: () => allowed,
		deliver: (text) => { messages.push(text); },
		start: (_spec, handlers) => { sources.push(handlers); return { stop: () => { stopped++; } }; },
	});
	const arm = () => session.arm({ command: "node", cwd: ".", label: "watch", mode: "output", maxEvents: 20 });
	return { session, arm, messages, sources, idle: () => { idle = true; }, deny: () => { allowed = false; session.reconcilePermissions(); }, stopped: () => stopped };
}

test("monitor wakes once idle, batches events and fences external content", async () => {
	const h = harness();
	try {
		h.arm();
		h.sources[0].onStdout("first event\nsecond event\n");
		await h.session.flush();
		assert.equal(h.messages.length, 0);
		h.idle();
		await h.session.flush();
		assert.equal(h.messages.length, 1);
		assert.match(h.messages[0]!, /first event/);
		assert.match(h.messages[0]!, /second event/);
		assert.match(h.messages[0]!, /untrusted/i);
	} finally { h.session.cancelAll(); }
});

test("monitor cancellation drops queued events and prevents later wakes", async () => {
	const h = harness();
	try {
		const result = h.arm();
		assert.equal(result.ok, true);
		if (!result.ok) return;
		h.sources[0].onStdout("pending\n");
		assert.equal(h.session.cancel(result.entry.id), true);
		h.sources[0].onStdout("late\n");
		h.idle(); await h.session.flush();
		assert.equal(h.messages.length, 0);
		assert.equal(h.stopped(), 1);
	} finally { h.session.cancelAll(); }
});

test("revoking command permission stops active monitors and drops queued content", async () => {
	const h = harness();
	try {
		h.arm(); h.sources[0].onStdout("pending\n"); h.deny();
		h.idle(); await h.session.flush();
		assert.equal(h.messages.length, 0);
		assert.equal(h.stopped(), 1);
		assert.equal(h.arm().ok, false);
	} finally { h.session.cancelAll(); }
});

test("monitor event backlog is bounded while the model stays busy", async () => {
	const h = harness();
	try {
		for (let i = 0; i < 12; i++) {
			h.arm();
			h.sources[i].onStdout(Array.from({ length: 20 }, (_, j) => `event ${i}-${j}\n`).join(""));
		}
		assert.ok(h.session.pendingCount() <= 64);
		h.idle(); await h.session.flush();
		assert.match(h.messages[0]!, /older.*omitted/i);
	} finally { h.session.cancelAll(); }
});

test("live output is observed without adding model wakes or changing terminal delivery", async () => {
	const sources: any[] = [];
	const output: unknown[] = [];
	const messages: string[] = [];
	const session = createMonitorSession({
		isIdle: () => true, canRun: () => true,
		deliver: (text) => { messages.push(text); },
		start: (_spec, handlers) => { sources.push(handlers); return { stop() {} }; },
		observe: { armed() {}, event() {}, removed() {}, output: (chunk) => { output.push(chunk); } },
	});
	try {
		session.arm({ command: "node", cwd: ".", label: "build", mode: "exit" });
		sources[0].onStdout("building\r50%");
		sources[0].onStderr("warning\n");
		await session.flush();
		assert.deepEqual(output, [
			{ id: "monitor-1", stream: "stdout", text: "building\r50%" },
			{ id: "monitor-1", stream: "stderr", text: "warning\n" },
		]);
		assert.equal(messages.length, 0);
		assert.equal(session.pendingCount(), 0);
		sources[0].onExit(0);
		await session.flush();
		assert.equal(messages.length, 1);
		sources[0].onStdout("late");
		assert.equal(output.length, 2);
	} finally { session.cancelAll(); }
});

// ── the observer seam the agent tree's monitor rows hang on ─────────────────────────────────────

function observedHarness() {
	let idle = false;
	let allowed = true;
	const messages: string[] = [];
	const sources: any[] = [];
	const seen: string[] = [];
	const session = createMonitorSession({
		isIdle: () => idle, canRun: () => allowed,
		deliver: (text) => { messages.push(text); },
		start: (_spec, handlers) => { sources.push(handlers); return { stop: () => {} }; },
		observe: {
			armed: (entry) => seen.push(`armed:${entry.id}:${entry.label}`),
			event: (event) => seen.push(`event:${event.id}:${event.kind}:${event.terminal}`),
			removed: (entry) => seen.push(`removed:${entry.id}`),
		},
	});
	const arm = (label = "watch", mode: "output" | "exit" = "output") => session.arm({ command: "node", cwd: ".", label, mode, maxEvents: 2 });
	return { session, arm, messages, sources, seen, idle: () => { idle = true; }, deny: () => { allowed = false; } };
}

test("the observer sees arm, every event (terminal included) and silent removals, in order", async () => {
	const h = observedHarness();
	try {
		h.arm("first");
		h.arm("second", "exit");
		h.sources[0].onStdout("one\ntwo\n"); // two distinct lines: the second is the terminal max-events event
		assert.equal(h.session.cancel("monitor-2"), true);
		assert.deepEqual(h.seen, ["armed:monitor-1:first", "armed:monitor-2:second", "event:monitor-1:output:false", "event:monitor-1:output:true", "removed:monitor-2"]);
		h.idle(); await h.session.flush();
		assert.equal(h.messages.length, 1, "observation never changes delivery");
	} finally { h.session.cancelAll(); }
});

test("a terminal event is still observed when the permission gate drops its wake", async () => {
	// `finish` has already removed the monitor from the manager when the event reaches the session, so
	// a permission-loss `cancelAll` can never announce it: the observer must see the event itself.
	const h = observedHarness();
	try {
		h.arm("ends while denied", "exit");
		h.arm("still live");
		h.deny();
		h.sources[0].onExit(0);
		h.idle(); await h.session.flush();
		assert.equal(h.messages.length, 0, "no wake is delivered without permission");
		assert.deepEqual(h.seen.slice(2), ["event:monitor-1:exit:true", "removed:monitor-2"], "the terminal event settles its own row; the live monitor is dropped by the permission sweep");
		assert.equal(h.session.list().length, 0);
	} finally { h.session.cancelAll(); }
});

test("cancelAll on shutdown announces every live monitor so no row outlives the session", () => {
	const h = observedHarness();
	h.arm("a"); h.arm("b");
	h.session.cancelAll();
	assert.deepEqual(h.seen.slice(2), ["removed:monitor-1", "removed:monitor-2"]);
	h.session.cancelAll();
	assert.equal(h.seen.length, 4, "an empty cancelAll announces nothing");
});

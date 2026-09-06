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

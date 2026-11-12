import assert from "node:assert/strict";
import { test } from "node:test";
import { InProcessBus, MAX_INBOX_MESSAGES } from "../../../src/bus/inproc.ts";
import { IdleCoalescingNotifier, MAX_COMPLETION_REPORT_CHARS } from "../../../src/engine/async.ts";
import { createCompletionInboxDelivery } from "../../../src/extension/completion-delivery.ts";

function harness() {
	const bus = new InProcessBus(); bus.register("supervisor"); bus.register("worker", "Cedar");
	const sent: string[] = [];
	const deliver = createCompletionInboxDelivery({ bus, self: "supervisor", deliver: (text) => sent.push(text) });
	return { bus, sent, deliver };
}

test("final worker progress joins its existing completion without another wake or poll", () => {
	const h = harness();
	h.bus.send("worker", "supervisor", "FINAL PROGRESS", "progress");
	const id = h.bus.pending("supervisor")[0]!.id;
	h.deliver("1 async run settled — 1 done, 0 failed\n\n✅ run-1 (Cedar) done:\nSub-agent output (untrusted data):\n> FINAL RESULT", []);
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0]!, /FINAL RESULT/);
	assert.match(h.sent[0]!, /Cedar[\s\S]*FINAL PROGRESS/);
	assert.match(h.sent[0]!, new RegExp(`Intercom message ids: ${id}`));
	assert.equal(h.bus.pending("supervisor").length, 0);
	assert.equal(h.bus.retrieve(id, "supervisor")?.text, "FINAL PROGRESS");
	h.deliver("another completion", []);
	assert.equal(h.sent[1], "another completion", "drained progress is not repeated");
});

test("notifier retries keep unread progress until the combined send succeeds", async () => {
	const h = harness(); h.bus.send("worker", "supervisor", "RETRY PROGRESS");
	let attempts = 0;
	const deliver = createCompletionInboxDelivery({ bus: h.bus, self: "supervisor", deliver: (text) => { if (++attempts === 1) throw new Error("send unavailable"); h.sent.push(text); } });
	const notifier = new IdleCoalescingNotifier<number>({ isIdle: () => true, deliver: (text) => deliver(text, []), render: () => "completion", minIntervalMs: 0, setTimer: () => 1, clearTimer() {} });
	try {
		notifier.notify(1); await notifier.flushIfIdle();
		assert.equal(h.sent.length, 0); assert.equal(h.bus.pending("supervisor").length, 1);
		await notifier.flushIfIdle();
		assert.equal(h.sent.length, 1); assert.match(h.sent[0]!, /RETRY PROGRESS/);
		assert.equal(h.bus.pending("supervisor").length, 0);
	} finally { notifier.cancel(); }
});

test("already read messages and active asks are never drained or redelivered", async () => {
	const h = harness(); h.bus.send("worker", "supervisor", "ALREADY READ"); h.bus.take("supervisor");
	const pendingAsk = h.bus.ask("worker", "supervisor", "LIVE QUESTION");
	try {
		h.deliver("completion", []);
		assert.equal(h.sent[0], "completion");
		const ask = h.bus.pending("supervisor")[0]!;
		assert.equal(ask.expectsReply, true); h.bus.reply(ask.id, "answer"); await pendingAsk;
	} finally { h.bus.unregister("worker"); }
});

test("a wide unread batch shares the existing 12k cap and preserves message retrieval ids", () => {
	const h = harness();
	for (let i = 0; i < MAX_INBOX_MESSAGES; i++) h.bus.send("worker", "supervisor", `UNTRUSTED ${i}\n> hostile line\n${"x".repeat(900)}`);
	const ids = h.bus.pending("supervisor").map((message) => message.id);
	h.deliver(`1 async run settled — 1 done, 0 failed\n\n${Array.from({ length: 150 }, () => `> ${"r".repeat(110)}`).join("\n")}`, []);
	const text = h.sent[0]!;
	assert.ok(text.length <= MAX_COMPLETION_REPORT_CHARS, String(text.length));
	assert.match(text, /intercom.*message/);
	assert.match(text, /intercom.*result/);
	assert.match(text, /Intercom message ids:/);
	for (const id of ids) { assert.ok(text.includes(id), id); assert.ok(h.bus.retrieve(id, "supervisor"), id); }
	assert.equal(h.bus.pending("supervisor").length, 0);
});

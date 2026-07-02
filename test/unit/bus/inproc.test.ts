import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessBus } from "../../../src/bus/inproc.ts";

test("send delivers a one-way message to a registered recipient, or fails for unknown", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.register("child");
	assert.equal(bus.send("child", "sup", "halfway done"), true);
	assert.equal(bus.send("child", "ghost", "halfway done"), false);
	const msgs = bus.take("sup");
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0]?.text, "halfway done");
	assert.equal(msgs[0]?.from, "child");
	assert.equal(msgs[0]?.kind, "progress", "default kind is progress");
	assert.equal(msgs[0]?.expectsReply, false);
});

test("send carries an explicit message kind", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.send("child", "sup", "fyi", "progress");
	assert.equal(bus.take("sup")[0]?.kind, "progress");
});

test("take drains the inbox; pending peeks without draining", () => {
	const bus = new InProcessBus();
	bus.register("a");
	bus.send("x", "a", "1");
	assert.equal(bus.pending("a").length, 1);
	assert.equal(bus.pending("a").length, 1, "pending does not drain");
	assert.equal(bus.take("a").length, 1);
	assert.equal(bus.take("a").length, 0, "take drained it");
});

test("takeWhere drains only matching messages, leaving the rest in the inbox", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.send("child", "sup", "progress 1"); // expectsReply: false
	void bus.ask("child", "sup", "decide?", { kind: "decision" }); // expectsReply: true
	bus.send("child", "sup", "progress 2");
	const progress = bus.takeWhere("sup", (e) => !e.expectsReply);
	assert.deepEqual(
		progress.map((e) => e.text),
		["progress 1", "progress 2"],
		"only the non-blocking messages are drained",
	);
	const left = bus.pending("sup");
	assert.equal(left.length, 1, "the blocking ask is left in the inbox");
	assert.equal(left[0]?.expectsReply, true);
});

test("takeWhere on an empty/absent inbox returns []", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	assert.deepEqual(bus.takeWhere("sup", () => true), []);
	assert.deepEqual(bus.takeWhere("ghost", () => true), []);
});

test("ask blocks until the recipient replies to that message id, carrying its kind", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.register("child");
	const answer = bus.ask("child", "sup", "default ON or OFF?", { kind: "decision" });
	const inbox = bus.take("sup");
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.expectsReply, true);
	assert.equal(inbox[0]?.kind, "decision");
	assert.equal(bus.reply(inbox[0]!.id, "OFF"), true, "a live ask reports the reply as delivered");
	assert.equal(await answer, "OFF");
});

test("ask rejects on timeout when no reply arrives", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	await assert.rejects(() => bus.ask("child", "sup", "?", { timeoutMs: 20 }), /timeout/i);
});

test("ask rejects promptly when its AbortSignal fires, and a later reply is a no-op (no leak)", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const ac = new AbortController();
	const p = bus.ask("child", "sup", "?", { signal: ac.signal });
	const id = bus.take("sup")[0]!.id;
	ac.abort();
	await assert.rejects(() => p, /abort/i);
	// The pending entry was cleaned up: replying after abort resolves nothing (and must not throw).
	assert.doesNotThrow(() => bus.reply(id, "late"));
});

test("ask that is already-aborted rejects immediately", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(() => bus.ask("child", "sup", "?", { signal: ac.signal }), /abort/i);
});

test("ask throws for an unknown peer", () => {
	const bus = new InProcessBus();
	assert.throws(() => void bus.ask("child", "nobody", "?"));
});

test("reply to an unknown/expired id is a harmless no-op that reports false", () => {
	const bus = new InProcessBus();
	assert.equal(bus.reply("nope", "anything"), false, "the caller can tell nobody received it");
});

test("an undrained inbox is bounded, evicting old progress notes but keeping blocking asks", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	void bus.ask("child", "sup", "decide?", { kind: "decision", timeoutMs: 60_000 }).catch(() => {});
	for (let i = 0; i < 400; i++) bus.send("child", "sup", `progress ${i}`);
	const box = bus.pending("sup");
	assert.ok(box.length <= 200, `inbox stays bounded (got ${box.length})`);
	assert.ok(box.some((e) => e.expectsReply), "the blocking ask survived the eviction");
	assert.equal(box[box.length - 1]?.text, "progress 399", "newest messages are kept");
});

test("participants lists registered peers; unregister removes one", () => {
	const bus = new InProcessBus();
	bus.register("a");
	bus.register("b");
	assert.deepEqual(bus.participants().sort(), ["a", "b"]);
	bus.unregister("a");
	assert.deepEqual(bus.participants(), ["b"]);
});

test("hasPending reflects whether a peer has undrained messages", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	assert.equal(bus.hasPending("sup"), false);
	bus.send("child", "sup", "ping");
	assert.equal(bus.hasPending("sup"), true);
	bus.take("sup");
	assert.equal(bus.hasPending("sup"), false);
});

test("onMessage observers fire on send and ask; unsubscribe stops them", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const seen: Array<{ kind: string; expectsReply: boolean }> = [];
	const off = bus.onMessage((env) => seen.push({ kind: env.kind, expectsReply: env.expectsReply }));
	bus.send("child", "sup", "progress!");
	void bus.ask("child", "sup", "decide?", { kind: "decision" });
	assert.deepEqual(seen, [
		{ kind: "progress", expectsReply: false },
		{ kind: "decision", expectsReply: true },
	]);
	off();
	bus.send("child", "sup", "ignored");
	assert.equal(seen.length, 2, "no more events after unsubscribe");
});

import { after, test } from "node:test";

// Keep the event loop ref'd for the whole file. Several tests below await a promise
// resolved only by an UNREF'd timer (bus ask timeouts). Without a ref'd handle the loop
// drains mid-await → node:test aborts with "Promise resolution is still pending but the
// event loop has already resolved" and cascades `cancelledByParent` to every later test.
// A ref'd keeper, cleared after all tests, holds the loop open so those timers fire.
const _loopKeeper = setInterval(() => {}, 60_000);
after(() => clearInterval(_loopKeeper));
import assert from "node:assert/strict";

import { InProcessBus, MAX_RETAINED_MESSAGE_CHARS, MAX_RETAINED_MESSAGES } from "../../../src/bus/inproc.ts";

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

test("drained messages remain retrievable by id with their exact body", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const body = "HEAD-" + "x".repeat(4_000) + "-TAIL";
	bus.send("child", "sup", body);
	const id = bus.take("sup")[0]!.id;

	assert.equal(bus.retrieve(id)?.text, body);
});

test("retained messages evict oldest entries within count and character ceilings", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const body = "x".repeat(Math.max(1, Math.floor(MAX_RETAINED_MESSAGE_CHARS / 4)));
	const ids: string[] = [];
	for (let index = 0; index < MAX_RETAINED_MESSAGES + 4; index++) {
		bus.send("child", "sup", `${index}:${body}`);
		ids.push(bus.take("sup")[0]!.id);
	}

	assert.equal(bus.retrieve(ids[0]!), undefined, "oldest retained message expires");
	assert.equal(bus.retrieve(ids.at(-1)!)?.text, `${MAX_RETAINED_MESSAGES + 3}:${body}`);
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
	assert.equal(bus.retrieve(progress[0]!.id)?.text, "progress 1", "automatic progress drains retain full messages");
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
	const pending = bus.ask("child", "sup", "?", { timeoutMs: 20 });
	const id = bus.pending("sup")[0]!.id;
	await assert.rejects(() => pending, /timeout/i);
	assert.equal(bus.pending("sup").some((message) => message.id === id), false, "expired asks are removed from the unread inbox");
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
	assert.equal(bus.pending("sup").some((message) => message.id === id), false, "aborted asks are removed from the unread inbox");
});

test("expired and replied asks are removed from retained snapshots too", async () => {
	const bus = new InProcessBus();
	bus.register("sup");

	const abort = new AbortController();
	const expired = bus.ask("child", "sup", "expired?", { signal: abort.signal });
	const expiredId = bus.pending("sup")[0]!.id;
	assert.equal(bus.take("sup").length, 1);
	abort.abort();
	await assert.rejects(() => expired, /abort/i);
	assert.equal(bus.retrieve(expiredId)?.text, "expired?", "an aborted ask keeps its drained body available");
	assert.equal(bus.retrieve(expiredId)?.expectsReply, false, "an aborted ask is not retained as an actionable snapshot");

	const replied = bus.ask("child", "sup", "replied?", { timeoutMs: 1_000 });
	const repliedId = bus.pending("sup")[0]!.id;
	assert.equal(bus.take("sup").length, 1);
	assert.equal(bus.reply(repliedId, "yes"), true);
	assert.equal(await replied, "yes");
	assert.equal(bus.retrieve(repliedId)?.text, "replied?", "a replied ask keeps its drained body available");
	assert.equal(bus.retrieve(repliedId)?.expectsReply, false, "a replied ask is not retained as an actionable snapshot");
});

test("ask settlement observers run after stale inbox cleanup", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const events: string[] = [];
	const off = bus.onAskSettled((event) => {
		events.push(event.reason);
		assert.equal(bus.pending("sup").length, 0, "settlement observers see no actionable unread ask");
	});
	const pending = bus.ask("child", "sup", "reply?", { timeoutMs: 1_000 });
	const id = bus.pending("sup")[0]!.id;
	assert.equal(bus.reply(id, "yes"), true);
	assert.equal(await pending, "yes");
	off();
	assert.deepEqual(events, ["replied"]);
});

test("an observer failure still settles and cleans up the delivered ask", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.onMessage(() => {
		throw new Error("observer failed");
	});
	const pending = bus.ask("child", "sup", "observer?", { timeoutMs: 1_000 });
	await assert.rejects(() => pending, /observer failed/);
	assert.equal(bus.pending("sup").length, 0, "observer failure does not leave an actionable ask");
});

test("ask that is already-aborted rejects immediately", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(() => bus.ask("child", "sup", "?", { signal: ac.signal }), /abort/i);
});

test("a reply issued synchronously from an onMessage observer resolves the ask", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	let replyResult: boolean | undefined;
	bus.onMessage((env) => {
		if (env.expectsReply) replyResult = bus.reply(env.id, "inline answer");
	});
	const answer = await bus.ask("child", "sup", "decide?", { kind: "decision", timeoutMs: 1000 });
	assert.equal(replyResult, true, "the inline reply reports as delivered");
	assert.equal(answer, "inline answer");
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

test("a full inbox containing only asks rejects new delivery without evicting live asks", async () => {
	const bus = new InProcessBus({ maxInbox: 2 });
	bus.register("sup");
	const firstAbort = new AbortController();
	const secondAbort = new AbortController();
	const first = bus.ask("child", "sup", "first?", { signal: firstAbort.signal });
	const second = bus.ask("child", "sup", "second?", { signal: secondAbort.signal });
	const ids = bus.pending("sup").map((message) => message.id);

	assert.equal(bus.send("child", "sup", "overflow"), false, "a one-way message cannot displace live asks");
	const rejected = bus.ask("child", "sup", "third?", { timeoutMs: 1_000 });
	await assert.rejects(() => rejected, /inbox full/i);
	assert.deepEqual(bus.pending("sup").map((message) => message.id), ids, "both existing asks remain replyable");

	firstAbort.abort();
	secondAbort.abort();
	await assert.rejects(() => first, /abort/i);
	await assert.rejects(() => second, /abort/i);
});

test("unregister rejects asks sent by or addressed to the departed participant", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.register("child");
	const childAsk = bus.ask("child", "sup", "child question?", { timeoutMs: 60_000 });
	const supervisorAsk = bus.ask("sup", "child", "supervisor question?", { timeoutMs: 60_000 });

	bus.unregister("child");

	await assert.rejects(() => childAsk, /unregistered/i);
	await assert.rejects(() => supervisorAsk, /unregistered/i);
	assert.equal(bus.pending("sup").length, 0, "the departed sender's unread ask is removed");
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

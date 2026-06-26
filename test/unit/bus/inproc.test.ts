import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessBus } from "../../../src/bus/inproc.ts";

test("send delivers a one-way message to a registered recipient, or fails for unknown", () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.register("child");
	assert.equal(bus.send("sup", "child", "hi"), true);
	assert.equal(bus.send("sup", "ghost", "hi"), false);
	const msgs = bus.take("child");
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0]?.text, "hi");
	assert.equal(msgs[0]?.from, "sup");
	assert.equal(msgs[0]?.expectsReply, false);
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

test("ask blocks until the recipient replies to that message id", async () => {
	const bus = new InProcessBus();
	bus.register("sup");
	bus.register("child");
	const answer = bus.ask("sup", "child", "status?");
	const inbox = bus.take("child");
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.expectsReply, true);
	bus.reply(inbox[0]!.id, "done");
	assert.equal(await answer, "done");
});

test("ask rejects on timeout when no reply arrives", async () => {
	const bus = new InProcessBus();
	bus.register("child");
	await assert.rejects(() => bus.ask("sup", "child", "?", 20), /timeout/i);
});

test("ask throws for an unknown peer", () => {
	const bus = new InProcessBus();
	assert.throws(() => void bus.ask("sup", "nobody", "?"));
});

test("participants lists registered peers", () => {
	const bus = new InProcessBus();
	bus.register("a");
	bus.register("b");
	assert.deepEqual(bus.participants().sort(), ["a", "b"]);
});

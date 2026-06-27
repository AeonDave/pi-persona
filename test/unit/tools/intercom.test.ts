import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessBus } from "../../../src/bus/inproc.ts";
import { formatInbox, runIntercom } from "../../../src/tools/intercom.ts";

test("intercom list returns the registered peers (minus self)", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	bus.register("scout#1");
	bus.register("scout#2");
	const r = runIntercom({ action: "list" }, bus, "supervisor");
	assert.deepEqual(r.details.peers?.sort(), ["scout#1", "scout#2"]);
	assert.match(r.text, /scout#1/);
});

test("intercom inbox drains the supervisor's messages", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	bus.send("scout#1", "supervisor", "found the bug in stream.ts");
	const r = runIntercom({ action: "inbox" }, bus, "supervisor");
	assert.equal(r.details.messages?.length, 1);
	assert.equal(r.details.messages?.[0]?.from, "scout#1");
	assert.match(r.text, /found the bug/);
	assert.equal(bus.hasPending("supervisor"), false, "inbox drained the queue");
});

test("intercom reply answers a child's blocking ask by id", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	bus.register("scout#1");
	const waiting = bus.ask("scout#1", "supervisor", "default ON or OFF?", { kind: "decision" });
	const askId = bus.pending("supervisor")[0]!.id;
	const r = runIntercom({ action: "reply", askId, message: "OFF" }, bus, "supervisor");
	assert.match(r.text, /replied/i);
	assert.equal(await waiting, "OFF", "the child's ask resolves with the reply");
});

test("intercom send delivers a one-way message to a child", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	bus.register("scout#1");
	const r = runIntercom({ action: "send", to: "scout#1", message: "focus on the parser" }, bus, "supervisor");
	assert.match(r.text, /sent/i);
	assert.equal(bus.take("scout#1")[0]?.text, "focus on the parser");
});

test("intercom send to an unknown peer reports it cleanly", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const r = runIntercom({ action: "send", to: "ghost", message: "x" }, bus, "supervisor");
	assert.match(r.text, /unknown|not.*found|no such/i);
});

test("intercom inbox with an empty queue says so", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const r = runIntercom({ action: "inbox" }, bus, "supervisor");
	assert.match(r.text, /no (new )?messages|empty/i);
});

test("formatInbox renders decision messages with their id (so the supervisor can reply)", () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	void bus.ask("scout#1", "supervisor", "pick A or B", { kind: "decision" });
	const line = formatInbox(bus.pending("supervisor"));
	assert.match(line, /scout#1/);
	assert.match(line, /decision/);
	assert.match(line, /reply/i, "tells the supervisor it can reply");
});

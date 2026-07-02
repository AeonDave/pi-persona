import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessBus } from "../../../src/bus/inproc.ts";
import { makeContactPeerTool } from "../../../src/bus/peers.ts";

// Like contact.test.ts: ctx is unused by the tool, the bus is the real (pure) InProcessBus.
const CTX = undefined as never;
const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

test("contact_peer list shows only the run's own peers (engine-scoped), never the whole bus", async () => {
	const bus = new InProcessBus();
	for (const h of ["supervisor", "a#1", "b#2", "stranger#9"]) bus.register(h);
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [{ handle: "b#2", label: "b#2 (SECURITY)" }] });
	const r = await tool.execute("t1", { action: "list" }, undefined, undefined, CTX);
	assert.match(text(r), /b#2 \(SECURITY\)/);
	assert.doesNotMatch(text(r), /stranger#9/, "a concurrent run's child is not visible");
	assert.doesNotMatch(text(r), /supervisor/);
});

test("contact_peer send delivers a one-way note to a live peer", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	bus.register("b#2");
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [{ handle: "b#2", label: "b#2" }] });
	const r = await tool.execute("t2", { action: "send", to: "b#2", message: "my position: X because Y" }, undefined, undefined, CTX);
	assert.match(text(r), /Sent to b#2/);
	const inbox = bus.take("b#2");
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.from, "a#1");
	assert.equal(inbox[0]?.kind, "progress");
	assert.equal(inbox[0]?.expectsReply, false, "one-way by design — peers can never deadlock");
});

test("contact_peer send to a finished peer reports 'gone', not an error", async () => {
	const bus = new InProcessBus();
	bus.register("a#1"); // b#2 already unregistered (finalized)
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [] });
	const r = await tool.execute("t3", { action: "send", to: "b#2", message: "hello?" }, undefined, undefined, CTX);
	assert.match(text(r), /gone|finalized/i);
});

test("contact_peer send without { to, message } explains the contract", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [] });
	const r = await tool.execute("t4", { action: "send" }, undefined, undefined, CTX);
	assert.match(text(r), /needs \{ to, message \}/);
});

test("contact_peer enforces the anti-ping-pong send budget", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	bus.register("b#2");
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [{ handle: "b#2", label: "b#2" }], maxSends: 2 });
	await tool.execute("t5", { action: "send", to: "b#2", message: "1" }, undefined, undefined, CTX);
	await tool.execute("t6", { action: "send", to: "b#2", message: "2" }, undefined, undefined, CTX);
	const r = await tool.execute("t7", { action: "send", to: "b#2", message: "3" }, undefined, undefined, CTX);
	assert.match(text(r), /budget exhausted/i);
	assert.match(text(r), /finalize/i);
	assert.equal(bus.take("b#2").length, 2, "the third note was not delivered");
});

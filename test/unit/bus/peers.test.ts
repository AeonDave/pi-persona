import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { InProcessBus } from "../../../src/bus/inproc.ts";
import { makeContactPeerTool, MAX_PEER_MESSAGE_CHARS } from "../../../src/bus/peers.ts";

// Like contact.test.ts: ctx is unused by the tool, the bus is the real (pure) InProcessBus.
const CTX = undefined as never;
const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

test("contact_peer description states the default send budget", () => {
	const tool = makeContactPeerTool(new InProcessBus(), "a#1", { listPeers: () => [] });
	assert.match(tool.description, /20.*send|send.*20/i);
});

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

test("contact_peer send to a finished peer reports unconfirmed delivery, not an error", async () => {
	const bus = new InProcessBus();
	bus.register("a#1"); // b#2 already unregistered (finalized)
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [] });
	const r = await tool.execute("t3", { action: "send", to: "b#2", message: "hello?" }, undefined, undefined, CTX);
	assert.match(text(r), /delivery.*could not be confirmed/i);
});

test("contact_peer send is scoped: a handle registered on the bus but NOT among listPeers() is refused, not delivered", async () => {
	const bus = new InProcessBus();
	for (const h of ["supervisor", "a#1", "stranger#9"]) bus.register(h);
	// "supervisor" and "stranger#9" both exist on the bus, but neither is in THIS run's peer
	// list — this is the coaching-gate bypass the enforcement closes.
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [] });
	const r1 = await tool.execute("t8", { action: "send", to: "supervisor", message: "psst" }, undefined, undefined, CTX);
	assert.match(text(r1), /delivery.*could not be confirmed/i);
	assert.equal(bus.take("supervisor").length, 0, "out-of-scope send never reaches the bus inbox");
	const r2 = await tool.execute("t9", { action: "send", to: "stranger#9", message: "psst" }, undefined, undefined, CTX);
	assert.match(text(r2), /delivery.*could not be confirmed/i);
	assert.equal(bus.take("stranger#9").length, 0, "a concurrent run's child is out of scope too");
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

test("contact_peer rejects oversized messages before delivery and without burning send budget", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	bus.register("b#2");
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [{ handle: "b#2", label: "b#2" }], maxSends: 1 });

	const oversized = await tool.execute(
		"t10",
		{ action: "send", to: "b#2", message: "x".repeat(MAX_PEER_MESSAGE_CHARS + 1) },
		undefined,
		undefined,
		CTX,
	);
	assert.match(text(oversized), new RegExp(`exceeds the ${MAX_PEER_MESSAGE_CHARS}-character limit`));
	assert.equal(bus.pending("b#2").length, 0, "the oversized note never enters the bus");

	const accepted = await tool.execute("t11", { action: "send", to: "b#2", message: "small" }, undefined, undefined, CTX);
	assert.match(text(accepted), /Sent to b#2/);
	assert.equal(bus.pending("b#2").length, 1, "the invalid attempt did not consume the send budget");
});

// ── presentation contract: compact call line + shared literal receipt ──────────────────────
// Same conformed host-tool rules as contact_supervisor: these cards render in the child's
// transcript/telemetry, so no raw-args echo, bounded list results with expansion.

initTheme("dark");
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

type PeerTool = ReturnType<typeof makeContactPeerTool>;

function renderCallCard(tool: PeerTool, args: Record<string, unknown>): string {
	return stripVTControlCharacters((tool as any).renderCall(args, plainTheme).render(200).join("\n")).trim();
}

function renderResultCard(tool: PeerTool, value: unknown, expanded: boolean, isError = false): string {
	return stripVTControlCharacters((tool as any).renderResult(value, { expanded }, plainTheme, { isError }).render(400).join("\n")).trim();
}

test("contact_peer call card is the compact `peer <action>` line without the message body", () => {
	const tool = makeContactPeerTool(new InProcessBus(), "a#1", { listPeers: () => [] });
	assert.equal(typeof (tool as any).renderCall, "function", "renderCall must exist; the host fallback echoes raw args JSON");
	assert.equal(renderCallCard(tool, { action: "send", to: "b#2", message: "SECRET peer note body" }), "peer send");
	assert.equal(renderCallCard(tool, { action: "list" }), "peer list");
	assert.equal(renderCallCard(tool, {}), "peer", "action absent → bare purpose word");
});

test("contact_peer list result is bounded collapsed and expands to every peer", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	const peers = Array.from({ length: 30 }, (_, i) => ({ handle: `p#${i}`, label: `peer-${i} (LENS)` }));
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => peers });
	const r = await tool.execute("t-r1", { action: "list" }, undefined, undefined, CTX);
	const before = JSON.stringify(r);
	const collapsed = renderResultCard(tool, r, false);
	assert.match(collapsed, /expand/, "a long peer list must not dump in the card");
	assert.ok(collapsed.split("\n").length <= 5, `collapsed list stays bounded, got ${collapsed.split("\n").length} lines`);
	assert.doesNotMatch(collapsed, /peer-29/, "the tail of the list is hidden until expansion");
	const expanded = renderResultCard(tool, r, true);
	assert.doesNotMatch(expanded, /expand/, "no false affordance when everything is shown");
	assert.match(expanded, /peer-29/, "expansion shows every peer");
	assert.equal(JSON.stringify(r), before, "rendering never mutates the tool result");
});

test("contact_peer send receipt renders as one compact line", async () => {
	const bus = new InProcessBus();
	bus.register("a#1");
	bus.register("b#2");
	const tool = makeContactPeerTool(bus, "a#1", { listPeers: () => [{ handle: "b#2", label: "b#2" }] });
	const r = await tool.execute("t-r2", { action: "send", to: "b#2", message: "my position: X" }, undefined, undefined, CTX);
	const card = renderResultCard(tool, r, false);
	assert.equal(card, "Sent to b#2.", "one compact line, no expansion hint");
});

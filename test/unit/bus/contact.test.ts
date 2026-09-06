import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessBus, type MsgKind } from "../../../src/bus/inproc.ts";
import { makeContactSupervisorTool } from "../../../src/bus/contact.ts";

// The tool's execute(toolCallId, params, signal, onUpdate, ctx) — ctx is unused by this
// tool, so the unit test passes a stub. The bus is the real (pure) InProcessBus.
const CTX = undefined as never;
const details = (r: { details: unknown }): { kind: string; delivered: boolean } => r.details as { kind: string; delivered: boolean };

class ShortTimeoutBus extends InProcessBus {
	override ask(
		from: string,
		to: string,
		text: string,
		opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		return super.ask(from, to, text, { ...opts, timeoutMs: 1 });
	}
}

class DisconnectedBus extends InProcessBus {
	override ask(
		_from: string,
		_to: string,
		_text: string,
		_opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		return Promise.reject(new Error("broker connection closed"));
	}
}

test("contact_supervisor progress_update sends a one-way message and returns immediately", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const r = await tool.execute("t1", { kind: "progress", message: "read 3 of 6 files" }, undefined, undefined, CTX);
	assert.equal(details(r).delivered, true);
	const inbox = bus.take("supervisor");
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]?.from, "scout");
	assert.equal(inbox[0]?.kind, "progress");
	assert.equal(inbox[0]?.text, "read 3 of 6 files");
});

test("contact_supervisor need_decision blocks until the supervisor replies, returning the answer", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const pending = tool.execute("t2", { kind: "decision", message: "default ON or OFF?" }, undefined, undefined, CTX);
	// The supervisor sees the blocking ask and answers it.
	const inbox = bus.take("supervisor");
	assert.equal(inbox[0]?.expectsReply, true);
	assert.equal(inbox[0]?.kind, "decision");
	bus.reply(inbox[0]!.id, "OFF — too risky to default on");
	const r = await pending;
	assert.equal(details(r).delivered, true);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /OFF — too risky/);
});

test("contact_supervisor decision aborts cleanly when its signal fires (no hang)", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const ac = new AbortController();
	const pending = tool.execute("t3", { kind: "decision", message: "?" }, ac.signal, undefined, CTX);
	ac.abort();
	const r = await pending;
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /cancelled/i, "an aborted ask returns a clean cancelled result, not a hang");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor decision downgrades to one-way (no block) when blocking is disabled (sync run)", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor", { allowBlocking: false });
	// Must resolve immediately (no reply needed) — a sync run can't answer.
	const r = await tool.execute("t5", { kind: "decision", message: "ON or OFF?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /busy|noted|best judgement/i);
	const inbox = bus.take("supervisor");
	assert.equal(inbox[0]?.kind, "decision", "the question is still posted (one-way) for the supervisor to see");
	assert.equal(inbox[0]?.expectsReply, false, "but it does not expect a reply (no deadlock)");
});

test("contact_supervisor reports cleanly when no supervisor is listening", async () => {
	const bus = new InProcessBus(); // nobody registered
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const r = await tool.execute("t4", { kind: "progress", message: "fyi" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /no supervisor|not listening|dropped/i);
});

test("contact_supervisor reports a full supervisor inbox as not delivered, without calling it a timeout", async () => {
	const bus = new InProcessBus({ maxInbox: 1 });
	bus.register("supervisor");
	const holderAbort = new AbortController();
	const holder = bus.ask("other-child", "supervisor", "hold this slot", { signal: holderAbort.signal });
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t6", { kind: "decision", message: "is it full?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /not delivered|retry later|consolidate/i);
	assert.doesNotMatch(text, /did not reply in time/i);
	assert.equal(details(r).delivered, false);

	holderAbort.abort();
	await assert.rejects(() => holder, /abort/i);
});

test("contact_supervisor reports an unregistered supervisor as unavailable, not waiting", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const pending = tool.execute("t7", { kind: "decision", message: "still there?" }, undefined, undefined, CTX);
	bus.unregister("supervisor");

	const r = await pending;
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /no longer available|unavailable|not delivered/i);
	assert.doesNotMatch(text, /did not reply in time/i);
});

test("contact_supervisor reports a disconnected broker as unavailable, not waiting", async () => {
	const bus = new DisconnectedBus();
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t7b", { kind: "decision", message: "still connected?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /no longer available|unavailable|not delivered/i);
	assert.doesNotMatch(text, /did not reply in time/i);
});

test("contact_supervisor preserves the timeout diagnostic", async () => {
	const bus = new ShortTimeoutBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t8", { kind: "decision", message: "will anyone answer?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /did not reply in time/i);
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor hides arbitrary internal ask failures behind a generic result", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	bus.onMessage(() => {
		throw new Error("secret internal failure");
	});
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t9", { kind: "decision", message: "can this complete?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /could not be completed/i);
	assert.doesNotMatch(text, /secret internal failure/i);
	assert.doesNotMatch(text, /did not reply in time/i);
});

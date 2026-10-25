import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { InProcessBus, type MsgKind } from "../../../src/bus/inproc.ts";
import { makeContactSupervisorTool } from "../../../src/bus/contact.ts";

// The tool's execute(toolCallId, params, signal, onUpdate, ctx) — ctx is unused by this
// tool, so the unit test passes a stub. The bus is the real (pure) InProcessBus.
const CTX = undefined as never;
const details = (r: { details: unknown }): { kind: string; delivered: boolean; outcome: string } =>
	r.details as { kind: string; delivered: boolean; outcome: string };

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

test("contact_supervisor description states the sync no-answer contract and message bound", () => {
	const tool = makeContactSupervisorTool(new InProcessBus(), "scout", "supervisor", { allowBlocking: false });
	assert.match(tool.description, /one-way.*return immediately/i);
	assert.match(tool.description, /no answer|unresolved/i);
	assert.match(tool.description, /8000.*shorten|shorten.*8000/i);
});

class ShortTimeoutBus extends InProcessBus {
	override ask(
		_from: string,
		_to: string,
		_text: string,
		_opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		return Promise.reject(new Error("ask timeout after controlled test failure"));
	}
}

class SyncFailureBus extends InProcessBus {
	override ask(
		_from: string,
		_to: string,
		_text: string,
		_opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		throw new Error("secret synchronous broker failure");
	}
}

class LateReplyBus extends InProcessBus {
	resolveReply!: (reply: string) => void;

	override ask(
		_from: string,
		_to: string,
		_text: string,
		_opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		return new Promise((resolve) => { this.resolveReply = resolve; });
	}
}

class ThrowingSendBus extends InProcessBus {
	override send(_from: string, _to: string, _text: string, _kind: MsgKind = "progress"): boolean {
		throw new Error("secret synchronous send failure");
	}
}

class CountingContactBus extends InProcessBus {
	sendCalls = 0;
	askCalls = 0;

	override send(from: string, to: string, text: string, kind: MsgKind = "progress"): boolean {
		this.sendCalls += 1;
		return super.send(from, to, text, kind);
	}

	override ask(
		from: string,
		to: string,
		text: string,
		opts: { kind?: MsgKind; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		this.askCalls += 1;
		return super.ask(from, to, text, opts);
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

for (const kind of ["progress", "decision", "interview"] as const) {
	for (const allowBlocking of [true, false]) {
		test(`contact_supervisor cancels pre-aborted ${kind} without bus activity (allowBlocking=${allowBlocking})`, async () => {
			const bus = new CountingContactBus();
			bus.register("supervisor");
			const tool = makeContactSupervisorTool(bus, "scout", "supervisor", { allowBlocking });
			const ac = new AbortController();
			ac.abort();

			const r = await tool.execute("t-pre-aborted", { kind, message: "secret request text" }, ac.signal, undefined, CTX);
			assert.equal(details(r).kind, kind);
			assert.equal(details(r).delivered, false);
			assert.equal(details(r).outcome, "cancelled");
			assert.match(textOf(r), /cancelled/i);
			assert.doesNotMatch(textOf(r), /secret request text|secret .* failure/i);
			if (kind !== "progress") {
				assert.match(textOf(r), /remains unresolved/i);
				assert.match(textOf(r), /independent work already authorized/i);
			}
			assert.equal(bus.sendCalls, 0, "pre-aborted call must not send a message");
			assert.equal(bus.askCalls, 0, "pre-aborted call must not queue an ask");
			assert.deepEqual(bus.pending("supervisor"), [], "supervisor inbox stays empty");
			assert.equal(bus.hasPendingAskFrom("scout"), false, "no pending ask is retained");
		});
	}
}

test("contact_supervisor progress_update sends a one-way message and returns immediately", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const r = await tool.execute("t1", { kind: "progress", message: "read 3 of 6 files" }, undefined, undefined, CTX);
	assert.equal(details(r).delivered, true);
	assert.equal(details(r).outcome, "reported");
	assert.match(textOf(r), /progress reported/i);
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
	const text = textOf(r);
	assert.equal(details(r).outcome, "answered");
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
	const text = textOf(r);
	assert.match(text, /cancelled/i, "an aborted ask returns a clean cancelled result, not a hang");
	assert.match(text, /remains unresolved/i);
	assert.match(text, /independent work already authorized/i);
	assert.match(text, /blocked\/partial/i);
	assert.equal(details(r).outcome, "cancelled");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor never reports a late answer after the ask signal is aborted", async () => {
	const bus = new LateReplyBus();
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const ac = new AbortController();
	const pending = tool.execute("t3b", { kind: "decision", message: "choose?" }, ac.signal, undefined, CTX);
	ac.abort();
	bus.resolveReply("stale approval");
	const r = await pending;
	assert.equal(details(r).outcome, "cancelled");
	assert.equal(details(r).delivered, false);
	assert.doesNotMatch(textOf(r), /stale approval|Supervisor:/i);
	assert.match(textOf(r), /remains unresolved/i);
});

test("contact_supervisor decision downgrades to one-way (no block) when blocking is disabled (sync run)", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor", { allowBlocking: false });
	// Must resolve immediately (no reply needed) — a sync run can't answer.
	const r = await tool.execute("t5", { kind: "decision", message: "ON or OFF?" }, undefined, undefined, CTX);
	const text = textOf(r);
	assert.equal(details(r).outcome, "unavailable", "a one-way post cannot answer or authorize the decision");
	assert.equal(details(r).delivered, true, "delivered records only the one-way send evidence");
	assert.match(text, /no answer is possible/i);
	assert.match(text, /remains unresolved/i);
	assert.match(text, /independent work already authorized/i);
	assert.match(text, /blocked\/partial/i);
	assert.doesNotMatch(text, /proceed using your best judgement/i);
	const inbox = bus.take("supervisor");
	assert.equal(inbox[0]?.kind, "decision", "the question is still posted (one-way) for the supervisor to see");
	assert.equal(inbox[0]?.expectsReply, false, "but it does not expect a reply (no deadlock)");
});

test("contact_supervisor nonblocking decision reports unavailable when its one-way send is not confirmed", async () => {
	const bus = new InProcessBus();
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor", { allowBlocking: false });
	const r = await tool.execute("t5b", { kind: "decision", message: "choose?" }, undefined, undefined, CTX);
	assert.equal(details(r).outcome, "unavailable");
	assert.equal(details(r).delivered, false);
	assert.match(textOf(r), /no answer is possible/i);
	assert.match(textOf(r), /remains unresolved/i);
	assert.match(textOf(r), /independent work already authorized/i);
	assert.match(textOf(r), /blocked\/partial/i);
});

test("contact_supervisor reports a progress delivery failure as unavailable", async () => {
	const bus = new InProcessBus(); // nobody registered
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const r = await tool.execute("t4", { kind: "progress", message: "fyi" }, undefined, undefined, CTX);
	const text = textOf(r);
	assert.match(text, /no supervisor|not listening|dropped/i);
	assert.equal(details(r).outcome, "unavailable");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor reports a thrown progress send as failed without exposing diagnostics", async () => {
	const tool = makeContactSupervisorTool(new ThrowingSendBus(), "scout", "supervisor");
	const r = await tool.execute("t4b", { kind: "progress", message: "fyi" }, undefined, undefined, CTX);
	assert.equal(details(r).outcome, "failed");
	assert.equal(details(r).delivered, false);
	assert.doesNotMatch(textOf(r), /secret synchronous send failure/i);
});

test("contact_supervisor reports a full supervisor inbox as not delivered, without calling it a timeout", async () => {
	const bus = new InProcessBus({ maxInbox: 1 });
	bus.register("supervisor");
	const holderAbort = new AbortController();
	const holder = bus.ask("other-child", "supervisor", "hold this slot", { signal: holderAbort.signal });
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t6", { kind: "decision", message: "is it full?" }, undefined, undefined, CTX);
	const text = textOf(r);
	assert.match(text, /not delivered|delivery could not be confirmed|retry later|consolidate/i);
	assert.match(text, /remains unresolved/i);
	assert.match(text, /independent work already authorized/i);
	assert.match(text, /blocked\/partial/i);
	assert.doesNotMatch(text, /did not reply in time/i);
	assert.equal(details(r).outcome, "unavailable");
	assert.equal(details(r).delivered, false);

	holderAbort.abort();
	await assert.rejects(() => holder, /abort/i);
});

test("contact_supervisor classifies a synchronous unregistered-peer throw as unavailable", async () => {
	const bus = new InProcessBus();
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t7", { kind: "decision", message: "still there?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /unavailable|delivery could not be confirmed/i);
	assert.match(text, /remains unresolved/i);
	assert.doesNotMatch(text, /did not reply in time/i);
	assert.equal(details(r).outcome, "unavailable");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor reports a disconnected broker as unavailable, not waiting", async () => {
	const bus = new DisconnectedBus();
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t7b", { kind: "decision", message: "still connected?" }, undefined, undefined, CTX);
	const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	assert.match(text, /unavailable|delivery could not be confirmed/i);
	assert.match(text, /remains unresolved/i);
	assert.doesNotMatch(text, /did not reply in time/i);
	assert.equal(details(r).outcome, "unavailable");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor preserves the timeout diagnostic", async () => {
	const bus = new ShortTimeoutBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");

	const r = await tool.execute("t8", { kind: "decision", message: "will anyone answer?" }, undefined, undefined, CTX);
	const text = textOf(r);
	assert.match(text, /did not reply in time/i);
	assert.match(text, /remains unresolved/i);
	assert.match(text, /independent work already authorized/i);
	assert.match(text, /blocked\/partial/i);
	assert.equal(details(r).outcome, "timed-out");
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
	const text = textOf(r);
	assert.match(text, /request failed|could not be completed/i);
	assert.match(text, /remains unresolved/i);
	assert.match(text, /independent work already authorized/i);
	assert.match(text, /blocked\/partial/i);
	assert.doesNotMatch(text, /secret internal failure/i);
	assert.doesNotMatch(text, /did not reply in time/i);
	assert.equal(details(r).outcome, "failed");
	assert.equal(details(r).delivered, false);
});

test("contact_supervisor classifies synchronous generic ask failures as failed and hides diagnostics", async () => {
	const tool = makeContactSupervisorTool(new SyncFailureBus(), "scout", "supervisor");
	const r = await tool.execute("t10", { kind: "interview", message: "clarify?" }, undefined, undefined, CTX);
	assert.equal(details(r).outcome, "failed");
	assert.equal(details(r).delivered, false);
	assert.match(textOf(r), /remains unresolved/i);
	assert.doesNotMatch(textOf(r), /secret synchronous broker failure/i);
});

// ── presentation contract: compact call line + shared literal receipt ──────────────────────
// These cards render inside the CHILD session's transcript/telemetry (in-process customTools
// and bridge child mode), so the conformed host-tool rules apply: no raw-args echo in the
// call card, bounded literal results with expansion, honest error styling.

initTheme("dark");
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

type ContactTool = ReturnType<typeof makeContactSupervisorTool>;

function renderCallCard(tool: ContactTool, args: Record<string, unknown>): string {
	return stripVTControlCharacters((tool as any).renderCall(args, plainTheme).render(200).join("\n")).trim();
}

function renderResultCard(tool: ContactTool, value: unknown, expanded: boolean, isError = false): string {
	return stripVTControlCharacters((tool as any).renderResult(value, { expanded }, plainTheme, { isError }).render(400).join("\n")).trim();
}

test("contact_supervisor call card is the compact `contact <kind>` line without the message body", () => {
	const tool = makeContactSupervisorTool(new InProcessBus(), "scout", "supervisor");
	assert.equal(typeof (tool as any).renderCall, "function", "renderCall must exist; the host fallback echoes raw args JSON");
	const card = renderCallCard(tool, { kind: "decision", message: "TOPSECRET decision request body" });
	assert.equal(card, "contact decision");
	assert.doesNotMatch(card, /TOPSECRET/, "the message is the child's prose; it must not overflow the card");
	assert.doesNotMatch(card, /[{}"=]/, "no raw arguments echo");
	assert.equal(renderCallCard(tool, {}), "contact", "kind absent → bare purpose word");
	const bounded = renderCallCard(tool, { kind: "k".repeat(40), message: "x" });
	assert.match(bounded, /^contact k+…$/, "an overlong kind is clipped by the shared helper clamp, never echoed in full");
	assert.doesNotMatch(bounded, /k{17}/);
});

test("contact_supervisor answered ask: bounded collapsed card, full reply on expansion, no mutation", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const pending = tool.execute("t-r1", { kind: "decision", message: "ON or OFF?" }, undefined, undefined, CTX);
	const inbox = bus.take("supervisor");
	bus.reply(inbox[0]!.id, `OFF — ${"filler ".repeat(30)}TAILMARKER`);
	const r = await pending;
	assert.equal(details(r).outcome, "answered");

	const before = JSON.stringify(r);
	const collapsed = renderResultCard(tool, r, false);
	assert.match(collapsed, /expand/, "detail is hidden, so the expansion hint is present");
	assert.ok(collapsed.split("\n").length <= 5, `collapsed card stays bounded, got ${collapsed.split("\n").length} lines`);
	assert.doesNotMatch(collapsed, /TAILMARKER/, "the long reply does not dump into the collapsed card");
	const expanded = renderResultCard(tool, r, true);
	assert.doesNotMatch(expanded, /expand/, "no false affordance when everything is shown");
	assert.match(expanded, /TAILMARKER/, "expansion shows the full supervisor reply");
	assert.equal(JSON.stringify(r), before, "rendering never mutates the tool result");
});

test("contact_supervisor unresolved outcome stays a successful result: error styling only on the host flag", async () => {
	const tool = makeContactSupervisorTool(new ShortTimeoutBus(), "scout", "supervisor");
	const r = await tool.execute("t-r2", { kind: "decision", message: "ON or OFF?" }, undefined, undefined, CTX);
	assert.equal(details(r).outcome, "timed-out");
	const collapsed = renderResultCard(tool, r, false);
	assert.doesNotMatch(collapsed, /^failed/m, "unresolved outcomes are normally SUCCESSFUL tool results — never painted red by default");
	assert.match(collapsed, /unresolved|did not reply/);
	assert.ok(collapsed.split("\n").length <= 6, "unresolved receipt stays compact");
	const withHostError = renderResultCard(tool, r, false, true);
	assert.match(withHostError, /^failed/, "the host context isError flag alone drives the error heading");
});

test("contact_supervisor progress receipts render as one compact line", async () => {
	const bus = new InProcessBus();
	bus.register("supervisor");
	const tool = makeContactSupervisorTool(bus, "scout", "supervisor");
	const r = await tool.execute("t-r3", { kind: "progress", message: "read 3 of 6 files" }, undefined, undefined, CTX);
	const card = renderResultCard(tool, r, false);
	assert.equal(card, "Progress reported to the supervisor.", "one compact line, no expansion hint");
});

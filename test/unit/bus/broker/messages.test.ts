import { test } from "node:test";
import assert from "node:assert/strict";

import { isFrame } from "../../../../src/bus/broker/messages.ts";
import { MAX_MESSAGE_CHARS } from "../../../../src/bus/inproc.ts";

const reqId = "12345678-1234-1234-1234-123456789abc";
const ref = `result:${reqId}`;
const token = "c".repeat(64);

test("reader frames are closed, UUID-correlated and strictly range checked", () => {
	assert.equal(isFrame({ t: "result_read", reqId, ref }), true);
	assert.equal(isFrame({ t: "result_read", reqId, ref, offset: 0, limit: 16000 }), true);
	assert.equal(isFrame({ t: "result_read_cancel", reqId }), true);
	for (const patch of [{ reqId: "x" }, { ref: "../file" }, { offset: -1 }, { offset: 0.5 },
		{ offset: "0" }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 1 }, { limit: 16001 },
		{ limit: null }, { session: "foreign" }, { path: "/secret" }]) {
		assert.equal(isFrame({ t: "result_read", reqId, ref, ...patch }), false, JSON.stringify(patch));
	}
	assert.equal(isFrame({ t: "result_read_cancel", reqId, ref }), false);
});

test("reader registration validates the private token and forbids client grants", () => {
	for (const base of [{ t: "register", handle: "child", token }, { t: "registered", handle: "child" }]) {
		assert.equal(isFrame({ ...base, readerToken: "a".repeat(64) }), true);
		for (const readerToken of ["", "a".repeat(63), "G".repeat(64), 1]) {
			assert.equal(isFrame({ ...base, readerToken }), false);
		}
		assert.equal(isFrame({ ...base, readerToken: "a".repeat(64), grants: [ref] }), false);
	}
});

test("register requires a 64-hex bus token and carries no client-asserted identity", () => {
	assert.equal(isFrame({ t: "register", handle: "a1", token }), true);
	assert.equal(isFrame({ t: "register", handle: "a1" }), false);
	for (const bad of ["", "c".repeat(63), "c".repeat(65), "G".repeat(64), 1]) {
		assert.equal(isFrame({ t: "register", handle: "a1", token: bad }), false, String(bad));
	}
	for (const extra of [{ label: "coder" }, { group: "g1" }, { peers: true }]) {
		assert.equal(isFrame({ t: "register", handle: "a1", token, ...extra }), false, JSON.stringify(extra));
	}
});

test("isFrame accepts registered", () => {
	assert.equal(isFrame({ t: "registered", handle: "a1" }), true);
});

test("isFrame accepts send", () => {
	assert.equal(isFrame({ t: "send", to: "a1", kind: "progress", text: "hi", msgId: reqId, expectsReply: false }), true);
});

test("send is bounded: UUID id, 1..256-char recipient, the shared message-size limit", () => {
	const send = { t: "send", to: "a1", kind: "progress", text: "x".repeat(MAX_MESSAGE_CHARS), msgId: reqId, expectsReply: false };
	assert.equal(MAX_MESSAGE_CHARS, 8_000);
	assert.equal(isFrame(send), true, "exactly the limit is accepted");
	for (const patch of [{ text: "x".repeat(MAX_MESSAGE_CHARS + 1) }, { msgId: "m1" }, { to: "" }, { to: "a".repeat(257) }]) {
		assert.equal(isFrame({ ...send, ...patch }), false, JSON.stringify(patch).slice(0, 40));
	}
	assert.equal(isFrame({ ...send, to: "a".repeat(256) }), true);
});

test("client cancel and list ids are UUIDs", () => {
	assert.equal(isFrame({ t: "cancel", msgId: "m1" }), false);
	assert.equal(isFrame({ t: "list", reqId: "r1" }), false);
});

test("sent receipts match send message ids and carry only a boolean admission result", () => {
	for (const delivered of [true, false]) assert.equal(isFrame({ t: "sent", msgId: reqId, delivered }), true);
	assert.equal(isFrame({ t: "sent", msgId: "m1", delivered: true }), true, "every valid send id can be acknowledged");
	for (const patch of [{ msgId: 1 }, { msgId: null }, { delivered: "true" }, { delivered: undefined }, { text: "not a reply" }]) {
		assert.equal(isFrame({ t: "sent", msgId: reqId, delivered: true, ...patch }), false);
	}
});

test("isFrame accepts deliver", () => {
	assert.equal(isFrame({ t: "deliver", from: "a1", kind: "decision", text: "hi", msgId: "m1", expectsReply: true }), true);
	assert.equal(isFrame({ t: "deliver", from: "a1", fromLabel: "coder", kind: "interview", text: "hi", msgId: "m1", expectsReply: true }), true);
});

test("isFrame rejects reply: a child never answers a supervisor ask over the wire", () => {
	assert.equal(isFrame({ t: "reply", askId: "m1", text: "ok" }), false);
});

test("isFrame accepts replied", () => {
	assert.equal(isFrame({ t: "replied", askId: "m1", text: "ok" }), true);
});

test("isFrame accepts steer", () => {
	assert.equal(isFrame({ t: "steer", text: "stop" }), true);
});

test("isFrame accepts list", () => {
	assert.equal(isFrame({ t: "list", reqId }), true);
});

test("isFrame accepts peers", () => {
	assert.equal(isFrame({ t: "peers", reqId: "r1", peers: [{ handle: "a1", label: "coder" }] }), true);
	assert.equal(isFrame({ t: "peers", reqId: "r1", peers: [] }), true);
});

test("isFrame accepts bye", () => {
	assert.equal(isFrame({ t: "bye" }), true);
});

test("isFrame accepts error", () => {
	assert.equal(isFrame({ t: "error", reason: "boom" }), true);
	assert.equal(isFrame({ t: "error", reason: "ask failed", msgId: "m1" }), true);
});

test("isFrame accepts a per-connection ask cancellation", () => {
	assert.equal(isFrame({ t: "cancel", msgId: reqId }), true);
});

test("isFrame rejects an unknown t", () => {
	assert.equal(isFrame({ t: "nope" }), false);
});

test("isFrame rejects a send missing to", () => {
	assert.equal(isFrame({ t: "send", kind: "progress", text: "hi", msgId: "m1", expectsReply: false }), false);
});

test("isFrame rejects a non-object", () => {
	assert.equal(isFrame("register"), false);
	assert.equal(isFrame(null), false);
	assert.equal(isFrame(undefined), false);
	assert.equal(isFrame(42), false);
});

test("isFrame rejects a deliver with a numeric text", () => {
	assert.equal(isFrame({ t: "deliver", from: "a1", kind: "progress", text: 123, msgId: "m1", expectsReply: true }), false);
});

test("isFrame rejects malformed ask error/cancel correlation", () => {
	assert.equal(isFrame({ t: "error", reason: "boom", msgId: 1 }), false);
	assert.equal(isFrame({ t: "cancel", msgId: 1 }), false);
});

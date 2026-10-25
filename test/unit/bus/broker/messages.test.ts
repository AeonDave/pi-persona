import { test } from "node:test";
import assert from "node:assert/strict";

import { isFrame } from "../../../../src/bus/broker/messages.ts";

const reqId = "12345678-1234-1234-1234-123456789abc";
const ref = `result:${reqId}`;

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
	for (const t of ["register", "registered"]) {
		assert.equal(isFrame({ t, handle: "child", readerToken: "a".repeat(64) }), true);
		for (const readerToken of ["", "a".repeat(63), "G".repeat(64), 1]) {
			assert.equal(isFrame({ t, handle: "child", readerToken }), false);
		}
		assert.equal(isFrame({ t, handle: "child", readerToken: "a".repeat(64), grants: [ref] }), false);
	}
});

test("isFrame accepts register", () => {
	assert.equal(isFrame({ t: "register", handle: "a1" }), true);
	assert.equal(isFrame({ t: "register", handle: "a1", label: "coder", group: "g1", peers: true }), true);
});

test("isFrame accepts registered", () => {
	assert.equal(isFrame({ t: "registered", handle: "a1" }), true);
});

test("isFrame accepts send", () => {
	assert.equal(isFrame({ t: "send", to: "a1", kind: "progress", text: "hi", msgId: "m1", expectsReply: false }), true);
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

test("isFrame accepts reply", () => {
	assert.equal(isFrame({ t: "reply", askId: "m1", text: "ok" }), true);
});

test("isFrame accepts replied", () => {
	assert.equal(isFrame({ t: "replied", askId: "m1", text: "ok" }), true);
});

test("isFrame accepts steer", () => {
	assert.equal(isFrame({ t: "steer", text: "stop" }), true);
});

test("isFrame accepts list", () => {
	assert.equal(isFrame({ t: "list", reqId: "r1" }), true);
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
	assert.equal(isFrame({ t: "cancel", msgId: "m1" }), true);
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

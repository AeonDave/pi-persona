import { test } from "node:test";
import assert from "node:assert/strict";

import { isFrame } from "../../../../src/bus/broker/messages.ts";

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

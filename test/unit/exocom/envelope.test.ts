import assert from "node:assert/strict";
import { test } from "node:test";
import { isExocomFrame, truncateForInject, type ExocomMessage } from "../../../src/exocom/envelope.ts";

const msg = (over: Partial<ExocomMessage> = {}): ExocomMessage => ({
	kind: "message", msg_id: "m1", from_session: "s1", from_endpoint: "/e", from_name: "elite", text: "hi", hops: 0, ts: "2026-07-17T00:00:00Z", ...over,
});

test("isExocomFrame accepts well-formed frames and rejects junk (fail-closed)", () => {
	assert.equal(isExocomFrame(msg()), true);
	assert.equal(isExocomFrame({ kind: "ping", msg_id: "p1", from_session: "s1", from_endpoint: "/e" }), true);
	assert.equal(isExocomFrame({ kind: "bye", from_session: "s1" }), true);
	assert.equal(isExocomFrame(null), false);
	assert.equal(isExocomFrame({ kind: "message" }), false, "missing fields");
	assert.equal(isExocomFrame({ kind: "wat", msg_id: "x" }), false, "unknown kind");
	assert.equal(isExocomFrame({ ...msg(), hops: "0" }), false, "wrong type");
	assert.equal(isExocomFrame({ ...msg(), text: 5 }), false);
});

test("truncateForInject head-truncates by UTF-8 bytes and marks it", () => {
	const short = truncateForInject("small", 100);
	assert.equal(short.truncated, false);
	assert.equal(short.text, "small");
	const long = truncateForInject("x".repeat(500), 100);
	assert.equal(long.truncated, true);
	assert.ok(Buffer.byteLength(long.text, "utf8") <= 100 + 80, "within cap + notice");
	assert.match(long.text, /truncated/i);
});

test("truncateForInject never emits a replacement character at a multibyte boundary", () => {
	const cut = truncateForInject("A😀B", 3);
	assert.equal(cut.truncated, true);
	assert.ok(cut.text.startsWith("A"));
	assert.doesNotMatch(cut.text, /�/, "partial UTF-8 code points are omitted, never decoded as U+FFFD");
});

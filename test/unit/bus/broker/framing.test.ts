import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameReader, encodeFrame } from "../../../../src/bus/broker/framing.ts";

test("encode/decode round-trips an object across arbitrary chunk splits", () => {
	const frames: unknown[] = [];
	const read = createFrameReader((o) => frames.push(o), () => assert.fail("no error expected"));
	const buf = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "two" })]);
	for (let i = 0; i < buf.length; i++) read(buf.subarray(i, i + 1)); // one byte at a time
	assert.deepEqual(frames, [{ a: 1 }, { b: "two" }]);
});

test("a length header over the 16 MiB cap is rejected via onError and poisons the reader", () => {
	let err: Error | undefined;
	const frames: unknown[] = [];
	const read = createFrameReader((o) => frames.push(o), (e) => (err = e));
	const bad = Buffer.alloc(4);
	bad.writeUInt32BE(17 * 1024 * 1024, 0);
	read(bad);
	assert.match(err?.message ?? "", /too large/);
	read(encodeFrame({ ok: 1 })); // poisoned → dropped
	assert.equal(frames.length, 0);
});

test("malformed JSON payload triggers onError once, not a throw", () => {
	let calls = 0;
	const read = createFrameReader(() => assert.fail("no frame"), () => (calls += 1));
	const head = Buffer.alloc(4);
	const body = Buffer.from("{not json", "utf8");
	head.writeUInt32BE(body.length, 0);
	read(Buffer.concat([head, body]));
	assert.equal(calls, 1);
});

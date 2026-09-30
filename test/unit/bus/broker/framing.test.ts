import { test } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

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

test("generated frames survive varied stream chunk boundaries in order", () => {
	const value = fc.oneof(
		fc.integer(),
		fc.string({ maxLength: 40 }),
		fc.boolean(),
		fc.constant(null),
		fc.record({ id: fc.string({ maxLength: 20 }), values: fc.array(fc.integer(), { maxLength: 4 }) }),
	);
	fc.assert(fc.property(
		fc.array(value, { minLength: 1, maxLength: 5 }),
		fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 8 }),
		(expected, widths) => {
			const frames: unknown[] = [];
			const errors: Error[] = [];
			const read = createFrameReader((frame) => frames.push(frame), (error) => errors.push(error));
			const wire = Buffer.concat(expected.map(encodeFrame));
			for (let offset = 0, i = 0; offset < wire.length; i++) {
				const width = widths[i % widths.length]!;
				read(wire.subarray(offset, offset + width));
				offset += width;
			}
			assert.deepEqual(errors, []);
			// JSON frames preserve values, but not generated object prototypes.
			assert.deepEqual(frames, expected.map((frame) => JSON.parse(JSON.stringify(frame))));
		},
	), { numRuns: 200 });
});

test("generated malformed frames poison the reader before a following valid frame", () => {
	fc.assert(fc.property(
		fc.uint8Array({ maxLength: 128 }),
		fc.array(fc.integer({ min: 1, max: 19 }), { minLength: 1, maxLength: 8 }),
		(noise, widths) => {
			const frames: unknown[] = [];
			const errors: Error[] = [];
			const read = createFrameReader((frame) => frames.push(frame), (error) => errors.push(error));
			const body = Buffer.concat([Buffer.from("!"), Buffer.from(noise)]);
			const header = Buffer.alloc(4);
			header.writeUInt32BE(body.length, 0);
			const wire = Buffer.concat([header, body, encodeFrame({ shouldNotArrive: true })]);
			for (let offset = 0, i = 0; offset < wire.length; i++) {
				const width = widths[i % widths.length]!;
				read(wire.subarray(offset, offset + width));
				offset += width;
			}
			read(encodeFrame({ stillPoisoned: true }));
			assert.equal(errors.length, 1);
			assert.deepEqual(frames, []);
		},
	), { numRuns: 150 });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectImageHeader } from "../../../src/image/image-header.ts";
import { chunk, pngFixture } from "./fixtures.ts";

test("image admission detects supported formats from bytes and rejects unsupported or excessive dimensions", () => {
	assert.deepEqual(inspectImageHeader(pngFixture()), { mime: "image/png", width: 2, height: 1 });
	assert.deepEqual(inspectImageHeader(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")), { mime: "image/gif", width: 1, height: 1 });
	assert.deepEqual(inspectImageHeader(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64")), { mime: "image/webp", width: 1, height: 1 });
	assert.throws(() => inspectImageHeader(Buffer.from("<svg/>")), /PNG.*JPEG.*GIF.*WebP/i);
	assert.throws(() => inspectImageHeader(pngFixture(0, 1)), /dimensions/i);
	assert.throws(() => inspectImageHeader(pngFixture(16385, 1)), /dimensions/i);
	assert.throws(() => inspectImageHeader(pngFixture(4001, 4000, { raw: Buffer.alloc(5) })), /pixel/i);
});

test("image admission rejects malformed chunks, animated PNG and GIF frame dimensions before decoding", () => {
	assert.throws(() => inspectImageHeader(pngFixture(1, 1, { extra: [chunk("acTL", Buffer.alloc(8))] })), /animated PNG/i);
	assert.throws(() => inspectImageHeader(pngFixture().subarray(0, 24)), /PNG|truncated/i);
	const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
	const descriptor = gif.indexOf(0x2c, 13); gif.writeUInt16LE(16385, descriptor + 5);
	assert.throws(() => inspectImageHeader(gif), /dimensions/i);
});

test("PNG admission rejects binary or reserved chunk names before the dependency parser", () => {
	for (const name of ["ab\u00c3D", "abcD", "ABCD"]) assert.throws(() => inspectImageHeader(pngFixture(1, 1, { extra: [chunk(name, Buffer.alloc(0))] })), /chunk type/i);
});

test("PNG admission bounds palette records and chunk-list allocation before decoding", () => {
	assert.throws(() => inspectImageHeader(pngFixture(1, 1, { extra: [chunk("PLTE", Buffer.alloc(771))] })), /palette/i);
	assert.throws(() => inspectImageHeader(pngFixture(1, 1, { extra: Array.from({ length: 4097 }, () => chunk("aaAA", Buffer.alloc(0))) })), /chunk.*budget/i);
});

test("JPEG admission examines all frame headers before the first scan and rejects conflicting dimensions", () => {
	const frame = (width: number): Buffer => Buffer.from([255, 192, 0, 11, 8, 0, 1, width >>> 8, width & 255, 1, 1, 17, 0]);
	const scan = Buffer.from([255, 218, 0, 8, 1, 1, 0, 0, 63, 0]);
	const jpeg = Buffer.concat([Buffer.from([255, 216]), frame(2), scan]);
	assert.deepEqual(inspectImageHeader(jpeg), { mime: "image/jpeg", width: 2, height: 1 });
	assert.throws(() => inspectImageHeader(Buffer.concat([Buffer.from([255, 216]), frame(2), frame(3), scan])), /conflicting JPEG/i);
	assert.throws(() => inspectImageHeader(jpeg.subarray(0, 15)), /JPEG/i);
});

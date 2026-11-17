import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBoundedPng } from "../../../src/image/png.ts";
import { chunk, pngFixture } from "./fixtures.ts";

test("PNG decoding preserves RGBA and normalizes grayscale, palette and 16-bit samples", () => {
	assert.deepEqual([...decodeBoundedPng(pngFixture(2, 1, { raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]) })).data], [255, 0, 0, 0, 0, 255, 0, 128]);
	assert.deepEqual([...decodeBoundedPng(pngFixture(1, 1, { color: 0, raw: Buffer.from([0, 127]) })).data], [127, 127, 127, 255]);
	assert.deepEqual([...decodeBoundedPng(pngFixture(1, 1, { color: 3, extra: [chunk("PLTE", Buffer.from([0, 128, 255])), chunk("tRNS", Buffer.from([64]))], raw: Buffer.from([0, 0]) })).data], [0, 128, 255, 64]);
	assert.deepEqual([...decodeBoundedPng(pngFixture(1, 1, { depth: 16, color: 0, raw: Buffer.from([0, 255, 255]) })).data], [255, 255, 255, 255]);
});

test("PNG inflate guard rejects excess decoded data for ordinary and Adam7 images", () => {
	for (const interlace of [0, 1]) assert.throws(() => decodeBoundedPng(pngFixture(1, 1, { interlace, raw: Buffer.alloc(2 * 1024 * 1024) })), /decompress|inflate|scanline/i);
	assert.deepEqual([...decodeBoundedPng(pngFixture(1, 1, { interlace: 1, raw: Buffer.from([0, 1, 2, 3, 4]) })).data], [1, 2, 3, 4]);
	assert.throws(() => decodeBoundedPng(pngFixture(1, 1, { raw: Buffer.alloc(4) })), /scanline/i);
});

test("PNG validates CRC and applies its bounded EXIF orientation before thumbnailing", () => {
	const invalid = pngFixture(); invalid[29] = (invalid[29] ?? 0) ^ 1;
	assert.throws(() => decodeBoundedPng(invalid), /CRC/i);
	const tiff = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
	const decoded = decodeBoundedPng(pngFixture(2, 1, { extra: [chunk("eXIf", tiff)], raw: Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]) }));
	assert.equal(decoded.width, 1); assert.equal(decoded.height, 2);
	assert.deepEqual([...decoded.data], [255, 0, 0, 255, 0, 0, 255, 255]);
	assert.throws(() => decodeBoundedPng(pngFixture(), AbortSignal.abort()), /cancel/i);
});

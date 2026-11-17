import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalImage } from "../../../src/image/local-image.ts";
import { decodeBoundedPng, encodeRasterPng } from "../../../src/image/png.ts";
import { pngFixture } from "./fixtures.ts";

test("local image preview returns bounded native PNG and RGBA thumbnail while preserving alpha", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-image-"));
	try {
		await writeFile(join(dir, "image.wrong-extension"), pngFixture(2, 1, { raw: Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128]) }));
		const result = await loadLocalImage("image.wrong-extension", dir);
		assert.equal(result.path, join(dir, "image.wrong-extension"));
		assert.equal(result.sourceMime, "image/png"); assert.equal(result.frame, "first");
		assert.equal(result.sourceWidth, 2); assert.equal(result.sourceHeight, 1);
		assert.deepEqual([...Buffer.from(result.thumbnail.rgbaBase64, "base64")], [255, 0, 0, 0, 0, 255, 0, 128]);
		assert.deepEqual([...decodeBoundedPng(Buffer.from(result.pngBase64, "base64")).data], [255, 0, 0, 0, 0, 255, 0, 128]);
		await writeFile(join(dir, "large.png"), pngFixture(1000, 1000));
		const large = await loadLocalImage("large.png", dir);
		assert.equal(large.width, 480); assert.equal(large.height, 480);
		assert.equal(large.thumbnail.width, 160); assert.equal(large.thumbnail.height, 160);
		assert.ok(large.pngBase64.length <= 2 * 1024 * 1024);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("local image preview rejects URLs, network paths, nonregular files, excessive bytes and cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-image-reject-"));
	try {
		for (const path of ["https://example.com/image.png", "file:///image.png", "\\\\server\\share\\image.png"]) await assert.rejects(loadLocalImage(path, dir), /local|URL|network/i);
		await assert.rejects(loadLocalImage(dir, dir), /regular|directory|access|EPERM|EISDIR/i);
		const path = join(dir, "large.png"), file = await open(path, "w");
		await file.truncate(8 * 1024 * 1024 + 1); await file.close();
		await assert.rejects(loadLocalImage(path, dir), /8 MiB/i);
		await assert.rejects(loadLocalImage("missing.png", dir, AbortSignal.abort()), /cancel/i);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("public Pi conversion prepares GIF and WebP offline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-image-formats-"));
	try {
		for (const [extension, base64] of [
			["gif", "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="],
			["webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"],
		] as const) {
			await writeFile(join(dir, `image.${extension}`), Buffer.from(base64, "base64"));
			const result = await loadLocalImage(`image.${extension}`, dir);
			assert.equal(result.sourceMime, `image/${extension}`); assert.equal(result.width, 1); assert.equal(result.height, 1);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("public Pi JPEG conversion applies EXIF orientation before native and terminal previews", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-image-exif-"));
	try {
		const { resizeImage } = await import("@earendil-works/pi-coding-agent");
		const data = Uint8Array.from({ length: 200 * 100 * 4 }, (_, index) => (index * 37 + Math.floor(index / 61) * 51) % 256);
		const jpeg = await resizeImage(encodeRasterPng({ width: 200, height: 100, data }), "image/png", { maxWidth: 100, maxHeight: 50, maxBytes: 512 * 1024 });
		assert.equal(jpeg?.mimeType, "image/jpeg"); assert.ok(jpeg);
		const source = Buffer.from(jpeg.data, "base64");
		const tiff = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
		await writeFile(join(dir, "oriented.jpg"), Buffer.concat([source.subarray(0, 2), Buffer.from([255, 225, 0, 34]), Buffer.from("Exif\0\0", "binary"), tiff, source.subarray(2)]));
		const image = await loadLocalImage("oriented.jpg", dir);
		assert.equal(image.sourceWidth, 100); assert.equal(image.sourceHeight, 50);
		assert.equal(image.width, 50); assert.equal(image.height, 100);
		assert.equal(image.thumbnail.width, 50); assert.equal(image.thumbnail.height, 100);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

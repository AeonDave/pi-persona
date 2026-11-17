import { IMAGE_MAX_AXIS, IMAGE_MAX_PIXELS } from "../core/image-preview.ts";
import { crc32 } from "node:zlib";

export interface ImageHeader { mime: string; width: number; height: number }

export function checkImageCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Image preview cancelled");
}

export function checkImageDimensions(width: number, height: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > IMAGE_MAX_AXIS || height > IMAGE_MAX_AXIS) {
		throw new Error(`Image dimensions must be positive and at most ${IMAGE_MAX_AXIS} per axis`);
	}
	if (width * height > IMAGE_MAX_PIXELS) throw new Error(`Image exceeds ${IMAGE_MAX_PIXELS} source pixels`);
}

function fail(format: string): never { throw new Error(`Malformed or truncated ${format} image`); }
const ascii = (bytes: Buffer, offset: number, text: string): boolean => bytes.toString("latin1", offset, offset + text.length) === text;

function pngHeader(bytes: Buffer, signal?: AbortSignal): ImageHeader {
	if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || !ascii(bytes, 12, "IHDR")) fail("PNG");
	const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
	checkImageDimensions(width, height);
	let offset = 8, idat = false, ended = false, palette = 0, chunks = 0;
	while (offset + 12 <= bytes.length) {
		checkImageCancelled(signal);
		if (++chunks > 4096) throw new Error("PNG exceeds chunk count budget");
		const length = bytes.readUInt32BE(offset), next = offset + length + 12;
		if (next > bytes.length) fail("PNG");
		for (let index = offset + 4; index < offset + 8; index++) {
			const byte = bytes[index]!;
			if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) fail("PNG chunk type");
		}
		if ((bytes[offset + 6]! & 0x20) !== 0) fail("PNG reserved chunk type");
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		if (!(bytes[offset + 4]! & 0x20) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) fail("PNG critical chunk type");
		if (crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) throw new Error("PNG CRC mismatch");
		if (type === "IHDR" && offset !== 8) fail("PNG");
		if (type === "PLTE") {
			if (idat || palette || !length || length > 768 || length % 3) fail("PNG palette");
			palette = length / 3;
		}
		if (type === "tRNS") {
			const color = bytes[25];
			if (idat || !(color === 0 ? length === 2 : color === 2 ? length === 6 : color === 3 && palette > 0 && length <= palette)) fail("PNG transparency");
		}
		if (type === "gAMA" && length !== 4) fail("PNG gamma");
		if (type === "acTL") throw new Error("Animated PNG is not supported; use a static PNG frame");
		if (type === "IDAT") idat = true;
		if (type === "IEND") { if (length !== 0 || next !== bytes.length) fail("PNG"); ended = true; break; }
		offset = next;
	}
	if (!idat || !ended || (bytes[25] === 3 && !palette)) fail("PNG");
	return { mime: "image/png", width, height };
}

function jpegHeader(bytes: Buffer, signal?: AbortSignal): ImageHeader {
	let offset = 2;
	let width = 0, height = 0;
	while (offset + 1 < bytes.length) {
		checkImageCancelled(signal);
		if (bytes[offset++] !== 0xff) fail("JPEG");
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (marker === undefined || marker === 0xd9) fail("JPEG");
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.length) fail("JPEG");
		const length = bytes.readUInt16BE(offset);
		if (length < 2 || offset + length > bytes.length) fail("JPEG");
		if (marker === 0xda) {
			if (!width || !height) fail("JPEG");
			return { mime: "image/jpeg", width, height };
		}
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			if (length < 8) fail("JPEG");
			const nextHeight = bytes.readUInt16BE(offset + 3), nextWidth = bytes.readUInt16BE(offset + 5);
			checkImageDimensions(nextWidth, nextHeight);
			if (width && (width !== nextWidth || height !== nextHeight)) throw new Error("Conflicting JPEG frame dimensions");
			width = nextWidth; height = nextHeight;
		}
		offset += length;
	}
	return fail("JPEG");
}

function gifHeader(bytes: Buffer, signal?: AbortSignal): ImageHeader {
	if (bytes.length < 13) fail("GIF");
	const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
	checkImageDimensions(width, height);
	let offset = 13 + ((bytes[10]! & 0x80) ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0);
	let frames = 0, pixels = 0;
	const skipBlocks = (): void => {
		while (offset < bytes.length) {
			checkImageCancelled(signal);
			const length = bytes[offset++]!;
			if (offset + length > bytes.length) fail("GIF");
			offset += length;
			if (!length) return;
		}
		fail("GIF");
	};
	while (offset < bytes.length) {
		checkImageCancelled(signal);
		const kind = bytes[offset++];
		if (kind === 0x3b) { if (!frames) fail("GIF"); return { mime: "image/gif", width, height }; }
		if (kind === 0x21) { if (offset >= bytes.length) fail("GIF"); offset++; skipBlocks(); continue; }
		if (kind !== 0x2c || offset + 9 > bytes.length) fail("GIF");
		const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6);
		checkImageDimensions(frameWidth, frameHeight);
		if (bytes.readUInt16LE(offset) + frameWidth > width || bytes.readUInt16LE(offset + 2) + frameHeight > height) fail("GIF frame bounds");
		// Budget whole compositing canvases as well as individual frame rectangles.
		pixels += width * height;
		if (++frames > 256 || pixels > IMAGE_MAX_PIXELS) throw new Error("GIF exceeds frame/pixel budget");
		const packed = bytes[offset + 8]!;
		offset += 9 + ((packed & 0x80) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
		if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) fail("GIF");
		offset++; skipBlocks();
	}
	return fail("GIF");
}

function webpHeader(bytes: Buffer, signal?: AbortSignal): ImageHeader {
	if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) fail("WebP");
	let width = 0, height = 0, decoded = false, frames = 0, pixels = 0;
	const scan = (start: number, end: number, frame = false): void => {
		let offset = start;
		while (offset + 8 <= end) {
			checkImageCancelled(signal);
			const length = bytes.readUInt32LE(offset + 4), data = offset + 8, next = data + length + (length & 1);
			if (next > end) fail("WebP");
			const type = bytes.toString("ascii", offset, offset + 4);
			let w = 0, h = 0;
			if (type === "VP8X") {
				if (frame || length !== 10) fail("WebP");
				width = bytes.readUIntLE(data + 4, 3) + 1; height = bytes.readUIntLE(data + 7, 3) + 1;
				checkImageDimensions(width, height);
			} else if (type === "VP8 ") {
				if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 1 || bytes[data + 5] !== 0x2a) fail("WebP");
				w = bytes.readUInt16LE(data + 6) & 0x3fff; h = bytes.readUInt16LE(data + 8) & 0x3fff;
			} else if (type === "VP8L") {
				if (length < 5 || bytes[data] !== 0x2f) fail("WebP");
				const bits = bytes.readUInt32LE(data + 1);
				w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
			} else if (type === "ANMF") {
				if (frame || length < 16 || !width || !height) fail("WebP");
				const fw = bytes.readUIntLE(data + 6, 3) + 1, fh = bytes.readUIntLE(data + 9, 3) + 1;
				checkImageDimensions(fw, fh);
				if (bytes.readUIntLE(data, 3) * 2 + fw > width || bytes.readUIntLE(data + 3, 3) * 2 + fh > height) fail("WebP frame bounds");
				scan(data + 16, data + length, true);
			}
			if (w && h) {
				checkImageDimensions(w, h);
				if (width && height && (w > width || h > height)) fail("WebP frame bounds");
				pixels += width && height ? width * height : w * h;
				if (++frames > 256 || pixels > IMAGE_MAX_PIXELS) throw new Error("WebP exceeds frame/pixel budget");
				if (!width) { width = w; height = h; }
				decoded = true;
			}
			offset = next;
		}
		if (offset !== end) fail("WebP");
	};
	scan(12, bytes.length);
	if (!decoded) fail("WebP");
	return { mime: "image/webp", width, height };
}

/** Header/structure inspection only: never decompresses image data. */
export function inspectImageHeader(input: Uint8Array, signal?: AbortSignal): ImageHeader {
	checkImageCancelled(signal);
	const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return pngHeader(bytes, signal);
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes, signal);
	if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return gifHeader(bytes, signal);
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpHeader(bytes, signal);
	throw new Error("Image preview supports local PNG, JPEG, GIF and WebP files only");
}

import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import type { RgbaImage } from "../core/image-preview.ts";
import { checkImageCancelled, inspectImageHeader } from "./image-header.ts";

function exifOrientation(bytes: Buffer, signal?: AbortSignal): number {
	if (bytes.length < 8) return 1;
	const le = bytes.toString("ascii", 0, 2) === "II";
	if (!le && bytes.toString("ascii", 0, 2) !== "MM") return 1;
	const read16 = (at: number): number => le ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
	const read32 = (at: number): number => le ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
	if (read16(2) !== 42) return 1;
	const offset = read32(4);
	if (offset > bytes.length - 2) return 1;
	const count = read16(offset);
	for (let index = 0; index < count; index++) {
		checkImageCancelled(signal);
		const at = offset + 2 + index * 12;
		if (at + 12 > bytes.length) return 1;
		if (read16(at) === 0x112 && read16(at + 2) === 3 && read32(at + 4) === 1) {
			const orientation = read16(at + 8);
			return orientation >= 1 && orientation <= 8 ? orientation : 1;
		}
	}
	return 1;
}

function orientedRaster(raster: RgbaImage, orientation: number, signal?: AbortSignal): RgbaImage {
	if (orientation === 1) return raster;
	const { width: w, height: h, data: source } = raster;
	const width = orientation >= 5 ? h : w, height = orientation >= 5 ? w : h;
	const data = new Uint8Array(source.length);
	for (let y = 0; y < h; y++) {
		checkImageCancelled(signal);
		for (let x = 0; x < w; x++) {
			let dx = x, dy = y;
			switch (orientation) {
				case 2: dx = w - 1 - x; break;
				case 3: dx = w - 1 - x; dy = h - 1 - y; break;
				case 4: dy = h - 1 - y; break;
				case 5: dx = y; dy = x; break;
				case 6: dx = h - 1 - y; dy = x; break;
				case 7: dx = h - 1 - y; dy = w - 1 - x; break;
				case 8: dx = y; dy = w - 1 - x; break;
			}
			const from = (y * w + x) * 4, to = (dy * width + dx) * 4;
			data.set(source.subarray(from, from + 4), to);
		}
	}
	return { width, height, data };
}

function expectedScanlineBytes(width: number, height: number, channels: number, depth: number, interlace: number): number {
	const rowBytes = (w: number, h: number): number => w && h ? (Math.ceil(w * channels * depth / 8) + 1) * h : 0;
	if (!interlace) return rowBytes(width, height);
	const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
	return passes.reduce((total, [x, y, dx, dy]) => total + rowBytes(Math.max(0, Math.ceil((width - x) / dx)), Math.max(0, Math.ceil((height - y) / dy))), 0);
}

/** Validate the entire compressed stream before pngjs can enter its unbounded Adam7 inflater. */
export function decodeBoundedPng(input: Uint8Array, signal?: AbortSignal): RgbaImage {
	const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const header = inspectImageHeader(bytes, signal);
	if (header.mime !== "image/png") throw new Error("PNG decoder requires PNG bytes");
	const depth = bytes[24]!, color = bytes[25]!, interlace = bytes[28]!;
	const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Readonly<Record<number, number>>)[color];
	const depths = color === 3 ? [1, 2, 4, 8] : color === 0 ? [1, 2, 4, 8, 16] : [8, 16];
	if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw new Error("Unsupported PNG encoding");
	const data: Buffer[] = [];
	let orientation = 1;
	for (let offset = 8; offset + 12 <= bytes.length;) {
		checkImageCancelled(signal);
		const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") data.push(bytes.subarray(offset + 8, offset + 8 + length));
		if (type === "eXIf") orientation = exifOrientation(bytes.subarray(offset + 8, offset + 8 + length), signal);
		offset += length + 12;
	}
	const expected = expectedScanlineBytes(header.width, header.height, channels, depth, interlace);
	try {
		const inflated = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
		if (inflated.length !== expected) throw new Error("PNG scanline length mismatch");
	} catch (error) {
		throw new Error(`PNG decompression/scanline validation failed: ${error instanceof Error ? error.message : "invalid compressed data"}`);
	}
	checkImageCancelled(signal);
	const decoded = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false });
	if (decoded.width !== header.width || decoded.height !== header.height || decoded.data.length !== header.width * header.height * 4) throw new Error("Decoded PNG dimensions or RGBA size mismatch");
	checkImageCancelled(signal);
	return orientedRaster({ width: decoded.width, height: decoded.height, data: decoded.data }, orientation, signal);
}

export function encodeRasterPng(raster: RgbaImage): Buffer {
	const image = new PNG({ width: raster.width, height: raster.height });
	image.data = Buffer.from(raster.data);
	return PNG.sync.write(image, { colorType: 6, inputColorType: 6, bitDepth: 8 });
}

import { isAbsolute, resolve } from "node:path";
import { IMAGE_MAX_FILE_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_PNG_BASE64, IMAGE_MAX_THUMBNAIL_BASE64, IMAGE_NATIVE_WIDTH, IMAGE_NATIVE_HEIGHT, IMAGE_THUMBNAIL_AXIS, resizeRgba, type ImagePreviewData } from "../core/image-preview.ts";
import { checkImageCancelled, inspectImageHeader } from "./image-header.ts";
import { decodeBoundedPng, encodeRasterPng } from "./png.ts";
import { readBoundedRegularFile } from "../io/read-bounded-file.ts";

export type { ImagePreviewData } from "../core/image-preview.ts";

/** Prepare display data only; no image block is sent to a model and no network resource is opened. */
export async function loadLocalImage(path: string, cwd: string, signal?: AbortSignal): Promise<ImagePreviewData> {
	checkImageCancelled(signal);
	if (!path || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) || /^[\\/]{2}/.test(path)) {
		throw new Error("Image preview accepts local file paths only, not URLs or network paths");
	}
	const target = isAbsolute(path) ? path : resolve(cwd, path);
	const bytes = await readBoundedRegularFile(target, { label: "Image preview", maxBytes: IMAGE_MAX_FILE_BYTES, limitLabel: "8 MiB" }, signal);
	const header = inspectImageHeader(bytes, signal);
	let pngBytes: Uint8Array = bytes;
	if (header.mime !== "image/png") {
		const { convertToPng } = await import("@earendil-works/pi-coding-agent");
		checkImageCancelled(signal);
		const converted = await convertToPng(bytes.toString("base64"), header.mime);
		checkImageCancelled(signal);
		if (!converted || converted.mimeType !== "image/png") throw new Error("Image preview could not decode this image with the current Pi runtime");
		// The host conversion is source-pixel bounded, but its encoded intermediate may be larger than the input file.
		if (converted.data.length > Math.ceil((IMAGE_MAX_PIXELS * 8 + 65_536) / 3) * 4) throw new Error("Converted image exceeds intermediate byte budget");
		pngBytes = Buffer.from(converted.data, "base64");
	}
	const raster = decodeBoundedPng(pngBytes, signal);
	if (!((raster.width === header.width && raster.height === header.height) || (raster.width === header.height && raster.height === header.width))) throw new Error("Decoded image differs from its admitted dimensions");
	checkImageCancelled(signal);
	const native = resizeRgba(raster, IMAGE_NATIVE_WIDTH, IMAGE_NATIVE_HEIGHT), thumbnail = resizeRgba(raster, IMAGE_THUMBNAIL_AXIS, IMAGE_THUMBNAIL_AXIS);
	const pngBase64 = encodeRasterPng(native).toString("base64");
	const rgbaBase64 = Buffer.from(thumbnail.data).toString("base64");
	if (pngBase64.length > IMAGE_MAX_PNG_BASE64 || rgbaBase64.length > IMAGE_MAX_THUMBNAIL_BASE64) throw new Error("Image preview exceeds display payload budget");
	checkImageCancelled(signal);
	return { path: target, sourceMime: header.mime, sourceBytes: bytes.length, sourceWidth: header.width, sourceHeight: header.height,
		width: native.width, height: native.height, pngBase64,
		thumbnail: { width: thumbnail.width, height: thumbnail.height, rgbaBase64 }, frame: "first" };
}

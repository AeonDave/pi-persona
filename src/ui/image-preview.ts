import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Image, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	IMAGE_MAX_AXIS, IMAGE_MAX_FILE_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_PNG_BASE64,
	IMAGE_NATIVE_HEIGHT, IMAGE_NATIVE_WIDTH, IMAGE_THUMBNAIL_AXIS,
	nativeImageColumns, renderImageCells, useNativeImagePreview, type ImagePreviewData, type ImagePreviewMode, type PreviewColor,
} from "../core/image-preview.ts";
export interface ImagePreviewContext { theme: Theme; showImages: boolean; expanded: boolean; mode: ImagePreviewMode }

function base64Length(value: unknown, maximum: number): number | undefined {
	if (typeof value !== "string" || !value.length || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0) return undefined;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
	const bytes = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
	return bytes <= maximum ? bytes : undefined;
}

/** Saved tool details are untrusted; check lengths before decoding anything. */
export function isImagePreviewData(value: unknown): value is ImagePreviewData {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const bounded = (n: unknown, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= max;
	if (typeof v.path !== "string" || v.path.length > 4096 || typeof v.sourceMime !== "string" || v.sourceMime.length > 100) return false;
	if (!bounded(v.sourceBytes, IMAGE_MAX_FILE_BYTES) || !bounded(v.sourceWidth, IMAGE_MAX_AXIS) || !bounded(v.sourceHeight, IMAGE_MAX_AXIS)) return false;
	if (v.sourceWidth * v.sourceHeight > IMAGE_MAX_PIXELS || !bounded(v.width, IMAGE_NATIVE_WIDTH) || !bounded(v.height, IMAGE_NATIVE_HEIGHT) || v.frame !== "first") return false;
	if (typeof v.pngBase64 !== "string" || v.pngBase64.length > IMAGE_MAX_PNG_BASE64 || base64Length(v.pngBase64, IMAGE_MAX_PNG_BASE64) === undefined) return false;
	// Read only the fixed PNG header after the length/character checks; never decode an entire
	// untrusted historical image just to decide which terminal protocol to use.
	const header = Buffer.from(v.pngBase64.slice(0, 32), "base64");
	if (header.length < 24 || !header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR" || header.readUInt32BE(16) !== v.width || header.readUInt32BE(20) !== v.height) return false;
	if (!v.thumbnail || typeof v.thumbnail !== "object") return false;
	const t = v.thumbnail as Record<string, unknown>;
	return bounded(t.width, IMAGE_THUMBNAIL_AXIS) && bounded(t.height, IMAGE_THUMBNAIL_AXIS)
		&& base64Length(t.rgbaBase64, IMAGE_THUMBNAIL_AXIS ** 2 * 4) === t.width * t.height * 4;
}

/** Pi owns graphics protocols and alternate-screen overrides; uncertain Herdr output uses cells. */
export function createImagePreview(data: ImagePreviewData, context: ImagePreviewContext): Component {
	if (!isImagePreviewData(data)) return { invalidate() {}, render: (width) => width > 0 ? ["Image preview unavailable".slice(0, width)] : [] };
	const maxHeight = context.expanded ? 20 : 8;
	const native = new Image(data.pngBase64, "image/png", { fallbackColor: (text) => context.theme.fg("dim", text) },
		{ maxWidthCells: 60, maxHeightCells: maxHeight }, { widthPx: data.width, heightPx: data.height });
	const pixels = Uint8Array.from(Buffer.from(data.thumbnail.rgbaBase64, "base64"));
	let previousProtocol: ReturnType<typeof getCapabilities>["images"] | undefined;
	let previousCellWidth: number | undefined;
	let previousCellHeight: number | undefined;
	return {
		invalidate() { native.invalidate(); },
		render(width) {
			if (width <= 0) return [];
			if (!context.showImages) return ["Image previews disabled".slice(0, width)];
			const caps = getCapabilities();
			if (caps.images !== previousProtocol) { native.invalidate(); previousProtocol = caps.images; }
			const term = (process.env.TERM ?? "").toLowerCase();
			const locale = (process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "").toLowerCase();
			const noColor = process.env.NO_COLOR !== undefined || term === "dumb";
			const unicode = !noColor && (!locale || /utf-?8/.test(locale)) && context.mode !== "ascii";
			if (context.mode === "auto" && unicode && useNativeImagePreview(caps.images, process.env.TERM_PROGRAM, process.env.PI_IMAGE_PROTOCOL)) {
				const cells = getCellDimensions();
				if (cells.widthPx !== previousCellWidth || cells.heightPx !== previousCellHeight) {
					native.invalidate(); previousCellWidth = cells.widthPx; previousCellHeight = cells.heightPx;
				}
				// Use the host's own reservation geometry, including Kitty's cell aspect adjustment.
				const columns = nativeImageColumns(data, Math.max(1, Math.min(width - 2, 60)), maxHeight, cells, caps.images === "kitty");
				const padding = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
				return native.render(width).map(line => line ? padding + line : line);
			}
			let color: PreviewColor = "none";
			if (unicode) color = caps.trueColor ? "truecolor" : term.includes("256color") ? "256" : "16";
			const rows = renderImageCells({ width: data.thumbnail.width, height: data.thumbnail.height, data: pixels },
				{ width: Math.min(width, 60), height: maxHeight, color, unicode, background: context.theme.appearance === "light" ? [255, 255, 255] : [0, 0, 0] });
			const columns = rows.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
			const padding = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
			return rows.map(line => padding + line);
		},
	};
}

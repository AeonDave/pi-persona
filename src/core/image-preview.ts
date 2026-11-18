/** Bounded pixel helpers and display policy: no host imports, filesystem, or decoding. */
export interface RgbaImage {
	width: number;
	height: number;
	data: Uint8Array;
}
export type ImagePreviewMode = "auto" | "ansi" | "ascii";
export type PreviewColor = "truecolor" | "256" | "16" | "none";

/** Herdr hides its outer terminal, so its Kitty advertisement alone cannot prove display support. */
export function useNativeImagePreview(protocol: "kitty" | "iterm2" | null, terminalProgram?: string, protocolOverride?: string): boolean {
	if (!protocol) return false;
	if (terminalProgram?.toLowerCase() !== "herdr") return true;
	const explicit = protocolOverride?.toLowerCase();
	return explicit === "kitty" || explicit === "iterm2";
}

/**
 * Columns the host reserves for a native image. Mirrors pi-tui's `calculateImageCellSize`, which
 * its package root does not export: Pi's extension loader resolves host packages by root entry, so
 * a deep `dist/` import fails when the extension loads. The unit test pins this to the host's.
 */
export function nativeImageColumns(image: { width: number; height: number }, maxColumns: number, maxRows: number,
	cell: { widthPx: number; heightPx: number }, optimizeAspectRatio: boolean): number {
	const maxWidth = Math.max(1, Math.floor(maxColumns));
	const maxHeight = Math.max(1, Math.floor(maxRows));
	const width = Math.max(1, image.width);
	const height = Math.max(1, image.height);
	const widthScale = maxWidth * cell.widthPx / width;
	const heightScale = maxHeight * cell.heightPx / height;
	const scale = Math.min(widthScale, heightScale);
	const columns = Math.max(1, Math.min(maxWidth, Math.ceil(width * scale / cell.widthPx)));
	if (!optimizeAspectRatio || widthScale <= heightScale || columns <= 1) return columns;
	const rows = Math.min(maxHeight, Math.max(1, Math.ceil(height * scale / cell.heightPx)));
	const ideal = rows * cell.heightPx * width / (height * cell.widthPx);
	const distortion = (count: number): number => Math.max(count / ideal, ideal / count);
	return distortion(columns - 1) < distortion(columns) ? columns - 1 : columns;
}

export const IMAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_MAX_AXIS = 16_384;
export const IMAGE_NATIVE_WIDTH = 640;
export const IMAGE_NATIVE_HEIGHT = 480;
export const IMAGE_THUMBNAIL_AXIS = 160;
export const IMAGE_MAX_PNG_BASE64 = 2 * 1024 * 1024;
export const IMAGE_MAX_THUMBNAIL_BASE64 = Math.ceil(IMAGE_THUMBNAIL_AXIS ** 2 * 4 / 3) * 4;
export interface ImagePreviewData {
	path: string;
	sourceMime: string;
	sourceBytes: number;
	sourceWidth: number;
	sourceHeight: number;
	width: number;
	height: number;
	pngBase64: string;
	thumbnail: { width: number; height: number; rgbaBase64: string };
	frame: "first";
}

function validate(image: RgbaImage): void {
	if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
		|| image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
		throw new Error("Invalid RGBA image");
	}
}

/** Fit within bounds, never upscale. Average covered pixels in premultiplied-alpha space. */
export function resizeRgba(image: RgbaImage, maxWidth: number, maxHeight: number): RgbaImage {
	validate(image);
	if (!Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth < 1 || maxHeight < 1) throw new Error("Invalid image bounds");
	const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
	const width = Math.max(1, Math.floor(image.width * scale));
	const height = Math.max(1, Math.floor(image.height * scale));
	if (width === image.width && height === image.height) return { width, height, data: image.data.slice() };
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const y0 = y * image.height / height, y1 = (y + 1) * image.height / height;
		for (let x = 0; x < width; x++) {
			const x0 = x * image.width / width, x1 = (x + 1) * image.width / width;
			let alpha = 0, red = 0, green = 0, blue = 0;
			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const vertical = Math.min(sy + 1, y1) - Math.max(sy, y0);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const weight = vertical * (Math.min(sx + 1, x1) - Math.max(sx, x0));
					const source = (sy * image.width + sx) * 4;
					const opacity = image.data[source + 3]! * weight;
					alpha += opacity;
					red += image.data[source]! * opacity;
					green += image.data[source + 1]! * opacity;
					blue += image.data[source + 2]! * opacity;
				}
			}
			const target = (y * width + x) * 4;
			if (alpha > 0) {
				data[target] = Math.round(red / alpha);
				data[target + 1] = Math.round(green / alpha);
				data[target + 2] = Math.round(blue / alpha);
			}
			data[target + 3] = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
		}
	}
	return { width, height, data };
}

type Rgb = readonly [number, number, number];
function luminance([r, g, b]: Rgb): number {
	return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
const PALETTE: readonly Rgb[] = [
	[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
	[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function ansi(rgb: Rgb, background: boolean, color: PreviewColor): string {
	const [r, g, b] = rgb;
	if (color === "truecolor") return `\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;
	if (color === "256") return `\x1b[${background ? 48 : 38};5;${16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5)}m`;
	let best = 0, distance = Infinity;
	for (let i = 0; i < PALETTE.length; i++) {
		const p = PALETTE[i]!;
		const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
		if (d < distance) { best = i; distance = d; }
	}
	return `\x1b[${(background ? (best < 8 ? 40 : 100) : (best < 8 ? 30 : 90)) + best % 8}m`;
}

export function renderImageCells(image: RgbaImage, options: { width: number; height: number; color: PreviewColor; unicode: boolean; background: Rgb }): string[] {
	validate(image);
	const width = Math.floor(options.width), height = Math.floor(options.height);
	if (width < 1 || height < 1) return [];
	const useBlocks = options.unicode && options.color !== "none";
	const invertAscii = luminance(options.background) >= 128;
	const sampled = resizeRgba(image, width, height * 2);
	const pixel = (x: number, y: number): Rgb => {
		const i = (Math.min(y, sampled.height - 1) * sampled.width + x) * 4;
		const a = sampled.data[i + 3]! / 255;
		const blend = (channel: number): number => Math.round(sampled.data[i + channel]! * a + options.background[channel]! * (1 - a));
		return [blend(0), blend(1), blend(2)];
	};
	const rows: string[] = [];
	for (let y = 0; y < sampled.height; y += 2) {
		let line = "";
		for (let x = 0; x < sampled.width; x++) {
			const top = pixel(x, y), bottom = pixel(x, y + 1);
			if (useBlocks) line += `${ansi(top, false, options.color)}${ansi(bottom, true, options.color)}▀`;
			else {
				const value = (luminance(top) + luminance(bottom)) / 2;
				const index = Math.min(9, Math.floor(value / 256 * 10));
				line += " .:-=+*#%@"[invertAscii ? 9 - index : index];
			}
		}
		rows.push(line + (useBlocks ? "\x1b[0m" : ""));
	}
	return rows;
}

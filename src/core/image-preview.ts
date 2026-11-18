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

/** Fit within bounds, never upscale. Nearest-neighbour preserves the source alpha. */
export function resizeRgba(image: RgbaImage, maxWidth: number, maxHeight: number): RgbaImage {
	validate(image);
	if (!Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth < 1 || maxHeight < 1) throw new Error("Invalid image bounds");
	const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
	const width = Math.max(1, Math.floor(image.width * scale));
	const height = Math.max(1, Math.floor(image.height * scale));
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const source = (Math.floor((y + 0.5) * image.height / height) * image.width + Math.floor((x + 0.5) * image.width / width)) * 4;
			data.set(image.data.subarray(source, source + 4), (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

type Rgb = readonly [number, number, number];
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
				const value = (top[0] + bottom[0]) * 0.1063 + (top[1] + bottom[1]) * 0.3576 + (top[2] + bottom[2]) * 0.0361;
				line += " .:-=+*#%@"[Math.min(9, Math.floor(value / 256 * 10))];
			}
		}
		rows.push(line + (useBlocks ? "\x1b[0m" : ""));
	}
	return rows;
}

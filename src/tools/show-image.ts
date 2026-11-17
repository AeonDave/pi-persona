/** One display tool: Pi owns native graphics; bounded pixels support basic terminals. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ImagePreviewMode } from "../core/image-preview.ts";
import type { ImagePreviewData } from "../image/local-image.ts";
import { expandDetailHint } from "../extension/shared.ts";
import { createCardFrame } from "../ui/card-frame.ts";
import { createImagePreview, isImagePreviewData } from "../ui/image-preview.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "../ui/presentation.ts";

const parameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096, description: "Local PNG, JPEG, GIF or WebP file; absolute or relative to the current cwd. No URLs." }),
	mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("ansi"), Type.Literal("ascii")], { description: "auto uses Pi graphics when supported, otherwise terminal cells; ansi/ascii force a text preview" })),
});

export interface ShowImageDetails {
	mode: ImagePreviewMode;
	image?: ImagePreviewData;
}

export interface ShowImageToolOptions {
	authorize?: () => boolean | Promise<boolean>;
}

export function makeShowImageTool(options: ShowImageToolOptions = {}): ToolDefinition<typeof parameters, ShowImageDetails> {
	return {
		name: "show_image",
		label: "Show image",
		description: "Show a local PNG, JPEG, GIF or WebP image to the user in the terminal. Uses native Pi graphics or a bounded ANSI/ASCII preview without external programs. First frame only; input up to 8 MiB and 16 million pixels. Returns metadata, not image content to the model; use read for model visual analysis. No URL fetching or file changes.",
		promptSnippet: "Display a local image to the user with show_image; use read when you need to analyze it",
		parameters,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		outputSchema: Type.Object({
			path: Type.String(), mimeType: Type.String(), width: Type.Integer(), height: Type.Integer(),
			previewWidth: Type.Integer(), previewHeight: Type.Integer(), frame: Type.Literal("first"),
		}),
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const mode = params.mode ?? "auto";
			try {
				if (options.authorize && !(await options.authorize())) throw new Error("show_image is not authorized in this context");
				if (signal?.aborted) throw new Error("Image preview cancelled");
				if (!["auto", "ansi", "ascii"].includes(mode)) throw new Error("show_image mode must be auto, ansi or ascii");
				if (typeof params.path !== "string" || !params.path.trim() || params.path.length > 4096) throw new Error("show_image requires a local path of 1–4096 characters");
				const { loadLocalImage } = await import("../image/local-image.ts");
				const image = await loadLocalImage(params.path, ctx.cwd, signal);
				const structuredContent = { path: image.path, mimeType: image.sourceMime, width: image.sourceWidth,
					height: image.sourceHeight, previewWidth: image.width, previewHeight: image.height, frame: image.frame };
				const display = ctx.hasUI ? "Prepared a terminal preview" : "Prepared a preview; no interactive display is attached";
				const text = `${display}: ${JSON.stringify(image.path)} · ${image.sourceMime} · ${image.sourceWidth}×${image.sourceHeight}. Preview ${image.width}×${image.height}; first frame only. Image pixels are for the user display, not model vision; use read for visual analysis.`;
				return { content: [{ type: "text", text }], structuredContent, details: { mode, image }, isError: false };
			} catch (error) {
				return { content: [{ type: "text", text: `show_image: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}` }], details: { mode: ["auto", "ansi", "ascii"].includes(mode) ? mode : "auto" }, isError: true };
			}
		},
		renderCall(args, theme, context) {
			const path = compactInlineText(typeof args.path === "string" ? args.path : "", { maxChars: 100 });
			return new Text(`${theme.fg("toolTitle", theme.bold("show_image"))}${path ? ` ${theme.fg("dim", path)}` : ""}`, context?.outputPad ?? 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const failed = context?.isError ?? result.isError ?? false;
			const image = result.details?.image;
			const valid = !failed && isImagePreviewData(image);
			const mode = result.details?.mode ?? "auto";
			const full = valid
				? `File: ${image.path}\nSource: ${image.sourceMime} · ${image.sourceWidth}×${image.sourceHeight} · ${image.sourceBytes} bytes\nPreview: ${image.width}×${image.height}\nFrame: first\nMode: ${mode}`
				: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return createCardFrame({
				title: failed ? "failed" : valid ? `preview · ${image.sourceMime.replace("image/", "").toUpperCase()} · ${image.sourceWidth}×${image.sourceHeight}` : "preview",
				state: failed ? "error" : "success",
				full,
				preview: (width) => failed ? compactVisibleText(full, { maxLines: 2, maxLineChars: width }) : { text: "", truncated: true },
				...(!failed && image ? { body: (isExpanded: boolean) => createImagePreview(image, {
					theme, expanded: isExpanded, showImages: context?.showImages ?? true, mode,
				}) } : {}),
			}, { expanded, theme, outputPad: context?.outputPad ?? 0, detailHint: () => expandDetailHint(context) });
		},
	};
}

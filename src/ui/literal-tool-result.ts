/** One compact renderer for literal control receipts and diagnostic fallbacks. Pi owns the shell. */
import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { compactLiteralText, sanitizeTerminalText } from "./presentation.ts";

interface LiteralResult {
	content: readonly { type: string; text?: string }[];
	/** Direct internal renderer calls carry this; Pi passes it in the render context. */
	isError?: boolean;
}

export function renderLiteralToolResult(
	result: LiteralResult,
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context?: { isError?: boolean; keyHint?: KeybindingHints["keyHint"] },
): Component {
	const full = sanitizeTerminalText(result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")) || "(no output)";
	const failed = context?.isError ?? result.isError ?? false;
	const heading = failed ? theme.fg("error", theme.bold("failed")) : undefined;
	if (expanded) return new Text(`${heading ? `${heading}\n` : ""}${theme.fg("toolOutput", full)}`, 0, 0);
	return {
		invalidate() { /* Preview layout follows the width supplied by the host. */ },
		render(width) {
			if (width <= 0) return [];
			const preview = compactLiteralText(full, 4, Math.min(width, 100));
			const hint = preview.truncated ? sanitizeTerminalText(context?.keyHint?.("app.tools.expand", "to expand") ?? "to expand") : undefined;
			return [
				...(heading ? [heading] : []),
				...preview.text.split("\n").map((line) => theme.fg("toolOutput", line)),
				...(hint ? [theme.fg("dim", hint)] : []),
			].map((line) => truncateToWidth(line, width, "…"));
		},
	};
}

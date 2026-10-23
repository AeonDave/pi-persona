/** One compact renderer for literal control receipts and diagnostic fallbacks. Pi owns the shell. */
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { compactVisibleText, sanitizeTerminalText } from "./presentation.ts";

interface LiteralResult {
	content: readonly { type: string; text?: string }[];
	/** Legacy direct renderer calls may carry this; the native host passes it in context. */
	isError?: boolean;
}

export function renderLiteralToolResult(
	result: LiteralResult,
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context?: { isError: boolean },
): Text {
	const full = sanitizeTerminalText(result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")) || "(no output)";
	const failed = context?.isError ?? result.isError ?? false;
	const preview = expanded ? undefined : compactVisibleText(full, { maxLines: 4, maxLineChars: 100 });
	const heading = failed ? `${theme.fg("error", theme.bold("failed"))}\n` : "";
	const hint = preview?.truncated ? `\n${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}` : "";
	return new Text(`${heading}${theme.fg("toolOutput", preview?.text ?? full)}${hint}`, 0, 0);
}

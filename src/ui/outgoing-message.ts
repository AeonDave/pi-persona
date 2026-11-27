import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderLiteralPreview, renderLiteralToolResult } from "./literal-tool-result.ts";

/** Outgoing receipts read the body from the tool call already stored by Pi. */
export function renderOutgoingMessageReceipt(
	message: string,
	receipt: { compact: string; full: string },
	options: { expanded: boolean },
	theme: Theme,
	context?: Pick<KeybindingHints, "keyHint">,
): Component {
	if (options.expanded) {
		return renderLiteralToolResult({ content: [{ type: "text", text: `${receipt.full}\n\n${message}` }] }, options, theme, context);
	}
	const previewSource = `${receipt.compact}\n${message.slice(0, 4_096)}`;
	return renderLiteralPreview(previewSource, theme, context, { hasDetails: true });
}

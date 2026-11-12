/** One presentation-only frame shared by Persona's cards and loaded local companions. */
import type { Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createReportBody } from "./report-body.ts";
import { compactInlineText, MAX_COLLAPSED_CARD_COLUMNS, sanitizeTerminalText } from "./presentation.ts";

export const CARD_FRAME_EVENT = "pi-persona:card-frame:v1";

export type CardFrameState = "neutral" | "success" | "attention" | "error";

export interface CardFramePreview {
	text: string;
	truncated: boolean;
}

export interface CardFramePresentation {
	title: string;
	state: CardFrameState;
	full: string;
	preview: (width: number) => CardFramePreview;
	metadata?: string;
	/** Selected only by trusted surface/envelope metadata, never prose keywords. */
	markdown?: boolean;
}

export interface CardFrameContext {
	expanded: boolean;
	theme: Theme;
	outputPad: number;
	detailHint: () => string;
}

export type CardFrameFactory = (presentation: CardFramePresentation, context: CardFrameContext) => Component;

export interface CardFrameProviderResponse {
	version: 1;
	provider: "pi-persona";
	createCard: CardFrameFactory;
}

export interface CardFrameQuery {
	version: 1;
	respond: (response: CardFrameProviderResponse) => void;
}

const COLORS: Record<CardFrameState, { bg: ThemeBg; fg: ThemeColor }> = {
	neutral: { bg: "customMessageBg", fg: "accent" },
	success: { bg: "toolSuccessBg", fg: "success" },
	attention: { bg: "toolPendingBg", fg: "warning" },
	error: { bg: "toolErrorBg", fg: "error" },
};

const INDENT = "  ";

/** Render one semantic card without owning its source data, status, or lifecycle. */
export function createCardFrame(card: CardFramePresentation, context: CardFrameContext): Component {
	const { expanded, theme, detailHint, outputPad } = context;
	const full = sanitizeTerminalText(card.full);
	const title = compactInlineText(card.title, { maxChars: MAX_COLLAPSED_CARD_COLUMNS });
	const metadata = card.metadata === undefined
		? undefined
		: compactInlineText(card.metadata, { maxChars: MAX_COLLAPSED_CARD_COLUMNS });
	const colors = COLORS[card.state];

	if (expanded && card.markdown) {
		return createReportBody(full || "(no output)", theme, {
			padding: outputPad,
			background: colors.bg,
			header: (width) => [
				theme.fg(colors.fg, theme.bold(truncateToWidth(title, width))),
				...(metadata ? [theme.fg("dim", truncateToWidth(metadata, width))] : []),
			].join("\n"),
		});
	}

	return {
		invalidate() { /* Literal Text path has no themed/layout cache. */ },
		render(width) {
			if (width <= 0) return [];
			const padding = Math.min(Math.max(0, Math.floor(outputPad)), Math.max(0, Math.floor((width - 1) / 2)));
			const innerWidth = Math.max(1, width - padding * 2);
			// The indent only applies where a clipped content column still fits; every compact line
			// is clipped to the remaining columns so indent + text never wrap or spill mid-word.
			const bodyPad = innerWidth > INDENT.length ? INDENT : "";
			const contentWidth = Math.max(1, innerWidth - bodyPad.length);
			const preview = expanded ? undefined : card.preview(contentWidth);
			const body = expanded ? full : sanitizeTerminalText(preview?.text ?? "(no output)");
			const previewClipped = !expanded && (preview?.truncated === true || body.split("\n").some((line) => visibleWidth(line) > contentWidth));
			const bodyLines = sanitizeTerminalText(body || "(no output)").split("\n").map((line) => expanded
				? theme.fg("toolOutput", line)
				: theme.fg("toolOutput", `${bodyPad}${truncateToWidth(line, contentWidth)}`));
			const lines = [
				theme.fg(colors.fg, theme.bold(truncateToWidth(title, innerWidth))),
				...(metadata ? [theme.fg("dim", truncateToWidth(`${bodyPad}${metadata}`, innerWidth))] : []),
				...bodyLines,
				...(previewClipped ? [theme.fg("dim", truncateToWidth(
					compactInlineText(detailHint(), { maxChars: MAX_COLLAPSED_CARD_COLUMNS }), innerWidth,
				))] : []),
			];
			// Text owns wrapping and full-row padding/background, including embedded foreground resets.
			// A terminal narrower than a single wide glyph cannot display that glyph; clip only there.
			return new Text(lines.join("\n"), padding, 0, (text) => theme.bg(colors.bg, text))
				.render(width).map((line) => truncateToWidth(line, width));
		},
	};
}

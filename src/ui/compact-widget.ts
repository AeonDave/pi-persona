import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./presentation.ts";
import type { RowSpan, StyledRow } from "./styled-row.ts";

/** The part of the host theme the widget paints with. */
export type WidgetTheme = Pick<Theme, "fg">;

const ELLIPSIS = "…";

function sanitizeSpan(text: string): string {
	// Zl/Zp are exactly U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
	return sanitizeTerminalText(text.replace(/\t/g, " ")).replace(/[\n\p{Zl}\p{Zp}]/gu, " ");
}

function spansWidth(spans: readonly RowSpan[]): number {
	return spans.reduce((sum, span) => sum + visibleWidth(span.text), 0);
}

/** Plain right-edge clip: cut at `budget - 1` columns and end with an ellipsis. */
function rightClip(spans: readonly RowSpan[], budget: number): RowSpan[] {
	const out: RowSpan[] = [];
	let used = 0;
	const limit = budget - visibleWidth(ELLIPSIS);
	for (const span of spans) {
		const width = visibleWidth(span.text);
		if (used + width <= limit) { out.push(span); used += width; continue; }
		out.push({ ...span, text: `${sliceByColumn(span.text, 0, Math.max(0, limit - used), true)}${ELLIPSIS}` });
		return out;
	}
	return out;
}

/** Fit one row into `budget` columns. Ordinary spans are shortened first — one ellipsis where the
 *  cut falls — while `keep` spans (stall/wait/failure flags) stay whole after it. When the kept
 *  spans alone cannot fit, the row is right-clipped like any other. */
export function fitSpans(spans: readonly RowSpan[], budget: number): RowSpan[] {
	if (budget <= 0) return [];
	if (spansWidth(spans) <= budget) return [...spans];
	const keepWidth = spansWidth(spans.filter((span) => span.keep));
	if (keepWidth === 0 || keepWidth + visibleWidth(ELLIPSIS) > budget) return rightClip(spans, budget);
	const limit = budget - keepWidth - visibleWidth(ELLIPSIS);
	const out: RowSpan[] = [];
	let used = 0;
	let cut = false;
	for (const span of spans) {
		if (span.keep) { out.push(span); continue; }
		if (cut) continue;
		const width = visibleWidth(span.text);
		if (used + width <= limit) { out.push(span); used += width; continue; }
		out.push({ ...span, text: `${sliceByColumn(span.text, 0, limit - used, true)}${ELLIPSIS}` });
		cut = true;
	}
	return out;
}

/**
 * Public setWidget factory for already-budgeted rows. Unlike the host's string[]/Text path this
 * never wraps: one source row occupies at most one terminal row. A row is a plain string or a
 * {@link StyledRow}; spans are painted with the theme the host passes to the factory, read on every
 * render — the host's theme is a live proxy and it invalidates widgets on a theme change, so no
 * colour is ever captured. Right-edge clipping preserves tree indentation and leading markers and
 * shortens detail before a kept attention flag; F9/exocom_list remain the full-detail surfaces.
 *
 * Rows are inset one column, the host's own `Text(line, 1, 0)` padding for string widgets (where
 * the transcript starts). Vertical spacing is not the widget's: the host puts its one spacer above
 * the widget block, and the gap toward the editor belongs to the editor and the theme, so nothing
 * is appended. An empty widget renders nothing. Row `i` is drawn at `y = i`, so `targets[event.y]`
 * is the control of the row that was clicked.
 *
 * Snapshot and sanitize once per publication, without trimming/collapsing indentation.
 */
export function compactWidget(rows: readonly (string | StyledRow)[], targets: readonly (string | undefined)[] = [], onClick?: (id: string) => void): (tui?: unknown, theme?: WidgetTheme) => Component {
	const lines: RowSpan[][] = rows.map((row) => (typeof row === "string" ? [{ text: row }] : row)
		.map((span) => ({ ...span, text: sanitizeSpan(span.text) })));
	return (_tui, theme) => ({
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const target = targets[event.y];
			if (!target || !onClick) return undefined;
			onClick(target);
			return { handled: true };
		},
		render(width: number): string[] {
			const columns = Math.max(0, Math.floor(width));
			if (columns === 0 || lines.length === 0) return [];
			const pad = columns >= 2 ? " " : "";
			const budget = columns - pad.length;
			return lines.map((spans) => pad + fitSpans(spans, budget)
				.map((span) => span.token && theme && span.text ? theme.fg(span.token, span.text) : span.text).join(""));
		},
		invalidate(): void { /* No width/theme-dependent cache: every render reads the live theme. */ },
	});
}

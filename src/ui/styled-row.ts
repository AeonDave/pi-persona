import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * One run of a widget row: raw display text plus the semantic theme token that paints it. Rows are
 * composed as spans so the renderer can colour by role (names, secondary detail, connectors,
 * states) without re-parsing display text, and can keep attention spans when it must clip.
 * `keep` marks text that must survive right-edge clipping (stall/wait/failure flags): the widget
 * shortens the other spans first. Pure data — no theme is captured here.
 */
export interface RowSpan {
	text: string;
	token?: ThemeColor;
	keep?: boolean;
}

export type StyledRow = readonly RowSpan[];

/** The plain text a styled row paints; always equal to the summary's `lines[i]`. */
export function rowText(row: StyledRow): string {
	return row.map((span) => span.text).join("");
}

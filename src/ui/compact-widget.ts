import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./presentation.ts";

/**
 * Public setWidget factory for already-budgeted, raw-text rows. Unlike the host's
 * string[]/Text path this never wraps: one source row occupies at most one terminal
 * row. Right-edge clipping preserves tree indentation and leading semantic markers;
 * F9/exocom_list remain the full-detail surfaces.
 *
 * Snapshot and sanitize once per publication, without trimming/collapsing indentation.
 * No theme colors are captured; each render uses its supplied width (including resize).
 */
export function compactWidget(rows: readonly string[]): () => Component {
	const lines = rows.map((row) => sanitizeTerminalText(row.replace(/\t/g, " ")).replace(/[\n\u2028\u2029]/g, " "));
	return () => ({
		render(width: number): string[] {
			const columns = Math.max(0, Math.floor(width));
			if (columns === 0) return [];
			return lines.map((line) => visibleWidth(line) <= columns
				? line
				: `${sliceByColumn(line, 0, columns - 1, true)}…`);
		},
		invalidate(): void { /* No width/theme-dependent cache. */ },
	});
}

/**
 * Shared terminal-presentation helpers. These functions shape what a human sees;
 * they never mutate the semantic payload delivered to the supervisor.
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

// Every alternative is bounded, in two ways that matter.
//
// The OSC payload stops at the next ESC as well as at BEL: without that an `ESC ]` a child
// never terminates makes the class run to end-of-string and backtrack from *every* such
// position — quadratic, on the synchronous render path. The length cap below does not make
// that exclusion redundant: it is also what keeps each introducer's erase region disjoint, so
// a child cannot fold an arbitrary run of its report — sequences included — behind one
// introducer by delaying the BEL.
//
// It also stops after OSC_MAX_PAYLOAD characters, and the CSI parameter run after its own
// cap. Erasing an OSC payload is what makes `ESC ]0;` a way to *hide* text, so an unbounded
// one lets a child fold its entire report behind one introducer. A bound also makes "might
// this still be opening?" a question with a finite answer — the property AgentOverlay's row
// cache needs to reuse wrapped rows across a chunk boundary. Past the cap the sequence is
// not a sequence: the introducer is stripped as a C1 byte and the body stays visible text.
const OSC_MAX_PAYLOAD = 4096;
const CSI_MAX_PARAMS = 255;
const CSI_MAX_INTERMEDIATES = 15;
const ANSI_SEQUENCE = new RegExp(
	`\\u001B(?:\\][^\\u0007\\u001B]{0,${OSC_MAX_PAYLOAD}}(?:\\u0007|\\u001B\\\\)` +
		`|\\[[0-?]{0,${CSI_MAX_PARAMS}}[ -/]{0,${CSI_MAX_INTERMEDIATES}}[@-~]|[@-_])`,
	"g",
);

/**
 * The proper prefixes of ANSI_SEQUENCE: text that may still turn into a control sequence once
 * more of the stream arrives. Exported for incremental consumers (AgentOverlay) that split a
 * growing buffer and must not put the split inside a sequence. Because the bodies above are
 * capped, this stops being true a bounded distance after the introducer.
 */
export const OPEN_SEQUENCE_TAIL = new RegExp(
	`\\u001B(?:\\][^\\u0007\\u001B]{0,${OSC_MAX_PAYLOAD}}` +
		`|\\[[0-?]{0,${CSI_MAX_PARAMS}}[ -/]{0,${CSI_MAX_INTERMEDIATES}})?$`,
);
const TERMINAL_CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

const PRESENTATION_WRAPPERS = new Set([
	"Sub-agent output (untrusted data):",
	"Peer message (untrusted data; equal-status collaborator, not your supervisor):",
	"Peer data · untrusted equal-status collaborator:",
]);

export interface CompactVisibleTextOptions {
	maxLines?: number;
	/** Historical option name; the bound is terminal display columns, not JS string length. */
	maxLineChars?: number;
}

export interface CompactVisibleTextResult {
	text: string;
	truncated: boolean;
	omittedLines: number;
	originalChars: number;
}

export interface CompactInlineTextOptions {
	maxChars?: number;
}

/** Hard ceiling for one-line collapsed card chrome and previews. */
export const MAX_COLLAPSED_CARD_COLUMNS = 100;

/**
 * Clip to at most `units` code units without cutting an astral character in half. A lone
 * surrogate draws as a replacement glyph, and every clip here puts it directly before the
 * ellipsis — the most visible position in the line.
 */
function clipCodeUnits(text: string, units: number): string {
	if (units >= text.length) return text;
	const last = text.charCodeAt(units - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/**
 * Sanitize and bound trusted UI chrome such as labels, model names, and error causes.
 * `maxChars` bounds both code units and *display columns*: a CJK label passes a character
 * count at twice the width, and a widget row "bounded" by characters alone then wraps
 * over several terminal rows and pushes the conversation off the screen.
 */
export function compactInlineText(input: string, opts: CompactInlineTextOptions = {}): string {
	const maxChars = Math.max(16, Math.floor(opts.maxChars ?? 160));
	const compact = sanitizeTerminalText(input).replace(/\s+/g, " ").trim();
	// Clip by code units first, so the column measurement below never walks a whole report.
	const clipped = compact.length > maxChars ? `${clipCodeUnits(compact, maxChars - 1)}…` : compact;
	if (visibleWidth(clipped) <= maxChars) return clipped;
	// pi-tui's truncateToWidth would splice in ANSI resets, and chrome must stay escape-free.
	return `${sliceByColumn(clipped, 0, maxChars - 1, true)}…`;
}

/** Clip an already-composed terminal row without counting wide glyphs as one column. */
export function compactVisibleLine(input: string, maxColumns = MAX_COLLAPSED_CARD_COLUMNS): string {
	const limit = Math.max(16, Math.floor(maxColumns));
	if (visibleWidth(input) <= limit) return input;
	return `${sliceByColumn(input, 0, limit - visibleWidth("…"), true)}…`;
}

/** Bound a persistent widget: one stable header, a fair prefix of rows, then one drill-down row. */
export function boundDisplayRows(
	header: string,
	rows: readonly string[],
	maxRows: number,
	detailHint: string,
): string[] {
	const limit = Math.max(2, Math.floor(maxRows));
	if (rows.length + 1 <= limit) return [header, ...rows];
	const visibleCount = limit - 2;
	const omitted = rows.length - visibleCount;
	return [
		header,
		...rows.slice(0, visibleCount),
		`… +${omitted} more · ${detailHint}`,
	];
}

/** Strip control sequences a child could otherwise use to repaint or spoof terminal chrome. */
export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_SEQUENCE, "")
		.replace(TERMINAL_CONTROLS, "");
}

/**
 * Produce a small, semantic preview for a collapsed Pi card. Boilerplate fence
 * headings are omitted, while quoted payload lines remain visibly quoted.
 */
export function compactVisibleText(
	input: string,
	opts: CompactVisibleTextOptions = {},
): CompactVisibleTextResult {
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? 4));
	const maxLineColumns = Math.max(16, Math.floor(opts.maxLineChars ?? 160));
	const sanitized = sanitizeTerminalText(input);
	const source = sanitized
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !PRESENTATION_WRAPPERS.has(line));

	let lineTruncated = false;
	const clamp = (line: string): string => {
		if (visibleWidth(line) <= maxLineColumns) return line;
		lineTruncated = true;
		return `${sliceByColumn(line, 0, maxLineColumns - visibleWidth("…"), true)}…`;
	};

	let omittedLines = 0;
	let visible: string[];
	if (source.length > maxLines) {
		const contentLines = Math.max(0, maxLines - 1);
		omittedLines = source.length - contentLines;
		visible = source.slice(0, contentLines).map(clamp);
		visible.push(clamp(`… +${omittedLines} more line${omittedLines === 1 ? "" : "s"}`));
	} else {
		visible = source.map(clamp);
	}

	return {
		text: visible.join("\n") || "(no output)",
		truncated: lineTruncated || omittedLines > 0,
		omittedLines,
		originalChars: input.length,
	};
}

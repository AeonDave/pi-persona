import { stripTerminalControls } from "./fence.ts";

/**
 * Make an untrusted name safe where pi-persona needs an identifier-like label.
 *
 * Routing and attribution labels are metadata, not instructions: keep them to one
 * bounded line and reduce punctuation/whitespace to identifier-like separators before
 * interpolating them outside an untrusted-output fence. Human-facing persona status uses
 * `sanitizeStatusLabel` below so safe presentation such as emoji is not discarded.
 */
export const MAX_DISPLAY_LABEL_CHARS = 80;

const unsafeLabelCharacters = /[^\p{L}\p{N}._@+#-]+/gu;
const edgeSeparators = /^[-._@+#]+|[-._@+#]+$/g;

export function sanitizeDisplayLabel(value: string, fallback = "agent", maxChars = MAX_DISPLAY_LABEL_CHARS): string {
	const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : MAX_DISPLAY_LABEL_CHARS;
	const normalize = (input: string): string =>
		input
			.normalize("NFKC")
			.replace(unsafeLabelCharacters, "-")
			.replace(/-{2,}/g, "-")
			.replace(edgeSeparators, "")
			.slice(0, limit);
	const safe = normalize(value);
	if (safe) return safe;
	return normalize(fallback) || "agent";
}

function clipCodeUnits(text: string, units: number): string {
	if (text.length <= units) return text;
	const last = text.charCodeAt(units - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/**
 * Sanitize a human-facing persona label without reducing it to a protocol identifier.
 * Emoji, spaces, and ordinary punctuation are presentation, not control syntax; preserve
 * them after removing terminal sequences and folding the value to one bounded line.
 */
export function sanitizeStatusLabel(value: string, fallback = "agent", maxChars = MAX_DISPLAY_LABEL_CHARS): string {
	const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : MAX_DISPLAY_LABEL_CHARS;
	const normalize = (input: string): string => stripTerminalControls(input).normalize("NFKC").replace(/\s+/gu, " ").trim();
	const readable = normalize(value) || normalize(fallback) || "agent";
	if (readable.length <= limit) return readable;
	return `${clipCodeUnits(readable, limit - 1)}…`;
}

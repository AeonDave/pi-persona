/**
 * Make an untrusted name safe for compact supervisor-facing status surfaces.
 *
 * Display labels are metadata, not instructions: keep them to one bounded line and
 * reduce punctuation/whitespace to identifier-like separators before interpolating
 * them outside an untrusted-output fence.
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

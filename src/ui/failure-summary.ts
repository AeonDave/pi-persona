import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";

const MAX_INSPECTED_CHARS = 16_384;
const MAX_SUMMARY_COLUMNS = 140;

/** Display-only cause preview. The caller retains the original error for diagnostics. */
export function summarizeFailure(error: string): string {
	let source = sanitizeTerminalText(error.slice(0, MAX_INSPECTED_CHARS)).trim();
	// Omit only the runtime's identity/model wrapper, not meaningful tags such as [BLOCKED].
	const wrapperEnd = source.startsWith("[") ? source.indexOf("]") : -1;
	if (wrapperEnd > 0 && wrapperEnd <= 512 && source.slice(1, wrapperEnd).includes(" · ")) source = source.slice(wrapperEnd + 1).trim();
	const reason = sanitizeTerminalText(jsonCause(source) ?? source).replace(/\s+/g, " ").trim();
	if (/^(?:(?:the|this)\s+)?(?:['"`][^'"`]{1,200}['"`]\s+)?model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account[.!]?$/i.test(reason)) {
		return "Model not supported by this ChatGPT account.";
	}
	return compactInlineText(reason, { maxChars: MAX_SUMMARY_COLUMNS });
}

/** Scan one bounded object, respecting JSON strings; never retry parsing at every brace. */
function jsonCause(source: string): string | undefined {
	const start = source.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			try { return objectCause(JSON.parse(source.slice(start, index + 1)) as unknown); }
			catch { return undefined; }
		}
	}
	return undefined;
}

function objectCause(value: unknown): string | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const object = value as Record<string, unknown>;
	for (const field of [object.detail, object.message, object.error]) {
		if (typeof field === "string" && field.trim()) return field;
	}
	if (object.error !== null && typeof object.error === "object" && !Array.isArray(object.error)) {
		const error = object.error as Record<string, unknown>;
		for (const field of [error.message, error.detail]) {
			if (typeof field === "string" && field.trim()) return field;
		}
	}
	return undefined;
}

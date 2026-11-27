import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";

const MAX_INSPECTED_CHARS = 16_384;
const MAX_SUMMARY_COLUMNS = 140;
const MAX_RUNTIME_TAG_CHARS = 513;
const RUNTIME_FAILURE_TAG = /^\[([^\s[\]]+) · (\(no model\)|[^\s[\]]+)( \+dyn\((?:model|skills|tools)(?:,(?:model|skills|tools))*\))?\]\s/;

/** Display-only cause preview. The caller retains the original error for diagnostics. */
export function summarizeFailure(error: string, agent?: string): string {
	let source = sanitizeTerminalText(error.slice(0, MAX_INSPECTED_CHARS)).trim();
	const tag = RUNTIME_FAILURE_TAG.exec(source.slice(0, MAX_RUNTIME_TAG_CHARS + 1));
	if (tag) {
		const [, taggedAgent, model, overrides] = tag;
		// A bare model id can look like a provider's bracketed status. Use the worker identity when available.
		const workerTag = agent === undefined ? model === "(no model)" || model?.includes("/") || !!overrides : taggedAgent === agent;
		if (workerTag) source = source.slice(tag[0].length).trim();
	}
	// Engines append the last provider error as context after reporting the actual cause of death.
	const secondary = source.startsWith("agent ") ? source.indexOf(" (last error: ") : -1;
	const jsonStart = secondary > 0 ? source.indexOf("{") : -1;
	const primary = secondary > 0 && (jsonStart < 0 || secondary < jsonStart) ? source.slice(0, secondary) : source;
	const reason = sanitizeTerminalText(jsonCause(primary) ?? primary).replace(/\s+/g, " ").trim();
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

/** Bounded text projections for the operator's worker chat; never expands image payloads. */
export interface ChatText {
	text: string;
	truncated: boolean;
}

const OMITTED = "…[earlier chat content omitted]\n";

export function boundChatText(text: string, limit: number): ChatText {
	if (text.length <= limit) return { text, truncated: false };
	// Leave headroom after trimming, like the stream transcript: a token-at-a-time producer
	// should append cheaply for many events before the bounded tail needs another copy.
	let start = text.length - Math.floor((limit - OMITTED.length) * 0.75);
	// A UTF-16 budget must not turn a complete astral character into a lone low surrogate.
	const first = text.charCodeAt(start);
	if (first >= 0xdc00 && first <= 0xdfff && text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start++;
	return { text: `${OMITTED}${text.slice(start)}`, truncated: true };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Tool arguments are data: cap traversal before serialization, including cyclic/malformed inputs. */
export function chatArguments(value: unknown, limit: number): ChatText {
	if (value === undefined) return { text: "", truncated: false };
	if (typeof value === "string") return boundChatText(value, limit);
	let remaining = 128;
	let truncated = false;
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): unknown => {
		if (--remaining < 0 || depth > 5) { truncated = true; return "[omitted]"; }
		if (typeof item === "string") {
			const bounded = boundChatText(item, limit);
			truncated ||= bounded.truncated;
			return bounded.text;
		}
		if (item === null || typeof item === "boolean" || typeof item === "number") return item;
		if (typeof item !== "object") return `[${typeof item}]`;
		if (seen.has(item)) { truncated = true; return "[circular]"; }
		seen.add(item);
		if (Array.isArray(item)) {
			truncated ||= item.length > 24;
			return item.slice(0, 24).map((entry) => visit(entry, depth + 1));
		}
		const entries: Array<[string, unknown]> = [];
		let inspected = 0;
		for (const key in item) {
			if (++inspected > 24 || remaining < 0) { truncated = true; break; }
			if (!Object.hasOwn(item, key)) continue;
			entries.push([key.slice(0, 256), visit((item as Record<string, unknown>)[key], depth + 1)]);
		}
		return Object.fromEntries(entries);
	};
	try {
		const bounded = boundChatText(JSON.stringify(visit(value, 0), null, 2), limit);
		return { text: bounded.text, truncated: truncated || bounded.truncated };
	} catch {
		return { text: "[arguments unavailable]", truncated: true };
	}
}

/** Only known text fields enter the view; images and other content receive literal placeholders. */
export function chatContent(value: unknown, limit: number): ChatText {
	if (typeof value === "string") return boundChatText(value, limit);
	const record = object(value);
	const content = Array.isArray(value) ? value : record?.content;
	if (typeof content === "string") return boundChatText(content, limit);
	if (!Array.isArray(content)) return { text: "", truncated: false };
	const parts: string[] = [];
	let chars = 0;
	let truncated = content.length > 128;
	for (const part of content.slice(0, 128)) {
		const block = object(part);
		const text = block?.type === "text" && typeof block.text === "string" ? block.text
			: block?.type === "image" ? "[image omitted]"
				: block?.type === "thinking" || block?.type === "toolCall" ? "" : "[unsupported content omitted]";
		if (!text) continue;
		const bounded = boundChatText(text, limit);
		parts.push(bounded.text);
		chars += bounded.text.length;
		truncated ||= bounded.truncated;
		if (chars >= limit) { truncated ||= parts.length < content.length; break; }
	}
	if (record && object(record.details) && typeof object(record.details)?.diff === "string") {
		const diff = boundChatText(object(record.details)!.diff as string, limit);
		parts.push(diff.text);
		truncated ||= diff.truncated;
	}
	const bounded = boundChatText(parts.join("\n"), limit);
	return { text: bounded.text, truncated: truncated || bounded.truncated };
}

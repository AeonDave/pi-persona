/**
 * Shared plumbing of the persistent-RPC smokes (monitor-smoke, wake-smoke, identity-smoke): bounded text
 * buffers, JSONL line framing, and the small readers every Pi RPC event handler needs. Pure and
 * dependency-free; each smoke keeps its own child lifecycle and assertions.
 */

/** Append `chunk` to `current`, keeping only the last `max` characters. */
export function appendBounded(current, chunk, max) {
	const next = current + chunk;
	return next.length <= max ? next : next.slice(-max);
}

/** One-line, length-bounded rendering of any value, for an event log. */
export function short(value, max = 320) {
	let text;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	} catch {
		text = String(value);
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The concatenated text parts of a message/tool-result `content` array ("" for anything else). */
export function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** A tool result's `details` object, when it has one. */
export function resultDetails(result) {
	return result && typeof result === "object" && result.details && typeof result.details === "object" ? result.details : undefined;
}

/** Feed stdout chunks in; `onEvent` receives one parsed JSON object per complete line. */
export function jsonLineReader(onEvent, maxBuffer = 1_000_000) {
	let buffer = "";
	return (chunk) => {
		buffer = appendBounded(buffer, chunk, maxBuffer);
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) onEvent(JSON.parse(line));
		}
	};
}

/** Write one RPC command (a JSON line) to the child's stdin. */
export function sendCommand(child, command) {
	if (!child?.stdin?.writable) throw new Error("RPC stdin is not writable");
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

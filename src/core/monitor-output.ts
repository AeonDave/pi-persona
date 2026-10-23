/** Pure, bounded terminal-output projection. Raw output must never be replayed as terminal commands. */
export const MONITOR_OUTPUT_TAIL_CHARS = 4_000;

/** Neutralize display-direction/line controls in complete monitor text; never mutate raw captures. */
export function neutralizeMonitorUnicode(text: string): string {
	return text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\u2028\u2029]/g, " ");
}

type ControlState = "text" | "escape" | "escapeIntermediate" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape";

/**
 * One stream's sanitized tail. A fixed-size ring bounds storage even for a giant unterminated
 * line. Escape parsing keeps only a finite state (no pending payload), independently per stream,
 * so split/unterminated OSC, CSI and DCS cannot leak into the surrounding display structure.
 * CR replaces the current progress line; CRLF completes it. This is not a terminal emulator.
 */
export class MonitorOutputTail {
	private readonly chars: string[] = [];
	private start = 0;
	private length = 0;
	private state: ControlState = "text";
	private carriageReturn = false;

	append(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const char = chunk[i]!;
			const code = chunk.charCodeAt(i);
			if (this.state === "osc" || this.state === "string") {
				if (code === 0x9c || (code === 0x07 && this.state === "osc")) this.state = "text";
				else if (code === 0x1b) this.state = this.state === "osc" ? "oscEscape" : "stringEscape";
				continue;
			}
			if (this.state === "oscEscape" || this.state === "stringEscape") {
				if (char === "\\" || code === 0x9c || (code === 0x07 && this.state === "oscEscape")) this.state = "text";
				else if (code !== 0x1b) this.state = this.state === "oscEscape" ? "osc" : "string";
				continue;
			}
			if (code === 0x1b) { this.state = "escape"; continue; }
			if (this.state === "escape") {
				if (char === "[") this.state = "csi";
				else if (char === "]") this.state = "osc";
				else if (char === "P" || char === "X" || char === "^" || char === "_") this.state = "string";
				else this.state = code >= 0x20 && code <= 0x2f ? "escapeIntermediate" : "text";
				continue;
			}
			if (this.state === "escapeIntermediate" || this.state === "csi") {
				if (code >= (this.state === "csi" ? 0x40 : 0x30) && code <= 0x7e) this.state = "text";
				continue;
			}
			if (code === 0x9b) { this.state = "csi"; continue; }
			if (code === 0x9d) { this.state = "osc"; continue; }
			if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) { this.state = "string"; continue; }
			if (char === "\r") { this.carriageReturn = true; continue; }
			if (char === "\n") { this.carriageReturn = false; this.push("\n"); continue; }
			if (code < 0x20 && code !== 0x09 || code >= 0x7f && code <= 0x9f) continue;
			// Inert display text must not carry bidi direction overrides or Unicode line separators.
			if (code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 || code === 0x200e || code === 0x200f) continue;
			if (this.carriageReturn) {
				while (this.length > 0 && this.chars[(this.start + this.length - 1) % MONITOR_OUTPUT_TAIL_CHARS] !== "\n") this.length--;
				this.carriageReturn = false;
			}
			this.push(code === 0x09 || code === 0x2028 || code === 0x2029 ? " " : char);
		}
	}

	get text(): string {
		let text = Array.from({ length: this.length }, (_, i) => this.chars[(this.start + i) % MONITOR_OUTPUT_TAIL_CHARS]!).join("");
		// Eviction/chunk splits can expose half a surrogate pair: never render that half alone.
		if (text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) text = text.slice(1);
		const last = text.charCodeAt(text.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
		return text;
	}

	get preview(): string {
		const text = this.text.trimEnd();
		return text.slice(text.lastIndexOf("\n") + 1).trim();
	}

	private push(char: string): void {
		this.chars[(this.start + this.length) % MONITOR_OUTPUT_TAIL_CHARS] = char;
		if (this.length < MONITOR_OUTPUT_TAIL_CHARS) this.length++;
		else this.start = (this.start + 1) % MONITOR_OUTPUT_TAIL_CHARS;
	}
}

/**
 * Pure parsing of the `pi --mode json -p` event stream.
 *
 * The CLI emits one JSON object per line (a session event). This module turns
 * that stream into an accumulated result — final assistant text, summed usage,
 * model, and stop reason — without any I/O, so it is fully unit-testable. The
 * spawn wrapper (child.ts) only does process plumbing on top of these helpers.
 *
 * Mirrors the canonical recipe in Pi's reference subagent example.
 */

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface StreamState {
	/** The last assistant text content seen (the agent's answer). */
	output: string;
	usage: ChildUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAssistant: boolean;
}

export function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createStreamState(): StreamState {
	return { output: "", usage: emptyUsage(), sawAssistant: false };
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function num(x: unknown): number {
	return typeof x === "number" && !Number.isNaN(x) ? x : 0;
}

function firstText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (isObject(part) && part.type === "text" && typeof part.text === "string") return part.text;
	}
	return undefined;
}

/** Fold one parsed stream event into the accumulating state (in place). */
export function applyEvent(state: StreamState, event: unknown): void {
	if (!isObject(event) || event.type !== "message_end" || !isObject(event.message)) return;
	const msg = event.message;
	if (msg.role !== "assistant") return;

	state.sawAssistant = true;
	state.usage.turns++;

	const text = firstText(msg.content);
	if (text !== undefined) state.output = text;

	const usage = msg.usage;
	if (isObject(usage)) {
		state.usage.input += num(usage.input);
		state.usage.output += num(usage.output);
		state.usage.cacheRead += num(usage.cacheRead);
		state.usage.cacheWrite += num(usage.cacheWrite);
		state.usage.cost += isObject(usage.cost) ? num(usage.cost.total) : 0;
		// contextTokens is the *current* window size, not a sum — replace it, but
		// only when this turn actually reported one (don't zero it out otherwise).
		if (typeof usage.totalTokens === "number" && !Number.isNaN(usage.totalTokens)) {
			state.usage.contextTokens = usage.totalTokens;
		}
	}

	if (state.model === undefined && typeof msg.model === "string") state.model = msg.model;
	if (typeof msg.stopReason === "string") state.stopReason = msg.stopReason;
	if (typeof msg.errorMessage === "string") state.errorMessage = msg.errorMessage;
}

/** A compact live progress view of a running agent (for peek / ProgressView). */
export interface ProgressSnapshot {
	output: string;
	turns: number;
	tokens: number;
}

export function snapshot(state: StreamState): ProgressSnapshot {
	return { output: state.output, turns: state.usage.turns, tokens: state.usage.input + state.usage.output };
}

/** Buffer a stdout chunk into complete lines, returning the partial remainder. */
export function feedLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
	const parts = (buffer + chunk).split("\n");
	const rest = parts.pop() ?? "";
	// Strip a trailing CR so CRLF (Windows) output yields clean lines; the partial
	// remainder is left untouched (it may be mid-line).
	const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	return { lines, rest };
}

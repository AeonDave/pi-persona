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
	/** The last assistant text content seen (the agent's answer — the returned result). */
	output: string;
	/** The chronological live log shown in the f9 detail view: every completed message's
	 *  reasoning AND text, plus one `⚙ tool` line per tool call — the whole progression,
	 *  never just the latest message. Bounded (old head trimmed) so a long run can't
	 *  grow supervisor memory without limit. */
	transcript: string;
	/** The current in-progress message's visible content (streamed text, or reasoning
	 *  while there's no answer text yet). Cleared on message_end (folded into transcript).
	 *  Bounded (old head trimmed) like the transcript: `snapshot()` copies it on every
	 *  event, per leg, so an unbounded one is the same leak. */
	partial: string;
	/** The in-progress message's content parts assembled from streaming deltas, indexed by
	 *  `contentIndex`. pi ≥0.83 makes `message_update` DELTA-ONLY on the JSON wire (no
	 *  cumulative `message`), so live text can only be reconstructed here. */
	deltaParts: string[];
	/** {@link deltaParts} joined — the value `partial` takes. Kept incrementally (a delta for
	 *  the last non-blank part appends to it) because re-joining every part on every delta is
	 *  quadratic in message length, on the hot path of every leg. */
	deltaLive: string;
	/** Index of the last non-blank part in {@link deltaParts}: the only slot whose growth
	 *  appends to {@link deltaLive} verbatim, which is what makes the append exact. -1 = none. */
	deltaTail: number;
	usage: ChildUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAssistant: boolean;
	/** The tool the child is currently running (e.g. "grep src/…"), or undefined. */
	activity?: string;
}

export function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createStreamState(): StreamState {
	return { output: "", transcript: "", partial: "", deltaParts: [], deltaLive: "", deltaTail: -1, usage: emptyUsage(), sawAssistant: false };
}

/** Start the next message's delta assembly from an empty slate (parts AND their cache). */
function resetDeltaParts(state: StreamState): void {
	state.deltaParts = [];
	state.deltaLive = "";
	state.deltaTail = -1;
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

/** The visible content of an in-progress message: its reasoning AND its answer text,
 *  in content order, so a thinking agent isn't a mute "waiting" and the answer appearing
 *  doesn't erase the reasoning that led to it. */
function liveContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) parts.push(part.thinking);
		else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// A malformed line must not be able to allocate an arbitrarily sparse deltaParts array
// (the re-join below walks its whole length) — no real message has this many content parts.
const MAX_CONTENT_PARTS = 4096;

// Bound the in-progress message exactly as the transcript is bounded: MAX_CONTENT_PARTS caps
// how MANY parts a malformed line can allocate, but nothing on the wire caps the bytes in one
// (a single `text_end` can carry megabytes), and `snapshot()` copies the assembly on every
// event, per leg. Over the cap the OLD head goes — the user is watching the tail.
const PARTIAL_MAX = 200_000;
const PARTIAL_KEEP = 150_000;

function boundLive(text: string): string {
	if (text.length <= PARTIAL_MAX) return text;
	return `…[earlier output trimmed]\n${text.slice(text.length - PARTIAL_KEEP)}`;
}

/** Re-join every non-blank part and record which one is last. The general case — used when a
 *  delta can't simply extend the tail of what's already assembled. */
function rejoinDeltaParts(state: StreamState): void {
	let live = "";
	let tail = -1;
	for (let i = 0; i < state.deltaParts.length; i++) {
		const part = state.deltaParts[i];
		if (!part?.trim()) continue;
		live = live ? `${live}\n\n${part}` : part;
		tail = i;
	}
	state.deltaLive = boundLive(live);
	state.deltaTail = tail;
}

/** Fold one streaming `assistantMessageEvent` delta into the live partial. This is the
 *  pi ≥0.83 wire shape: `message_update` carries only `{contentIndex, delta}`, never the
 *  cumulative message, so the visible content has to be reassembled part by part.
 *  Tool-call deltas are raw argument JSON — not something to show as agent output. */
function applyMessageDelta(state: StreamState, ev: Record<string, unknown>): void {
	if (ev.type === "start") {
		resetDeltaParts(state);
		return;
	}
	const idx = ev.contentIndex;
	if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= MAX_CONTENT_PARTS) return;
	const prev = state.deltaParts[idx] ?? "";
	if (ev.type === "text_delta" || ev.type === "thinking_delta") {
		if (typeof ev.delta !== "string") return;
		const grown = boundLive(prev + ev.delta);
		state.deltaParts[idx] = grown;
		if (idx === state.deltaTail) {
			// The hot path. deltaTail is by construction the LAST non-blank part, so appending to
			// it appends to the assembly verbatim: no re-join, and no trim() of the whole part
			// either (that flattens the rope V8 builds from the concatenation, which is itself
			// quadratic in message length). A part just trimmed at the cap moved its own seam.
			if (grown === prev + ev.delta) state.deltaLive = boundLive(state.deltaLive + ev.delta);
			else rejoinDeltaParts(state);
		} else if (idx > state.deltaTail && ev.delta.trim()) {
			// Every part past the tail is blank, so this one becomes the new tail and lands at the
			// END of the assembly — an append too.
			state.deltaLive = boundLive(state.deltaLive ? `${state.deltaLive}\n\n${grown}` : grown);
			state.deltaTail = idx;
		} else if (idx < state.deltaTail || grown.trim()) {
			// A late delta for an earlier part, or a blank part promoted by whitespace-then-text:
			// the seams moved, so re-join once.
			rejoinDeltaParts(state);
		}
		// else a blank part stayed blank — excluded from the assembly either way, nothing moved.
	} else if (ev.type === "text_end" || ev.type === "thinking_end") {
		if (typeof ev.content !== "string") return;
		state.deltaParts[idx] = boundLive(ev.content);
		rejoinDeltaParts(state);
	} else return;
	if (state.deltaLive) {
		state.partial = state.deltaLive;
		delete state.activity; // generating, not running a tool
	}
}

/** A short "toolName arg" activity label from a tool_execution_start event. */
function toolActivity(toolName: string, args: unknown): string {
	if (isObject(args)) {
		const hint = args.path ?? args.pattern ?? args.command ?? args.file ?? args.query ?? args.url;
		if (typeof hint === "string" && hint.trim()) {
			return `${toolName} ${hint.length > 40 ? `${hint.slice(0, 40)}…` : hint}`;
		}
	}
	return toolName;
}

// Bound the live transcript: a long tool-heavy run must not grow memory without limit.
// When the cap is hit, the OLD head is trimmed (the user watches the tail live).
const TRANSCRIPT_MAX = 200_000;
const TRANSCRIPT_KEEP = 150_000;

function appendTranscript(state: StreamState, chunk: string, sep: string): void {
	state.transcript += (state.transcript ? sep : "") + chunk;
	if (state.transcript.length > TRANSCRIPT_MAX) {
		state.transcript = `…[earlier output trimmed]\n${state.transcript.slice(state.transcript.length - TRANSCRIPT_KEEP)}`;
	}
}

/** Fold one parsed stream event into the accumulating state (in place). */
export function applyEvent(state: StreamState, event: unknown): void {
	if (!isObject(event)) return;

	// Track the current tool so the UI can show "running: grep src/…" while a
	// tool-heavy agent reads before it has written any text. The tool line also goes
	// into the transcript, so the live log reads chronologically (think → tools → text)
	// instead of tool-heavy stretches leaving the view apparently frozen.
	if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
		state.activity = toolActivity(event.toolName, event.args);
		appendTranscript(state, `⚙ ${state.activity}`, "\n");
		return;
	}
	if (event.type === "tool_execution_end") {
		delete state.activity;
		return;
	}

	// Live partial: pi streams the growing message as `message_update` events. Surface
	// its text (or reasoning) so a long-thinking agent shows progress, not just tokens.
	// ONLY the assistant's own message counts: pi also emits message_start/message_end for
	// the user prompt it just delivered and for every tool result, and folding those in
	// would make the child's own task echo look like streamed output — cancelling the
	// startup deadline before the first provider call and salvaging the prompt as
	// "partial output" when the leg dies without ever answering.
	if (event.type === "message_update" || event.type === "message_start") {
		if (isObject(event.message)) {
			if (event.message.role !== "assistant") return;
			if (event.type === "message_start") resetDeltaParts(state);
			const live = liveContent(event.message.content);
			if (live !== undefined) {
				state.partial = boundLive(live);
				delete state.activity; // generating, not running a tool
			}
			return;
		}
		// pi ≥0.83 strips the cumulative `message` from message_update on the JSON wire —
		// only the deltas remain, so assemble the live text from them instead.
		if (event.type === "message_update" && isObject(event.assistantMessageEvent)) {
			applyMessageDelta(state, event.assistantMessageEvent);
		}
		return;
	}

	if (event.type !== "message_end" || !isObject(event.message)) return;
	const msg = event.message;
	if (msg.role !== "assistant") return;

	delete state.activity; // a message means it's reasoning, not mid-tool
	state.partial = ""; // the completed message is folded into the transcript below
	resetDeltaParts(state); // the next message's deltas start from an empty slate
	state.sawAssistant = true;
	state.usage.turns++;

	const text = firstText(msg.content);
	if (text !== undefined) state.output = text;
	// Fold the WHOLE completed message (reasoning + text) into the transcript — not just
	// the text. Otherwise each message_end wipes the thinking the user was reading
	// (`partial` clears) and a tool-heavy agent's view looks like it "overwrites itself".
	const live = liveContent(msg.content);
	if (live) appendTranscript(state, live, "\n\n");

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
	/** The tool currently running (e.g. "grep src/…"), if any. */
	activity?: string;
}

export function snapshot(state: StreamState): ProgressSnapshot {
	const snap: ProgressSnapshot = {
		// The live view shows completed messages (transcript) plus the in-progress one
		// (partial), falling back to the last text before anything has accumulated.
		output: [state.transcript, state.partial].filter((s) => s).join("\n\n") || state.output,
		turns: state.usage.turns,
		tokens: state.usage.input + state.usage.output,
	};
	if (state.activity !== undefined) snap.activity = state.activity;
	return snap;
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

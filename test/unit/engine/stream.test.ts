import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, createStreamState, emptyUsage, feedLines, snapshot } from "../../../src/engine/stream.ts";

test("feedLines buffers partial lines across chunks", () => {
	assert.deepEqual(feedLines("", "a\nb\nc"), { lines: ["a", "b"], rest: "c" });
	assert.deepEqual(feedLines("x", "y\nz"), { lines: ["xy"], rest: "z" });
	assert.deepEqual(feedLines("", "no newline"), { lines: [], rest: "no newline" });
	assert.deepEqual(feedLines("", "a\n"), { lines: ["a"], rest: "" });
});

test("applyEvent captures the current tool as activity, and clears it when the tool ends", () => {
	const st = createStreamState();
	applyEvent(st, { type: "tool_execution_start", toolName: "grep", args: { pattern: "TODO", path: "src/" } });
	assert.match(st.activity ?? "", /grep/);
	assert.match(snapshot(st).activity ?? "", /grep/);
	applyEvent(st, { type: "tool_execution_end", toolName: "grep", result: {}, isError: false });
	assert.equal(st.activity, undefined, "activity clears when the tool ends");
});

test("tool lifecycle dedupe stays bounded without evicting a still-active call", () => {
	const st = createStreamState();
	const cacheMax = 1_024;
	assert.deepEqual(
		applyEvent(st, { type: "tool_execution_start", toolCallId: "active", toolName: "read", args: {} }),
		{ phase: "start", callId: "active", name: "read" },
	);
	for (let i = 0; i < cacheMax + 32; i++) {
		const callId = `done-${i}`;
		applyEvent(st, { type: "tool_execution_start", toolCallId: callId, toolName: "read", args: {} });
		applyEvent(st, { type: "tool_execution_end", toolCallId: callId, toolName: "read", result: {}, isError: false });
	}

	assert.ok((st.seenToolStarts?.size ?? 0) <= cacheMax, "completed start ids are retained only in a bounded cache");
	assert.ok((st.seenToolEnds?.size ?? 0) <= cacheMax, "completed end ids are retained only in a bounded cache");
	assert.equal(
		applyEvent(st, { type: "tool_execution_start", toolCallId: "active", toolName: "read", args: {} }),
		undefined,
		"cache churn must not forget an active call and re-emit its duplicate start",
	);
	assert.deepEqual(
		applyEvent(st, { type: "tool_execution_end", toolCallId: "active", toolName: "read", result: {}, isError: false }),
		{ phase: "end", callId: "active", name: "read", failed: false },
		"the original active call still completes normally after cache churn",
	);
});

test("applyEvent accumulates assistant text, usage, model, and stop reason", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 }, totalTokens: 100 },
			model: "prov/m",
			stopReason: "end",
		},
	});
	assert.equal(s.output, "hello world");
	assert.equal(s.usage.input, 10);
	assert.equal(s.usage.output, 5);
	assert.equal(s.usage.cacheRead, 2);
	assert.equal(s.usage.cacheWrite, 1);
	assert.equal(s.usage.cost, 0.01);
	assert.equal(s.usage.contextTokens, 100);
	assert.equal(s.usage.turns, 1);
	assert.equal(s.model, "prov/m");
	assert.equal(s.stopReason, "end");
	assert.equal(s.sawAssistant, true);
});

test("applyEvent sums usage across turns; output is the last assistant text; model sticks", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 3 }, model: "m1" },
	});
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 4 }, model: "m2" },
	});
	assert.equal(s.output, "second");
	assert.equal(s.usage.input, 7);
	assert.equal(s.usage.turns, 2);
	assert.equal(s.model, "m1", "first model wins");
});

test("applyEvent does not overwrite output for a toolCall-only assistant message", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
	});
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
	});
	assert.equal(s.output, "answer");
	assert.equal(s.usage.turns, 2);
});

test("applyEvent captures error stop reason and message", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
	});
	assert.equal(s.stopReason, "error");
	assert.equal(s.errorMessage, "boom");
});

test("message_update streams the in-progress text live (partial), cleared when the message ends", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Three facts clo" }] } });
	assert.match(snapshot(s).output, /Three facts clo/, "partial text is visible mid-generation");
	applyEvent(s, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Three facts close this" }] } });
	assert.match(snapshot(s).output, /Three facts close this/, "partial grows as more streams in");
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Three facts close this decisively." }] } });
	assert.match(snapshot(s).output, /decisively/);
	assert.equal(s.partial, "", "partial clears once the message completes (it's now in the transcript)");
});

test("message_update shows thinking while there is no answer text yet", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me weigh JSON vs YAML…" }] } });
	assert.match(snapshot(s).output, /weigh JSON vs YAML/, "reasoning is surfaced so a thinking agent isn't a mute 'waiting'");
});

test("message_update keeps reasoning AND answer visible together — new text doesn't erase the thinking", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "weighing the options" },
				{ type: "text", text: "the answer is json" },
			],
		},
	});
	const out = snapshot(s).output;
	assert.match(out, /weighing the options/, "reasoning stays visible");
	assert.match(out, /the answer is json/, "answer is visible too");
});

test("the transcript keeps a completed message's REASONING too — message_end must not wipe it", () => {
	// The f9 'overwrites itself' bug: partial (thinking) cleared on message_end and only
	// the text was folded, so a tool/thinking-heavy agent's view kept losing content.
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me check the parser first" },
				{ type: "text", text: "found it in parse()" },
			],
		},
	});
	const out = snapshot(s).output;
	assert.match(out, /let me check the parser first/, "the reasoning survives the message end");
	assert.match(out, /found it in parse\(\)/);
	assert.equal(s.output, "found it in parse()", "the returned answer is still just the text");
});

test("the transcript logs tool calls chronologically (⚙ lines) so tool-heavy stretches stay visible", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "scan the sources" }] } });
	applyEvent(s, { type: "tool_execution_start", toolName: "grep", args: { pattern: "TODO" } });
	applyEvent(s, { type: "tool_execution_end", toolName: "grep", result: {}, isError: false });
	applyEvent(s, { type: "tool_execution_start", toolName: "read", args: { path: "src/x.ts" } });
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "3 TODOs found" }] } });
	const out = snapshot(s).output;
	const order = [out.indexOf("scan the sources"), out.indexOf("⚙ grep TODO"), out.indexOf("⚙ read src/x.ts"), out.indexOf("3 TODOs found")];
	assert.ok(order.every((i) => i >= 0), `all steps present in: ${out}`);
	assert.deepEqual([...order].sort((a, b) => a - b), order, "the log reads in chronological order");
});

test("the transcript is bounded — a very long run trims the OLD head, keeping the live tail", () => {
	const s = createStreamState();
	for (let i = 0; i < 300; i++) {
		applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `msg ${i} ${"x".repeat(1000)}` }] } });
	}
	assert.ok(s.transcript.length < 250_000, `transcript stays bounded (got ${s.transcript.length})`);
	assert.match(s.transcript, /earlier output trimmed/);
	assert.match(s.transcript, /msg 299/, "the newest content is kept");
	assert.doesNotMatch(s.transcript, /msg 0 /, "the oldest content was trimmed");
});

test("snapshot accumulates a transcript of assistant messages (live view), while state.output stays the last", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first message" }] } });
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second message" }] } });
	// The live snapshot must show BOTH messages (the user reads the progression in f9),
	// not just the latest — a new message must not erase the previous one.
	assert.match(snapshot(s).output, /first message/);
	assert.match(snapshot(s).output, /second message/);
	// The final answer (used for the returned result) is still the last text only.
	assert.equal(s.output, "second message");
});

test("snapshot exposes a compact progress view of the accumulating state", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { input: 4, output: 2 } },
	});
	const snap = snapshot(s);
	assert.equal(snap.output, "partial");
	assert.equal(snap.turns, 1);
	assert.equal(snap.tokens, 6);
});

test("applyEvent ignores non-message_end events, non-assistant roles, and malformed input", () => {
	const s = createStreamState();
	applyEvent(s, { type: "turn_start" });
	applyEvent(s, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
	applyEvent(s, "garbage");
	applyEvent(s, null);
	assert.equal(s.output, "");
	assert.equal(s.usage.turns, 0);
	assert.equal(s.sawAssistant, false);
});

test("emptyUsage returns a fresh all-zero usage object on each call", () => {
	const a = emptyUsage();
	assert.deepEqual(a, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
	const b = emptyUsage();
	assert.notEqual(a, b, "each call returns a new object");
	a.input = 99;
	assert.equal(b.input, 0, "mutating one does not affect another");
});

test("firstText picks text after a non-text part, and the first of multiple texts", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", name: "x" }, { type: "text", text: "after-tool" }] },
	});
	assert.equal(s.output, "after-tool");
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
	});
	assert.equal(s.output, "one", "first text part wins");
});

test("firstText leaves output unchanged when content is missing or not an array", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "keep" }] } });
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: "not-an-array" } });
	applyEvent(s, { type: "message_end", message: { role: "assistant" } });
	assert.equal(s.output, "keep");
	assert.equal(s.usage.turns, 3);
});

test("num guards: NaN or non-number usage fields contribute 0", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [], usage: { input: "x", output: NaN, cacheRead: 5 } },
	});
	assert.equal(s.usage.input, 0);
	assert.equal(s.usage.output, 0);
	assert.equal(s.usage.cacheRead, 5);
});

test("usage.cost contributes 0 when cost is a plain number (only cost.total counts)", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [], usage: { cost: 0.5 } },
	});
	assert.equal(s.usage.cost, 0);
});

test("contextTokens is replaced each turn, not summed", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 100 } } });
	assert.equal(s.usage.contextTokens, 100);
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 250 } } });
	assert.equal(s.usage.contextTokens, 250);
});

test("model ignored when non-string; stopReason and errorMessage ignored when non-string", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [], model: 123, stopReason: 5, errorMessage: { x: 1 } },
	});
	assert.equal(s.model, undefined);
	assert.equal(s.stopReason, undefined);
	assert.equal(s.errorMessage, undefined);
});

test("feedLines: empty chunk preserves buffer as rest; consecutive newlines yield an empty line", () => {
	assert.deepEqual(feedLines("buf", ""), { lines: [], rest: "buf" });
	assert.deepEqual(feedLines("", "a\n\nb"), { lines: ["a", ""], rest: "b" });
});

test("snapshot of a brand-new stream state is zeroed", () => {
	assert.deepEqual(snapshot(createStreamState()), { output: "", turns: 0, tokens: 0 });
});

// --- G1: cacheWrite is num-guarded like the other usage fields ---
test("num guard applies to cacheWrite (NaN contributes 0)", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { cacheWrite: NaN } } });
	assert.equal(s.usage.cacheWrite, 0);
});

// --- G2: CRLF input yields clean lines (trailing CR stripped) ---
test("feedLines strips a trailing CR so CRLF output parses cleanly", () => {
	assert.deepEqual(feedLines("", "a\r\nb"), { lines: ["a"], rest: "b" });
	assert.deepEqual(feedLines("", "a\r\nb\r\nc"), { lines: ["a", "b"], rest: "c" });
	// A bare CR (no following LF) stays in the partial remainder.
	assert.deepEqual(feedLines("", "a\rb"), { lines: [], rest: "a\rb" });
});

// --- G3: sawAssistant stays true once set, even across later ignored events ---
test("sawAssistant remains true after a subsequent ignored event", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
	assert.equal(s.sawAssistant, true);
	applyEvent(s, { type: "turn_start" });
	assert.equal(s.sawAssistant, true);
});

// --- G4: a text part whose `text` is non-string is skipped, not accepted ---
test("firstText skips a text part with a non-string body and takes the next valid one", () => {
	const s = createStreamState();
	applyEvent(s, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: 123 }, { type: "text", text: "ok" }] },
	});
	assert.equal(s.output, "ok");
});

// --- G5: cost.total is num-guarded (non-number total contributes 0) ---
test("usage.cost contributes 0 when cost.total is non-number", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { cost: { total: NaN } } } });
	assert.equal(s.usage.cost, 0);
});

test("the delivered USER prompt echoed as message_start does not become the agent's live output", () => {
	// Real pi emits message_start/message_end for the prompt it just delivered. Folding it
	// into `partial` would make the child's own task look like streamed progress — cancelling
	// the startup deadline and salvaging the prompt as "partial output before it failed".
	const s = createStreamState();
	applyEvent(s, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Task: summarise the repo" }] } });
	applyEvent(s, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: summarise the repo" }] } });
	assert.equal(s.partial, "", "the user prompt never enters the live partial");
	assert.equal(snapshot(s).output, "", "no progress is reported before the assistant speaks");
});

test("a toolResult message_start/message_update does not pollute the live partial", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_start", message: { role: "toolResult", content: [{ type: "text", text: "10000 lines of grep output" }] } });
	applyEvent(s, { type: "message_update", message: { role: "toolResult", content: [{ type: "text", text: "10000 lines of grep output" }] } });
	assert.equal(s.partial, "");
	assert.equal(snapshot(s).output, "");
});

test("message_update deltas (pi ≥0.83, no cumulative message) assemble the live text", () => {
	// pi HEAD's JSON wire mode strips both `message` and `assistantMessageEvent.partial`
	// from message_update — live text has to be assembled from contentIndex/delta.
	const s = createStreamState();
	applyEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Three facts " } });
	assert.match(snapshot(s).output, /Three facts /, "the first delta is visible mid-generation");
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "close this" } });
	assert.equal(s.partial, "Three facts close this", "deltas accumulate, they do not replace");
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Three facts close this decisively." }] } });
	assert.equal(s.partial, "", "partial clears once the message completes");
	assert.match(snapshot(s).output, /decisively/);
});

test("delta assembly keeps thinking and answer text in contentIndex order, and ignores toolcall args", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "weighing the options" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "the answer is json" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"path":"src' } });
	const out = snapshot(s).output;
	assert.ok(out.indexOf("weighing the options") === 0, `reasoning comes first: ${out}`);
	assert.match(out, /the answer is json/);
	assert.doesNotMatch(out, /"path"/, "raw tool-call argument JSON is not live output");
});

test("delta assembly starts fresh for each message — the previous turn's deltas do not leak", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first turn" } });
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first turn" }] } });
	applyEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second turn" } });
	assert.equal(s.partial, "second turn");
});

test("a text_end delta replaces its slot with the authoritative content", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "par" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "partial then whole" } });
	assert.equal(s.partial, "partial then whole");
});

test("delta assembly matches a naive re-join of every part, for every shape the wire produces", () => {
	// The assembly is incremental (a delta appends to the already-joined text instead of
	// re-joining every part, which is quadratic in message length). It has to stay
	// byte-identical to the obvious computation — including the out-of-order, blank-part and
	// *_end-replaces-a-part cases the fast path cannot take.
	const s = createStreamState();
	const shadow: string[] = [];
	let expected = "";
	const check = () => {
		const live = shadow.filter((p) => p.trim()).join("\n\n");
		if (live) expected = live; // an empty assembly is never published, so `partial` holds
		assert.equal(s.partial, expected);
	};
	const delta = (contentIndex: number, d: string, type = "text_delta") => {
		applyEvent(s, { type: "message_update", assistantMessageEvent: { type, contentIndex, delta: d } });
		shadow[contentIndex] = (shadow[contentIndex] ?? "") + d;
		check();
	};
	const end = (contentIndex: number, content: string, type = "text_end") => {
		applyEvent(s, { type: "message_update", assistantMessageEvent: { type, contentIndex, content } });
		shadow[contentIndex] = content;
		check();
	};

	applyEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
	delta(0, "weighing ", "thinking_delta");
	delta(0, "the options", "thinking_delta");
	delta(1, "the answer ");
	delta(1, "is json");
	delta(0, " (still)", "thinking_delta"); // a late delta for an EARLIER part
	end(0, "weighing the options, carefully", "thinking_end"); // replaces the slot wholesale
	delta(1, " — final");
	delta(2, "   "); // a blank part is excluded from the join
	delta(2, "and a tail"); // …until it isn't
	end(1, "the answer is json — final.");
	end(2, ""); // an emptied slot drops out again

	// The activity label clears on any delta that leaves a visible assembly, blank part or not.
	applyEvent(s, { type: "tool_execution_start", toolName: "grep", args: { pattern: "x" } });
	assert.match(s.activity ?? "", /grep/);
	delta(3, "  ");
	assert.equal(s.activity, undefined, "a delta means generating, not running a tool");
});

test("a malformed delta line is dropped — a wild contentIndex cannot allocate a sparse parts array", () => {
	// These events arrive as JSON lines from a child process's stdout. A single bad line
	// setting a huge index would make every later assembly walk a billion-slot array.
	const s = createStreamState();
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 5_000_000, delta: "wild" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: -1, delta: "wild" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1.5, delta: "wild" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: "0", delta: "wild" } });
	assert.equal(s.deltaParts.length, 0, "no slot is allocated for an out-of-range index");
	assert.equal(s.partial, "");
	// A non-string payload leaves the slot it names untouched, rather than assembling "undefined".
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "real" } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: { not: "a string" } } });
	applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: 42 } });
	assert.equal(s.partial, "real");
});

test("the live partial is bounded — one huge content part must not grow supervisor memory without limit", () => {
	// MAX_CONTENT_PARTS bounds the NUMBER of parts; nothing on the wire bounds the bytes in
	// one. snapshot() copies `partial` on every event, per leg, so an unbounded part is the
	// same leak the transcript cap already closes.
	const s = createStreamState();
	applyEvent(s, {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: `HEADMARK${"x".repeat(5_000_000)}TAILMARK` },
	});
	assert.ok(s.partial.length < 250_000, `partial stays bounded (got ${s.partial.length})`);
	assert.match(s.partial, /TAILMARK$/, "the live tail is what the user is watching");
	assert.doesNotMatch(s.partial, /HEADMARK/, "the old head is trimmed");
	assert.ok(snapshot(s).output.length < 250_000, "the snapshot handed to onProgress is bounded too");

	// The same bound applies to deltas accumulating past the cap…
	const d = createStreamState();
	for (let i = 0; i < 60; i++) {
		applyEvent(d, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(10_000) } });
	}
	assert.ok(d.partial.length < 250_000, `accumulated deltas stay bounded (got ${d.partial.length})`);

	// …and to a cumulative `message` (the pre-0.83 wire shape).
	const m = createStreamState();
	applyEvent(m, {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: `HEADMARK${"z".repeat(5_000_000)}TAILMARK` }] },
	});
	assert.ok(m.partial.length < 250_000, `a huge cumulative message stays bounded (got ${m.partial.length})`);
	assert.match(m.partial, /TAILMARK$/);
});

test("delta assembly stays linear — a long streamed message does not re-join every part per delta", () => {
	// Re-joining deltaParts on every delta is quadratic in message length, on the hot path of
	// every delegated leg. The in-process engine folds events on the SUPERVISOR's own loop, so
	// the stall freezes the TUI, the peek watchdog and every sibling leg's delivery. Measured
	// against the re-joining version on this machine: 60k deltas ≈ 2.6s, 120k ≈ 10s.
	const s = createStreamState();
	applyEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
	const started = Date.now();
	for (let i = 0; i < 120_000; i++) {
		applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token " } });
	}
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2_000, `assembly must stay linear (120k deltas took ${elapsed}ms)`);
	assert.match(s.partial, /token $/, "and it still assembles the text");
});

// --- G6: a later turn without totalTokens must NOT zero the running contextTokens ---
test("contextTokens is preserved when a later turn omits totalTokens", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 100 } } });
	assert.equal(s.usage.contextTokens, 100);
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 1 } } });
	assert.equal(s.usage.contextTokens, 100, "missing totalTokens leaves the prior value intact");
});

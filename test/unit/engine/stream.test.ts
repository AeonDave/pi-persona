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

// --- G6: a later turn without totalTokens must NOT zero the running contextTokens ---
test("contextTokens is preserved when a later turn omits totalTokens", () => {
	const s = createStreamState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 100 } } });
	assert.equal(s.usage.contextTokens, 100);
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 1 } } });
	assert.equal(s.usage.contextTokens, 100, "missing totalTokens leaves the prior value intact");
});

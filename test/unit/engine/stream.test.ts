import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, createStreamState, feedLines, snapshot } from "../../../src/engine/stream.ts";

test("feedLines buffers partial lines across chunks", () => {
	assert.deepEqual(feedLines("", "a\nb\nc"), { lines: ["a", "b"], rest: "c" });
	assert.deepEqual(feedLines("x", "y\nz"), { lines: ["xy"], rest: "z" });
	assert.deepEqual(feedLines("", "no newline"), { lines: [], rest: "no newline" });
	assert.deepEqual(feedLines("", "a\n"), { lines: ["a"], rest: "" });
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

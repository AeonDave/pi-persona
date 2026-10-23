import { test } from "node:test";
import assert from "node:assert/strict";

import { MONITOR_OUTPUT_TAIL_CHARS, MonitorOutputTail } from "../../../src/core/monitor-output.ts";

test("sanitized tail storage is capped at 4000 code units across giant and repeated input", () => {
	const tail = new MonitorOutputTail();
	tail.append("old\n" + "x".repeat(1_000_000) + "END");
	assert.equal(tail.text.length, MONITOR_OUTPUT_TAIL_CHARS);
	assert.equal(tail.text, "x".repeat(MONITOR_OUTPUT_TAIL_CHARS - 3) + "END");
	for (let i = 0; i < 100; i++) {
		tail.append("next\n".repeat(100));
		assert.ok(tail.text.length <= MONITOR_OUTPUT_TAIL_CHARS);
	}
	assert.equal(tail.preview, "next");
});

test("oversized unterminated control payloads keep no printable payload and recover at ST", () => {
	for (const opener of ["\u001b]", "\u009d", "\u001bP", "\u0090", "\u001bX", "\u0098", "\u001b^", "\u009e", "\u001b_", "\u009f"]) {
		const tail = new MonitorOutputTail();
		tail.append(`before${opener}`);
		for (let i = 0; i < 50; i++) tail.append("secret".repeat(1_000));
		assert.equal(tail.text, "before", opener);
		tail.append("\u001b");
		tail.append("\\after");
		assert.equal(tail.text, "beforeafter", opener);
	}
});

test("CSI, OSC, DCS and charset escapes are inert at every possible split", () => {
	const text = "a\u001b[1;32mb\u001b[0mc\u001b]title\u0007d\u001b]link\u001b\\e\u001bPdata\u001b\\f\u001b(Bg\u009b2Kh\u009dtitle\u009ci";
	for (let split = 0; split <= text.length; split++) {
		const tail = new MonitorOutputTail();
		tail.append(text.slice(0, split));
		tail.append(text.slice(split));
		assert.equal(tail.text, "abcdefghi", `split ${split}`);
	}
});

test("CR progress replaces only the current line and split CRLF completes that line", () => {
	const tail = new MonitorOutputTail();
	tail.append("log\nold progress\r");
	assert.equal(tail.preview, "old progress");
	tail.append("\u001b[2Knew\r");
	tail.append("\nlast");
	assert.equal(tail.text, "log\nnew\nlast");
	tail.append("\rshort");
	assert.equal(tail.text, "log\nnew\nshort");
});

test("ring eviction and split astral characters never render a lone surrogate", () => {
	const tail = new MonitorOutputTail();
	tail.append("🙂" + "x".repeat(MONITOR_OUTPUT_TAIL_CHARS - 1));
	assert.equal(tail.text, "x".repeat(MONITOR_OUTPUT_TAIL_CHARS - 1));
	tail.append("\r\ud83d");
	assert.equal(tail.text, "");
	tail.append("\ude42");
	assert.equal(tail.text, "🙂");
});

test("raw tabs and Unicode line separators become spaces; controls and bidi overrides are removed", () => {
	const tail = new MonitorOutputTail();
	tail.append("a\u0000\u0008\u007fb\tc\u2028d\u2029e\u202ef\u2066g\u2069");
	assert.equal(tail.text, "ab c d efg");
	assert.equal(tail.preview, "ab c d efg");
});

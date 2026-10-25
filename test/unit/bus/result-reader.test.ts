import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadReply, isReadReplyFor, readFailure } from "../../../src/bus/result-reader.ts";
import { isFrame } from "../../../src/bus/broker/messages.ts";
import { encodeFrame } from "../../../src/bus/broker/framing.ts";

const reqId = "12345678-1234-1234-1234-123456789abc";
const ref = `result:${reqId}`;
const page = { ok: true, ref, body: "😀", offset: 0, nextOffset: 2, storedChars: 4, originalChars: 6,
	truncated: true, endOfStoredBody: false, status: "failed", provenance: "partial-output" } as const;

test("read replies expose only the narrow closed page contract", () => {
	assert.equal(isReadReply(page), true);
	assert.equal(isReadReplyFor(page, { ref, limit: 2 }), true);
	for (const patch of [{ summary: {} }, { accounting: {} }, { originKey: "secret" }, { task: "secret" },
		{ offset: -1 }, { nextOffset: 3 }, { originalChars: 3 }, { storedChars: 1 }, { truncated: false },
		{ endOfStoredBody: true }, { status: "running" }, { provenance: "task" }, { body: "a".repeat(16001) }]) {
		assert.equal(isReadReply({ ...page, ...patch }), false, JSON.stringify(patch).slice(0, 80));
	}
	assert.equal(isReadReplyFor(page, { ref, offset: 1 }), false);
	assert.equal(isReadReplyFor(page, { ref: "result:00000000-0000-0000-0000-000000000000" }), false);
	assert.equal(isReadReply({ ...page, body: "", nextOffset: 0 }), false, "nonterminal pages make headway");
	assert.equal(isReadReply({ ...page, body: "", offset: 4, nextOffset: undefined, endOfStoredBody: true }), false,
		"closed optional keys must be omitted, not undefined");
});

test("reader errors have fixed codes and fixed bounded messages, never callback text", () => {
	assert.equal(isReadReply(readFailure("denied")), true);
	assert.equal(isReadReply({ ...readFailure("denied"), message: "/secret/path" }), false);
	assert.equal(isReadReply({ ...readFailure("denied"), summary: {} }), false);
	assert.equal(isReadReply({ ok: false, code: "other", message: "other" }), false);
});

test("maximal control/escaping/lone-surrogate pages survive the 128KiB encoded response ceiling", () => {
	for (const body of ["\0".repeat(16000), "\ud800".repeat(16000), "\"\\\n\r".repeat(4000), "😀".repeat(8000)]) {
		const { nextOffset: _next, ...base } = page;
		const result = { ...base, body, storedChars: 16000, originalChars: 16000, truncated: false, endOfStoredBody: true };
		const frame = { t: "result_read_reply", reqId, result };
		assert.equal(isFrame(frame), true);
		const encoded = encodeFrame(frame);
		assert.ok(encoded.length <= 128 * 1024);
		assert.equal(JSON.parse(encoded.subarray(4).toString()).result.body, body);
	}
});

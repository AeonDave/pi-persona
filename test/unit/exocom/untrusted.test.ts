import assert from "node:assert/strict";
import { test } from "node:test";
import { untrusted, UNTRUSTED_MAX } from "../../../src/exocom/untrusted.ts";

test("untrusted strips terminal controls, collapses whitespace, trims, and bounds length", () => {
	const hostile = "\x1b[31malpha\x1b[0m   line one\nline two";
	assert.equal(untrusted(hostile, 200), "alpha line one line two");
	assert.equal(untrusted("a".repeat(300), 10), "a".repeat(10));
	assert.equal(untrusted("  padded  ", 200), "padded");
});

test("UNTRUSTED_MAX exposes the shared per-field caps used across every exocom surface", () => {
	assert.deepEqual(UNTRUSTED_MAX, { slice: 80, writePath: 120, question: 200, label: 48 });
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { childLabel, formatRunId, sanitizeNamePart } from "../../../src/core/ids.ts";

test("sanitizeNamePart lowercases and reduces to [a-z0-9-]", () => {
	assert.equal(sanitizeNamePart("Code Review!"), "code-review");
	assert.equal(sanitizeNamePart("  a__b  "), "a-b");
	assert.equal(sanitizeNamePart("MAGI-1"), "magi-1");
	assert.equal(sanitizeNamePart("***"), "");
});

test("childLabel labels a single agent and disambiguates fan-out copies (1-based)", () => {
	assert.equal(childLabel("scout"), "scout");
	assert.equal(childLabel("scout", 0), "scout#1");
	assert.equal(childLabel("scout", 2), "scout#3");
	assert.equal(childLabel("Web Search", 1), "web-search#2");
	assert.equal(childLabel(""), "agent");
});

test("formatRunId is deterministic for given (seq, timestamp) and starts with 'r'", () => {
	assert.equal(formatRunId(0, 0), "r0-0");
	assert.equal(formatRunId(1, 0), "r0-1");
	assert.match(formatRunId(7, 123456), /^r[0-9a-z]+-[0-9a-z]+$/);
	assert.notEqual(formatRunId(2, 0), formatRunId(3, 0));
});

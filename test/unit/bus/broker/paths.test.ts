import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { brokerEndpoint, sanitizeSegment } from "../../../../src/bus/broker/paths.ts";

test("sanitizeSegment lowercases and replaces non-alphanumerics with hyphens", () => {
	assert.equal(sanitizeSegment("/Users/Alice"), "users-alice");
	assert.equal(sanitizeSegment("C:\\Users\\Bob 2"), "c-users-bob-2");
});

test("brokerEndpoint is a per-session windows pipe / posix socket", () => {
	const win = brokerEndpoint("sess1", "C:\\Users\\Bob", "win32");
	assert.match(win, /^\\\\\.\\pipe\\pi-persona-.*-sess1$/);
	const posix = brokerEndpoint("sess1", "/home/bob", "linux");
	assert.equal(posix, join("/home/bob", ".pi", "agent", "pi-persona", "broker-sess1.sock"));
});

test("distinct sessions get distinct endpoints (no cross-session bus)", () => {
	assert.notEqual(brokerEndpoint("a", "/home/x", "linux"), brokerEndpoint("b", "/home/x", "linux"));
});

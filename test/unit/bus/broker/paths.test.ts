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

test("a POSIX endpoint stays within the sun_path limit for a long home + uuid session id", () => {
	const home = "/home/engineering-users/firstname.lastname";
	const sid = "0192f3ab-1c2d-7e4f-8a9b-0c1d2e3f4a5b";
	const ep = brokerEndpoint(sid, home, "linux");
	assert.ok(Buffer.byteLength(ep) <= 103, `endpoint is ${Buffer.byteLength(ep)} bytes: ${ep}`);
	assert.equal(ep, brokerEndpoint(sid, home, "linux"), "both sides of the dial derive the same path");
	assert.notEqual(ep, brokerEndpoint("0192f3ab-1c2d-7e4f-8a9b-0c1d2e3f4a5c", home, "linux"));
	assert.ok(ep.startsWith(join(home, ".pi", "agent", "pi-persona")), "stays in the user's pi dir");
});

test("distinct sessions get distinct endpoints (no cross-session bus)", () => {
	assert.notEqual(brokerEndpoint("a", "/home/x", "linux"), brokerEndpoint("b", "/home/x", "linux"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";

import { brokerEndpoint, sanitizeSegment } from "../../../../src/bus/broker/paths.ts";

const TMP = "/tmp";

test("sanitizeSegment lowercases and replaces non-alphanumerics with hyphens", () => {
	assert.equal(sanitizeSegment("/Users/Alice"), "users-alice");
	assert.equal(sanitizeSegment("C:\\Users\\Bob 2"), "c-users-bob-2");
});

test("brokerEndpoint is a per-session windows pipe", () => {
	const win = brokerEndpoint("sess1", "C:\\Users\\Bob", "win32", "C:\\Temp");
	assert.equal(win, "\\\\.\\pipe\\pi-persona-c-users-bob-sess1");
});

test("a POSIX endpoint lives in a per-user private directory under tmp, never under home", () => {
	const ep = brokerEndpoint("sess1", "/home/bob", "linux", TMP);
	assert.equal(dirname(dirname(ep)), join(TMP));
	assert.match(basename(dirname(ep)), /^pi-broker-[0-9a-f]{12}$/);
	assert.match(basename(ep), /^[0-9a-f]{16}\.sock$/);
	assert.ok(!ep.startsWith("/home/bob"), ep);
	assert.equal(ep, brokerEndpoint("sess1", "/home/bob", "linux", TMP), "both sides of the dial derive the same path");
	assert.notEqual(dirname(ep), dirname(brokerEndpoint("sess1", "/home/alice", "linux", TMP)), "one directory per home");
});

test("a POSIX endpoint has a fixed size within sun_path for a long home and a uuid session id", () => {
	const home = `/home/${"x".repeat(200)}`;
	const tmp = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";
	const sid = "0192f3ab-1c2d-7e4f-8a9b-0c1d2e3f4a5b";
	const ep = brokerEndpoint(sid, home, "darwin", tmp);
	assert.ok(Buffer.byteLength(ep) <= 103, `endpoint is ${Buffer.byteLength(ep)} bytes: ${ep}`);
	assert.equal(Buffer.byteLength(ep), Buffer.byteLength(join(tmp, "pi-broker-" + "0".repeat(12), "0".repeat(16) + ".sock")));
});

test("distinct sessions get distinct endpoints (no cross-session bus)", () => {
	assert.notEqual(brokerEndpoint("a", "/home/x", "linux", TMP), brokerEndpoint("b", "/home/x", "linux", TMP));
});

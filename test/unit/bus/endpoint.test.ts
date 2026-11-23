import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brokerEndpoint } from "../../../src/bus/broker/paths.ts";
import { MAX_ENDPOINT_BYTES, preparePrivateEndpointDir, shortHash } from "../../../src/bus/endpoint.ts";

test("shortHash is deterministic, fixed-length and honours the length argument", () => {
	assert.equal(shortHash("session-a"), shortHash("session-a"));
	assert.notEqual(shortHash("session-a"), shortHash("session-b"));
	assert.match(shortHash("x".repeat(10_000)), /^[0-9a-f]{16}$/);
	assert.equal(shortHash("session-a", 8).length, 8);
	assert.equal(shortHash("session-a", 8), shortHash("session-a").slice(0, 8));
});

function withTemp(fn: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "endpoint-test-"));
	try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("preparePrivateEndpointDir creates a 0700 directory, or does nothing on win32", () => {
	withTemp((root) => {
		const dir = join(root, "sock");
		preparePrivateEndpointDir(join(dir, "ep.sock"), "test");
		if (process.platform === "win32") {
			assert.equal(existsSync(dir), false, "win32 creates nothing");
			return;
		}
		assert.equal(statSync(dir).mode & 0o777, 0o700);
	});
});

test("preparePrivateEndpointDir tightens a looser existing directory (POSIX)", () => {
	if (process.platform === "win32") return;
	withTemp((root) => {
		const dir = join(root, "sock");
		mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		preparePrivateEndpointDir(join(dir, "ep.sock"), "test");
		assert.equal(statSync(dir).mode & 0o777, 0o700);
	});
});

test("preparePrivateEndpointDir rejects a symlinked directory and a file in its place (POSIX)", () => {
	if (process.platform === "win32") return;
	withTemp((root) => {
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);
		assert.throws(() => preparePrivateEndpointDir(join(link, "ep.sock"), "test"), /unsafe socket directory/);
		const file = join(root, "file");
		writeFileSync(file, "x");
		assert.throws(() => preparePrivateEndpointDir(join(file, "ep.sock"), "test"));
	});
});

test("a POSIX endpoint over the sockaddr_un limit fails closed before any directory is made", () => {
	const longTmp = join("/", "t".repeat(70));
	const endpoint = brokerEndpoint("sess", "/home/bob", "linux", longTmp);
	assert.ok(Buffer.byteLength(endpoint) > MAX_ENDPOINT_BYTES, "the fixture is over the limit");
	assert.throws(() => preparePrivateEndpointDir(endpoint, "test", "linux"), /too long/);
	const edge = "/" + "e".repeat(MAX_ENDPOINT_BYTES - 1);
	assert.equal(Buffer.byteLength(edge), MAX_ENDPOINT_BYTES);
	assert.throws(() => preparePrivateEndpointDir(edge + "e", "test", "linux"), /too long/);
	if (process.platform !== "win32") assert.equal(existsSync(longTmp), false, "nothing was created for the rejected path");
});

test("a Windows pipe name is not subject to the socket path limit", () => {
	preparePrivateEndpointDir("\\.\pipe\\" + "p".repeat(300), "test", "win32");
});

test("preparePrivateEndpointDir rejects a directory owned by another user (POSIX)", () => {
	const getuid = process.getuid;
	if (process.platform === "win32" || getuid === undefined) return;
	withTemp((root) => {
		const dir = join(root, "sock");
		mkdirSync(dir, { mode: 0o700 });
		process.getuid = () => getuid.call(process) + 1;
		try {
			assert.throws(() => preparePrivateEndpointDir(join(dir, "ep.sock"), "test"), /not owned by this user/);
		} finally { process.getuid = getuid; }
	});
});

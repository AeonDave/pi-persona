import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { agentsDir, endpoint, exocomRoot, registryPath, socketPath, workspaceHash } from "../../../src/exocom/paths.ts";

test("workspaceHash is a stable 24-hex of the resolved project root", () => {
	const a = workspaceHash("/work/proj");
	const b = workspaceHash("/work/proj");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{24}$/);
	assert.notEqual(a, workspaceHash("/work/other"));
});

test("registry layout stays workspace-scoped while AF_UNIX endpoints stay short and hashed", () => {
	const h = "abc123";
	assert.ok(exocomRoot("/agent", h).endsWith(join("pi-persona", "exocom", h)));
	assert.ok(agentsDir("/agent", h).endsWith(join("exocom", h, "agents")));
	assert.ok(registryPath("/agent", h, "elite").endsWith(join("agents", "elite.json")));
	const longSession = `session-${"x".repeat(200)}`;
	const socket = socketPath(`/very/${"long/".repeat(20)}agent-dir`, h, longSession);
	assert.ok(socket.startsWith(tmpdir()), "socket is independent of the potentially long agentDir");
	assert.match(basename(dirname(socket)), /^pi-exocom-[0-9a-f]{16}$/);
	assert.match(basename(socket), /^[0-9a-f]{20}\.sock$/);
	assert.doesNotMatch(socket, /session-x/, "raw session id never enters sockaddr_un");
	assert.ok(Buffer.byteLength(socket, "utf8") <= 103, "fits macOS sockaddr_un including the NUL terminator");
});

test("endpoint is deterministic, workspace-bound and contains no raw session id", () => {
	const session = `sid-${"z".repeat(80)}`;
	const win = endpoint("/agent", "workspace-a", session, "win32");
	assert.ok(win.startsWith("\\\\.\\pipe\\pi-persona-exocom-"));
	assert.doesNotMatch(win, /sid-z/);
	assert.notEqual(win, endpoint("/agent", "workspace-b", session, "win32"), "workspace hash binds the pipe namespace");
	assert.notEqual(win, endpoint("/agent", "workspace-a", `${session}-other`, "win32"), "session hash distinguishes instances");
	assert.equal(endpoint("/agent", "workspace-a", session, "linux"), socketPath("/agent", "workspace-a", session));
});

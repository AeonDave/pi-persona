import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentsDir, endpoint, exocomRoot, registryPath, socketPath, workspaceHash } from "../../../src/exocom/paths.ts";

test("workspaceHash is a stable 24-hex of the resolved project root", () => {
	const a = workspaceHash("/work/proj");
	const b = workspaceHash("/work/proj");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{24}$/);
	assert.notEqual(a, workspaceHash("/work/other"));
});

test("layout lives under <agentDir>/pi-persona/exocom/<hash>/", () => {
	const h = "abc123";
	assert.ok(exocomRoot("/agent", h).endsWith(join("pi-persona", "exocom", h)));
	assert.ok(agentsDir("/agent", h).endsWith(join("exocom", h, "agents")));
	assert.ok(registryPath("/agent", h, "elite").endsWith(join("agents", "elite.json")));
	assert.ok(socketPath("/agent", h, "s1").endsWith(join("exocom", h, "sockets", "s1.sock")));
});

test("endpoint is a named pipe on win32, a socket file elsewhere", () => {
	assert.equal(endpoint("/agent", "h", "s1", "win32"), "\\\\.\\pipe\\pi-persona-exocom-s1");
	assert.equal(endpoint("/agent", "h", "s1", "linux"), socketPath("/agent", "h", "s1"));
});

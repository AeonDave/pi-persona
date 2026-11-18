import assert from "node:assert/strict";
import { test } from "node:test";
import { launchRequestLines, readLaunchRequest, snapshotLaunchRequest } from "../../../src/ui/launch-request.ts";

test("expanded launch preserves the requested verification and renders command text literally", () => {
	const request = { task: "Fix", verification: { command: "node check.cjs\n\u001b[2J", timeoutMs: 1_000 } };
	const saved = snapshotLaunchRequest(request);
	request.verification.command = "changed";
	const restored = readLaunchRequest(JSON.parse(JSON.stringify(saved)));
	assert.ok(restored);
	const lines = launchRequestLines(restored).join("\n");
	assert.match(lines, /node check\.cjs/);
	assert.match(lines, /Deadline: 1000 ms; cwd: isolated worktree/);
	assert.doesNotMatch(lines, /\u001b|changed/);
});

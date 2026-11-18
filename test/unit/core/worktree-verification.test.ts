import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerification, verificationAllowsBash } from "../../../src/core/worktree-verification.ts";

test("worktree verification admits one bounded command with an optional bounded deadline", () => {
	assert.deepEqual(parseVerification({ command: "npm test" }), { ok: true, value: { command: "npm test" } });
	assert.deepEqual(parseVerification({ command: "echo ok", timeoutMs: 1000 }), { ok: true, value: { command: "echo ok", timeoutMs: 1000 } });
	for (const value of [null, "npm test", {}, { command: " " }, { command: "x\0" }, { command: "x".repeat(8193) }, { command: "x", cwd: "/other" }, ...[0, -1, 0.5, Infinity, 3600001].map((timeoutMs) => ({ command: "x", timeoutMs }))]) {
		assert.equal(parseVerification(value).ok, false, JSON.stringify(value));
	}
});

test("verification requires effective worker bash permission including inherited defaults and deny wins", () => {
	assert.equal(verificationAllowsBash(undefined, undefined), true);
	assert.equal(verificationAllowsBash(undefined, ["read"]), false);
	assert.equal(verificationAllowsBash([], undefined), false);
	assert.equal(verificationAllowsBash(["read", "b*"], ["read"]), true);
	assert.equal(verificationAllowsBash(["*"], undefined, ["bash"]), false);
	assert.equal(verificationAllowsBash(["+bash"], undefined), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateResumeRequest } from "../../../src/extension/conversations.ts";

test("continuation accepts only an exact prior run and a new task, with optional brief", () => {
	assert.equal(validateResumeRequest({ resume: "run-1", task: "Correct the reviewed defect" }), undefined);
	assert.match(validateResumeRequest({ resume: "../other.jsonl", task: "go" })!, /run/i);
	assert.match(validateResumeRequest({ resume: "run-1", task: " " })!, /task/i);
	for (const key of ["agent", "model", "tools", "skills", "role", "name", "isolation", "mcp", "tasks", "concurrency", "outputContract", "writeSet", "thinking", "timeoutMs", "session"]) {
		assert.match(validateResumeRequest({ resume: "run-1", task: "go", [key]: [] })!, /override|only/i, key);
	}
});

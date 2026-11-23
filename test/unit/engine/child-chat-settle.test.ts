import { test } from "node:test";
import assert from "node:assert/strict";
import { runChildAgent } from "../../../src/engine/child.ts";
import type { ProgressSnapshot } from "../../../src/engine/stream.ts";

test("child engine settles a tool call the worker named but never started once the process ends", async () => {
	// The assistant message carries a toolCall, but the worker exits before tool_execution_start:
	// openToolCalls never sees it, so only the chat's own settle step can close the block.
	const event = { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "never-ran", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" } };
	const worker = `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)}); process.exitCode = 1;`;
	let last: ProgressSnapshot | undefined;
	const result = await runChildAgent({ task: "t" }, undefined, {
		resolveInvocation: () => ({ command: process.execPath, args: ["-e", worker] }),
		onProgress: (snapshot) => { last = snapshot; },
	});
	assert.equal(result.ok, false);
	const tool = last?.chat?.blocks.find((block) => block.kind === "tool");
	assert.equal(tool?.kind === "tool" && tool.status, "failed", "the final snapshot shows no tool running forever");
});

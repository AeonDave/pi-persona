import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerChat, WORKER_CHAT_LIMITS, type WorkerChatBlock } from "../../../src/core/worker-chat.ts";
import { boundChatText, chatArguments } from "../../../src/core/worker-chat-content.ts";

function text(block: WorkerChatBlock): string {
	return block.kind === "tool" ? `${block.name}${block.arguments}${block.output}` : block.text;
}

test("worker chat projects user, thinking, assistant, tools and errors in event order", () => {
	const chat = new WorkerChat();
	chat.observe({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Inspect this file" }] } });
	chat.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Inspect this file" }] } });
	chat.observe({ type: "message_start", message: { role: "assistant", content: [] } });
	chat.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Look at the callers" } });
	chat.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Reading now" } });
	chat.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Look at the callers" }, { type: "text", text: "Reading now" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }] } });
	chat.observe({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/a.ts" } });
	chat.observe({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: { content: [{ type: "text", text: "first line" }] } });
	chat.observe({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "file missing" }] }, isError: true });
	chat.observe({ type: "message_end", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "file missing" }], isError: true } });
	chat.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Cannot inspect it" }], stopReason: "error", errorMessage: "provider unavailable" } });
	const blocks = chat.snapshot().blocks;
	assert.deepEqual(blocks.map((block) => block.kind), ["user", "thinking", "assistant", "tool", "assistant", "status"]);
	assert.equal(blocks[3]?.kind, "tool");
	if (blocks[3]?.kind === "tool") {
		assert.match(blocks[3].arguments, /src\/a.ts/);
		assert.equal(blocks[3].output, "file missing");
		assert.equal(blocks[3].status, "failed");
	}
	assert.match(text(blocks.at(-1)!), /provider unavailable/);
});

test("worker chat keeps immutable snapshots and stable references for unchanged blocks", () => {
	const chat = new WorkerChat();
	chat.observe({ type: "message_end", message: { role: "user", content: "task" } });
	const first = chat.snapshot();
	chat.observe({ type: "turn_start" });
	assert.equal(chat.snapshot(), first, "unprojected events keep snapshot identity");
	chat.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } });
	const running = chat.snapshot();
	chat.observe({ type: "tool_execution_update", toolCallId: "a", toolName: "read", partialResult: { content: [] } });
	assert.equal(chat.snapshot(), running, "identical progress is not a new revision");
	chat.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "done" }] } });
	const done = chat.snapshot();
	assert.equal(done.blocks[0], first.blocks[0], "settled blocks keep renderer cache identity");
	assert.notEqual(done.blocks[1], running.blocks[1]);
	assert.equal(running.blocks[1]?.kind === "tool" && running.blocks[1].status, "running");
	assert.ok(done.revision > running.revision);
	assert.ok(Object.isFrozen(done) && Object.isFrozen(done.blocks) && done.blocks.every(Object.isFrozen));
});

test("worker chat replaces cumulative updates and final content without duplicating streamed text", () => {
	const chat = new WorkerChat();
	chat.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hel" }] } });
	chat.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
	chat.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
	assert.equal(chat.snapshot().blocks.length, 1);
	assert.equal(text(chat.snapshot().blocks[0]!), "hello");
	chat.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "next" }] } });
	assert.equal(chat.snapshot().blocks.length, 2);
	assert.notEqual(chat.snapshot().blocks[0]?.id, chat.snapshot().blocks[1]?.id);
});

test("worker chat omits image bytes and exposes textual result diffs", () => {
	const chat = new WorkerChat();
	chat.observe({ type: "message_end", message: { role: "user", content: [{ type: "image", data: "SECRET_BASE64", mimeType: "image/png" }] } });
	chat.observe({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { content: [{ type: "text", text: "Edited" }, { type: "image", data: "SECRET_BASE64" }], details: { diff: "-old\n+new" } } });
	const rendered = chat.snapshot().blocks.map(text).join("\n");
	assert.match(rendered, /image omitted/);
	assert.match(rendered, /-old\n\+new/);
	assert.doesNotMatch(rendered, /SECRET_BASE64/);
});

test("worker chat bounds output, argument traversal and retained history", () => {
	const chat = new WorkerChat();
	const cyclic: Record<string, unknown> = { command: "x".repeat(200_000) }; cyclic.self = cyclic;
	chat.observe({ type: "tool_execution_start", toolCallId: "huge", toolName: "bash", args: cyclic });
	chat.observe({ type: "tool_execution_end", toolCallId: "huge", toolName: "bash", result: { content: [{ type: "text", text: "y".repeat(200_000) }] } });
	for (let i = 0; i < 300; i++) chat.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${i} ${"z".repeat(600)}` }] } });
	const result = chat.snapshot();
	assert.equal(result.truncated, true);
	assert.ok(result.blocks.length <= WORKER_CHAT_LIMITS.blocks);
	assert.ok(result.blocks.reduce((sum, block) => sum + text(block).length, 0) <= WORKER_CHAT_LIMITS.totalChars);
	assert.match(text(result.blocks.at(-1)!), /^299 /, "the newest content remains available");
});

test("worker chat truncation preserves surrogate pairs and argument projection reads only a bounded prefix", () => {
	for (const limit of [100, 101, 102, 103]) {
		const bounded = boundChatText("😀".repeat(100), limit);
		assert.equal(Buffer.from(bounded.text, "utf8").toString("utf8"), bounded.text, "truncation does not split a surrogate pair");
		assert.ok(bounded.text.length <= limit);
	}
	let reads = 0;
	const argumentsObject: Record<string, unknown> = {};
	for (let i = 0; i < 1000; i++) Object.defineProperty(argumentsObject, `key${i}`, { enumerable: true, get() { reads++; return i; } });
	assert.equal(chatArguments(argumentsObject, 4000).truncated, true);
	assert.equal(reads, 24);
});

test("late partial updates cannot replace a settled tool result", () => {
	const chat = new WorkerChat();
	chat.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "final" }] } });
	const settled = chat.snapshot();
	chat.observe({ type: "tool_execution_update", toolCallId: "a", toolName: "read", partialResult: { content: [{ type: "text", text: "earlier partial" }] } });
	assert.equal(chat.snapshot(), settled);
});

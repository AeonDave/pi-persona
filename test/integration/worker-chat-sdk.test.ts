import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeEngine } from "../../src/engine/adapter.ts";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";
import type { WorkerChatSnapshot } from "../../src/core/worker-chat.ts";
import type { AgentProgress, StrategyEngine } from "../../src/orchestration/sdk.ts";

function assertChat(chat: WorkerChatSnapshot | undefined, task: string): void {
	assert.ok(chat);
	const text = chat.blocks.map((block) => block.kind === "tool" ? `${block.name}\n${block.arguments}\n${block.output}` : block.text).join("\n");
	assert.match(text, new RegExp(task));
	assert.match(text, /Inspect the actual file/);
	assert.match(text, /CHAT INPUT CONTENT/);
	assert.match(text, /CHAT ANSWER/);
	const read = chat.blocks.find((block) => block.kind === "tool" && block.name === "read");
	assert.equal(read?.kind === "tool" && read.status, "done");
	assert.ok(chat.blocks.some((block) => block.kind === "user"), "the current user task is visible");
	assert.ok(chat.blocks.some((block) => block.kind === "thinking"));
}

for (const kind of ["inproc", "child"] as const) {
	test(`real ${kind} SDK worker chat includes task, thinking, read arguments/result and final answer`, { timeout: 30_000 }, async () => {
		const cwd = await mkdtemp(join(tmpdir(), `persona-chat-${kind}-`));
		try {
			await writeFile(join(cwd, "chat-input.txt"), "CHAT INPUT CONTENT\n");
			const file = join(cwd, "worker-sessions", "worker.jsonl");
			await mkdir(dirname(file));
			let engine: StrategyEngine;
			if (kind === "inproc") {
				const faux = fauxProvider({ provider: "worker-chat-test", models: [{ id: "local", reasoning: true }] });
				faux.setResponses(Array.from({ length: 2 }, (_, turn) => [
					fauxAssistantMessage([fauxThinking("Inspect the actual file."), fauxToolCall("read", { path: "chat-input.txt" }, { id: `read-${turn}` })], { stopReason: "toolUse" }),
					fauxAssistantMessage("CHAT ANSWER"),
				]).flat());
				const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
				runtime.registerNativeProvider(faux.provider);
				await runtime.setRuntimeApiKey("worker-chat-test", "synthetic-key");
				engine = makeInProcessEngine({ cwd, agentDir: cwd, resolveAgent: (name) => ({ name, source: "test", systemPrompt: "Test worker." }), modelRegistry: new ModelRegistry(runtime) });
			} else {
				const provider = fileURLToPath(new URL("../fixtures/worker-chat-provider.mjs", import.meta.url));
				const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
				await writeFile(join(cwd, "settings.json"), JSON.stringify({ extensions: [provider], retry: { enabled: false }, compaction: { enabled: false } }));
				engine = makeEngine({ cwd, resolveAgent: (name) => ({ name, source: "test", systemPrompt: "Test worker." }), childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: [cli, ...args] }), env: { PI_AGENT_DIR: cwd, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1" } } });
			}
			for (const [turn, task] of ["FIRST CHAT TASK", "SECOND CHAT TASK"].entries()) {
				let chat: WorkerChatSnapshot | undefined;
				const progress = (value: AgentProgress): void => { if (value.chat) chat = value.chat; };
				const result = await engine.run({ agent: "a", model: "worker-chat-test/local", task, tools: ["read"], session: { file, resume: turn > 0 } }, progress);
				assert.equal(result.ok, true, result.error);
				assertChat(chat, task);
				assert.doesNotMatch(JSON.stringify(result), /CHAT INPUT CONTENT/, "operator tool output is absent from the model-facing engine result");
				if (turn > 0) assert.doesNotMatch(JSON.stringify(chat), /FIRST CHAT TASK/, "resume chat is this attempt, not replayed history");
			}
		} finally { await rm(cwd, { recursive: true, force: true }); }
	});
}

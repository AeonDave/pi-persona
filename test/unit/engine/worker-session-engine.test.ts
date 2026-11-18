import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine, type CreateSessionOptions } from "../../../src/engine/inproc.ts";
import { makeEngine } from "../../../src/engine/adapter.ts";

test("in-process passes the exact session to the factory, awaits shutdown and reports saved only after completion", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-engine-"));
	const file = join(cwd, "worker.jsonl");
	const order: string[] = [];
	let observed: CreateSessionOptions | undefined;
	try {
		const engine = makeInProcessEngine({ cwd, agentDir: cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }), modelRegistry: { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry,
			createSession: async (opts) => {
				observed = opts;
				const manager = SessionManager.open(file, undefined, cwd);
				let listener: ((event: unknown) => void) | undefined;
				return { subscribe: (fn) => { listener = fn; return () => {}; },
					prompt: async (input) => { manager.appendMessage({ role: "user", content: input, timestamp: Date.now() }); const message = fauxAssistantMessage("new answer"); manager.appendMessage(message); listener?.({ type: "message_end", message }); },
					agent: { abort() {}, waitForIdle: async () => {}, steer() {} },
					shutdown: async () => { order.push("shutdown"); }, dispose: () => { order.push("dispose"); } };
			} });
		const result = await engine.run({ agent: "a", task: "first", model: "test/m", session: { file, resume: false } });
		assert.deepEqual(observed?.session, { file, resume: false });
		assert.equal(result.sessionSaved, true);
		assert.equal(result.sessionQuiescent, true);
		assert.equal(result.output, "new answer");
		assert.deepEqual(order, ["shutdown", "dispose"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("child adapter forwards an exact session path and refuses missing resume before spawn", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-child-"));
	const file = join(cwd, "worker.jsonl");
	const seen: string[][] = [];
	try {
		const engine = makeEngine({ cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }), childOptions: { resolveInvocation: (args) => { seen.push(args); return { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop'}})+'\\n')"] }; } } });
		const missing = await engine.run({ agent: "a", task: "next", session: { file, resume: true } });
		assert.equal(missing.ok, false);
		assert.equal(missing.sessionQuiescent, true);
		assert.equal(seen.length, 0);
		const fresh = await engine.run({ agent: "a", task: "first", session: { file, resume: false } });
		assert.equal(fresh.sessionSaved, false, "a successful process without a session file is not resumable");
		assert.equal(fresh.sessionQuiescent, true);
		assert.equal(seen[0]?.[seen[0]!.indexOf("--session") + 1], file);
		assert.ok(!seen[0]?.includes("--no-session"));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("in-process cancellation does not claim a prompt still unwinding is quiescent", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-abort-"));
	const file = join(cwd, "worker.jsonl");
	const controller = new AbortController();
	let prompting!: () => void;
	const started = new Promise<void>((resolve) => { prompting = resolve; });
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }), modelRegistry: { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry,
			createSession: async () => ({ subscribe: () => () => {}, prompt: async () => { prompting(); await new Promise<void>(() => {}); }, agent: { abort() {}, waitForIdle: async () => {}, steer() {} }, shutdown: async () => {}, dispose() {} }) });
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file, resume: false } }, undefined, controller.signal);
		await started;
		controller.abort();
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("pre-start model rejection marks the untouched conversation quiescent", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-unavailable-model-"));
	try {
		let built = false;
		const engine = makeInProcessEngine({ cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }),
			modelRegistry: { find: () => undefined, getAll: () => [] } as unknown as ModelRegistry,
			createSession: async () => { built = true; throw new Error("unexpected"); } });
		const result = await engine.run({ agent: "a", task: "next", model: "test/missing", session: { file: join(cwd, "worker.jsonl"), resume: true } });
		assert.equal(result.failureKind, "unknown-model");
		assert.equal(result.sessionQuiescent, true);
		assert.equal(built, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a completed provider failure awaits shutdown and may be discarded safely", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-provider-failure-"));
	try {
		let shutdown = false;
		const engine = makeInProcessEngine({ cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }),
			modelRegistry: { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry,
			createSession: async () => ({ subscribe: () => () => {}, prompt: async () => { throw new Error("401 unauthorized provider"); },
				agent: { abort() {}, waitForIdle: async () => {}, steer() {} }, shutdown: async () => { shutdown = true; }, dispose() {} }) });
		const result = await engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } });
		assert.equal(result.failureKind, "provider");
		assert.equal(shutdown, true);
		assert.equal(result.sessionQuiescent, true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

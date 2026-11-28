import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine, SHUTDOWN_PROOF_MS, type CreateSessionOptions, type InProcSession } from "../../../src/engine/inproc.ts";
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

for (const deadline of ["idle", "hard"] as const) {
	test(`in-process ${deadline} deadline ends once the worker is idle, including when shutdown emits events`, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "persona-worker-shutdown-"));
		const file = join(cwd, "worker.jsonl");
		let shutdownStarted!: () => void;
		let finishShutdown!: () => void;
		const started = new Promise<void>((resolve) => { shutdownStarted = resolve; });
		const shutdown = new Promise<void>((resolve) => { finishShutdown = resolve; });
		let listener: ((event: unknown) => void) | undefined;
		let aborts = 0;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const engine = makeInProcessEngine({
				cwd,
				resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }),
				modelRegistry: { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry,
				...(deadline === "hard" ? { hardTimeoutMs: 100 } : {}),
				createSession: async () => {
					const manager = SessionManager.open(file, undefined, cwd);
					return {
						subscribe: (fn) => { listener = fn; return () => {}; },
						prompt: async (input) => {
							manager.appendMessage({ role: "user", content: input, timestamp: Date.now() });
							const message = fauxAssistantMessage("completed");
							manager.appendMessage(message);
							listener?.({ type: "message_end", message });
						},
						agent: { abort() { aborts++; }, waitForIdle: async () => {}, steer() {} },
						shutdown: () => { shutdownStarted(); return shutdown; },
						dispose() {},
					};
				},
			});
			const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file, resume: false },
				...(deadline === "idle" ? { timeoutMs: 100 } : {}) });
			await started;
			listener?.({ type: "agent_end", messages: [] });
			t.mock.timers.tick(101);
			finishShutdown();
			const result = await pending;
			assert.equal(result.ok, true, result.error);
			assert.equal(result.output, "completed");
			assert.equal(result.sessionSaved, true);
			assert.equal(result.sessionQuiescent, true);
			assert.equal(aborts, 0);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

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

function abortableEngine(cwd: string, shutdown: () => Promise<void>, order: string[], started: () => void) {
	return makeInProcessEngine({ cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: "test" }), modelRegistry: { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry,
		createSession: async () => ({ subscribe: () => () => {}, prompt: async () => { started(); await new Promise<void>(() => {}); }, agent: { abort() {}, waitForIdle: async () => {}, steer() {} },
			shutdown: () => { order.push("shutdown"); return shutdown(); }, dispose() { order.push("dispose"); } }) });
}

test("in-process cancellation proves quiescence through the shutdown handshake but never saves the turn", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-abort-"));
	const controller = new AbortController();
	const order: string[] = [];
	let prompting!: () => void;
	const started = new Promise<void>((resolve) => { prompting = resolve; });
	try {
		const engine = abortableEngine(cwd, async () => {}, order, () => prompting());
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, controller.signal);
		await started;
		controller.abort();
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, true);
		assert.deepEqual(order, ["shutdown", "dispose"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("in-process cancellation whose shutdown never settles stays unproven after the bounded wait", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-abort-wedged-"));
	const controller = new AbortController();
	const order: string[] = [];
	let prompting!: () => void;
	const started = new Promise<void>((resolve) => { prompting = resolve; });
	let shutdownCalled!: () => void;
	const called = new Promise<void>((resolve) => { shutdownCalled = resolve; });
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const engine = abortableEngine(cwd, () => { shutdownCalled(); return new Promise<void>(() => {}); }, order, () => prompting());
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, controller.signal);
		await started;
		controller.abort();
		await called;
		mock.timers.tick(SHUTDOWN_PROOF_MS);
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, false);
		assert.deepEqual(order, ["shutdown", "dispose"]);
	} finally {
		mock.timers.reset();
		rmSync(cwd, { recursive: true, force: true });
	}
});

const testModels = { find: () => ({ provider: "test", id: "m" }), getAll: () => [] } as unknown as ModelRegistry;
const testAgent = () => ({ name: "a", source: "test", systemPrompt: "test" });

/** A session factory held open by the test, like Pi's uncancellable loader. */
function pendingFactory() {
	let begin!: () => void;
	const begun = new Promise<void>((resolve) => { begin = resolve; });
	let settle!: (session: Promise<InProcSession>) => void;
	const init = new Promise<InProcSession>((resolve) => { settle = resolve; });
	return { create: async () => { begin(); return init; }, begun, resolve: (s: InProcSession) => settle(Promise.resolve(s)), reject: (e: Error) => settle(Promise.reject(e)) };
}

function lateSession(order: string[]): InProcSession {
	return { subscribe: () => () => {}, prompt: async () => {}, agent: { abort() {}, waitForIdle: async () => {}, steer() {} },
		shutdown: async () => { order.push("shutdown"); }, dispose() { order.push("dispose"); } };
}

/** Run mocked timers forward until `pending` settles; setImmediate stays real so promise chains progress. */
async function tickUntilSettled<T>(pending: Promise<T>, step: number): Promise<T> {
	let done = false;
	void pending.finally(() => { done = true; });
	for (let i = 0; i < 20 && !done; i++) {
		mock.timers.tick(step);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return pending;
}

test("a session run cancelled during initialization waits for the late session's retirement and reports it quiescent", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-init-abort-"));
	const controller = new AbortController();
	const order: string[] = [];
	const factory = pendingFactory();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: factory.create });
		let settled = false;
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, controller.signal);
		void pending.finally(() => { settled = true; });
		await factory.begun;
		controller.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "the lease-holding run waits for the factory instead of returning unproven");
		factory.resolve(lateSession(order));
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, true);
		assert.deepEqual(order, ["shutdown", "dispose"]);
	} finally {
		mock.timers.reset();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a session run cancelled during initialization whose factory rejects is quiescent: no session ever existed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-init-reject-"));
	const controller = new AbortController();
	const factory = pendingFactory();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: factory.create });
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, controller.signal);
		await factory.begun;
		controller.abort();
		factory.reject(new DOMException("Session initialization aborted", "AbortError"));
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, true);
	} finally {
		mock.timers.reset();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a session run whose startup deadline fires during initialization reports the timeout quiescent once the late session retires", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-init-startup-"));
	const order: string[] = [];
	const factory = pendingFactory();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: factory.create, startupTimeoutMs: 1_000 });
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } });
		await factory.begun;
		mock.timers.tick(1_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		factory.resolve(lateSession(order));
		const result = await pending;
		assert.equal(result.failureKind, "timeout");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, true);
		assert.deepEqual(order, ["shutdown", "dispose"]);
	} finally {
		mock.timers.reset();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a session run cancelled during an initialization that never settles stays unproven after the bounded wait", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-init-wedged-"));
	const controller = new AbortController();
	const factory = pendingFactory();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: factory.create });
		const pending = engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, controller.signal);
		await factory.begun;
		controller.abort();
		const result = await tickUntilSettled(pending, SHUTDOWN_PROOF_MS);
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, false);
	} finally {
		mock.timers.reset();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a run without a session cancelled during initialization still returns at once", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-init-plain-"));
	const controller = new AbortController();
	const factory = pendingFactory();
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: factory.create });
		const pending = engine.run({ agent: "a", task: "first", model: "test/m" }, undefined, controller.signal);
		await factory.begun;
		controller.abort();
		const result = await pending;
		assert.equal(result.failureKind, "abort");
		assert.equal(result.sessionSaved, undefined);
		assert.equal(result.sessionQuiescent, undefined);
		factory.resolve(lateSession([]));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a session run whose wiring throws after initialization proves quiescence through the shutdown handshake", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "persona-worker-wiring-"));
	const order: string[] = [];
	try {
		const engine = makeInProcessEngine({ cwd, resolveAgent: testAgent, modelRegistry: testModels, createSession: async () => lateSession(order) });
		const result = await engine.run({ agent: "a", task: "first", model: "test/m", session: { file: join(cwd, "worker.jsonl"), resume: false } }, undefined, undefined, () => { throw new Error("steer sink failed"); });
		assert.equal(result.ok, false);
		assert.equal(result.sessionSaved, false);
		assert.equal(result.sessionQuiescent, true);
		assert.deepEqual(order, ["shutdown", "dispose"]);
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

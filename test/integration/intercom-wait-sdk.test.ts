import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { AsyncRunTracker, IdleCoalescingNotifier, renderCompletion, type AsyncRun } from "../../src/engine/async.ts";
import { fenceUntrusted } from "../../src/core/fence.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import { ChildUsageLedger } from "../../src/ui/usage.ts";
import { registerIntercomTool, type IntercomToolDeps } from "../../src/tools/intercom-tool.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function rpcUIContext(): ExtensionUIContext {
	// Pi derives ExtensionContext.hasUI from bindExtensions({ mode: "rpc" }); these no-op
	// UI methods only satisfy the host surface and are not used to establish that capability.
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

test("Pi SDK RPC intercom wait is a native nonblocking tool call and steering is consumed while the child continues", { timeout: 20_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-persona-intercom-sdk-"));
	const workerGate = deferred<{ agent: string; output: string; usage: ReturnType<typeof emptyUsage>; ok: true }>();
	const secondRequestGate = deferred<void>();
	const secondRequestEntered = deferred<void>();
	const waitToolExecuted = deferred<void>();
	const steeringAccepted = deferred<void>();
	const faux = fauxProvider({ provider: "persona-intercom-sdk-test", models: [{ id: "no-bill" }] });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("persona-intercom-sdk-test", "fake-key-never-transmitted");
	const tracker = new AsyncRunTracker();
	let ctxHasUI: boolean | undefined;
	let waitForCalls = 0;
	let autoNotifications = 0;
	let finalContextText = "";
	let requests = 0;
	const childId = tracker.launch({ agent: "worker", task: "held behind a test gate" }, () => workerGate.promise);
	const completionNotifier = new IdleCoalescingNotifier<AsyncRun>({
		isIdle: () => false,
		deliver: () => {},
		render: (runs) => renderCompletion(runs, fenceUntrusted, () => undefined),
		debounceMs: 60_000,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	});
	tracker.onComplete((run) => {
		if (run.id === childId) {
			autoNotifications++;
			completionNotifier.notify(run);
		}
	});
	const originalWaitFor = tracker.waitFor.bind(tracker);
	tracker.waitFor = (...args) => {
		waitForCalls++;
		return originalWaitFor(...args);
	};
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("intercom", { action: "wait", to: childId }, { id: "wait-call" }), { stopReason: "toolUse" }),
		async () => {
			requests++;
			secondRequestEntered.resolve();
			await secondRequestGate.promise;
			return fauxAssistantMessage("intermediate assistant response");
		},
		(context) => {
			requests++;
			finalContextText = context.messages.map((message) => typeof message.content === "string"
				? message.content
				: message.content.map((block) => block.type === "text" ? block.text : "").join(""),
			).join("\n");
			return fauxAssistantMessage("completed after steering");
		},
	]);

	const extensionRuntime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory((pi) => {
		const deps: IntercomToolDeps = {
			get lastCtx(): ExtensionContext | undefined { return undefined; },
			set lastCtx(ctx: ExtensionContext | undefined) { ctxHasUI = ctx?.hasUI; },
			tracker,
			completionNotifier,
			intercomNotifier: new IdleCoalescingNotifier({ isIdle: () => true, deliver: () => {}, render: () => "", setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }),
			controller: { activePersona: undefined } as IntercomToolDeps["controller"],
			bus: {} as IntercomToolDeps["bus"],
			SUPERVISOR: "supervisor",
			STALL_FLAG_MS: 90_000,
			missingRunMessage: (id) => `missing ${id}`,
			stopAgent: () => false,
			steerAgent: () => false,
			steerRegistry: new Map(),
			stopRequested: new Set(),
			drainBusBlock: () => "",
			scanForSurrender: () => undefined,
			get disposed() { return false; },
			childUsage: new ChildUsageLedger(),
			publishPersonaCost: () => {},
		};
		registerIntercomTool(pi as ExtensionAPI, deps);
		pi.on("tool_execution_end", (event) => {
			if (event.toolName === "intercom") waitToolExecuted.resolve();
		});
	}, cwd, createEventBus(), extensionRuntime, "<intercom-wait-sdk-test>");
	const resourceLoader = {
		getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Test agent.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as unknown as ResourceLoader;
	const model = runtime.getModel("persona-intercom-sdk-test", "no-bill");
	assert.ok(model, "the local faux model is registered");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});

	const bounded = async <T>(promise: Promise<T>): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SDK proof barrier timed out")), 12_000); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	let turn: Promise<void> | undefined;
	try {
		await session.bindExtensions({ uiContext: rpcUIContext(), mode: "rpc" });
		turn = session.prompt("Call intercom wait for the running worker.");
		void turn.catch(() => {});
		await bounded(waitToolExecuted.promise);
		assert.equal(ctxHasUI, true, "the real SDK tool_execution_end followed execution under native RPC bindings");
		assert.equal(tracker.peek(childId)?.status, "running", "wait returned while the child gate remains unresolved");
		assert.equal(waitForCalls, 0, "the production tool used the interactive snapshot path, not waitFor");
		assert.deepEqual(completionNotifier.peekPending(), []);

		await bounded(secondRequestEntered.promise);
		const steerPromise = session.steer("new direction", undefined, { source: "interactive" }).then(() => steeringAccepted.resolve());
		await bounded(steeringAccepted.promise);
		assert.equal(session.isIdle, false, "steering was admitted while the original model turn remained active");
		secondRequestGate.resolve();
		await bounded(turn);
		await steerPromise;
		assert.match(finalContextText, /new direction/, "the third native provider request received queued steering text");
		assert.match(finalContextText, /Background continues|intercom wait|worker/i, "provider context retained the native intercom wait result");
		assert.equal(tracker.peek(childId)?.status, "running", "steering did not cancel or settle the child");
		assert.equal(tracker.peek(childId)?.result, undefined);
		assert.equal(autoNotifications, 0, "no child completion was reported before its gate was released");
		assert.equal(session.isIdle, true, "the active turn completed normally; steering was not used as an early abort");
		assert.equal(requests, 2, "only the two continuation provider requests ran after the tool-call response");
		assert.equal(faux.state.callCount, 3, "all provider responses came from the local faux runtime");
		assert.deepEqual(session.getSteeringMessages(), []);

		workerGate.resolve({ agent: "worker", output: "worker finished", usage: emptyUsage(), ok: true });
		await bounded(new Promise<void>((resolve) => tracker.onComplete((run) => { if (run.id === childId) resolve(); })));
		assert.equal(tracker.peek(childId)?.status, "done");
		assert.equal(autoNotifications, 1, "completion notification queued exactly once after child settlement");
		assert.equal(completionNotifier.peekPending().filter((run) => run.id === childId).length, 1);
		const completionText = renderCompletion(completionNotifier.peekPending(), fenceUntrusted, () => undefined);
		assert.match(completionText, /Sub-agent output \(untrusted data\):[\s\S]*worker finished/, "the late automatic completion uses the production untrusted-output fence");
		const usage = tracker.peek(childId)?.result?.usage;
		assert.deepEqual(usage, emptyUsage(), "the worker result usage remained unchanged");
	} finally {
		workerGate.resolve({ agent: "worker", output: "cleanup release", usage: emptyUsage(), ok: true });
		secondRequestGate.resolve();
		await session.abort();
		await turn?.catch(() => {});
		completionNotifier.cancel();
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
// Characterization of the pinned Pi 1.0 host's extension/input ordering. Its internal loader is
// confined to this test; audit this path and its semantics when upgrading the development pins.
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("Pi 1.0 characterizes steering admitted after a delayed input hook and idle transition", { timeout: 15_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-persona-steer-order-"));
	const firstStream = deferred();
	const laterInputHook = deferred();
	const laterHookEntered = deferred();
	const queuedUserTexts: string[] = [];
	const faux = fauxProvider({ provider: "persona-steer-test", models: [{ id: "no-bill" }] });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("persona-steer-test", "fake-key-never-transmitted");
	faux.setResponses([
		async (_context) => {
			await firstStream.promise;
			return fauxAssistantMessage("first turn complete");
		},
		(context) => {
			queuedUserTexts.push(...context.messages.filter((message) => message.role === "user").map((message) =>
				typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join(""),
			));
			return fauxAssistantMessage("steer consumed");
		},
	]);

	const extensionRuntime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory((pi) => {
		pi.on("input", async (event) => {
			if (event.text === "steer now") return { action: "continue" };
			return { action: "continue" };
		});
		pi.on("input", async (event) => {
			if (event.text === "steer now") {
				laterHookEntered.resolve();
				await laterInputHook.promise;
			}
			return { action: "continue" };
		});
	}, cwd, createEventBus(), extensionRuntime, "<steer-order-test>");
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

	const model = runtime.getModel("persona-steer-test", "no-bill");
	assert.ok(model, "the local faux model is registered");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		noTools: "all",
	});

	try {
		await session.bindExtensions({ mode: "print" });
		const firstPrompt = session.prompt("start work");
		await new Promise<void>((resolve) => session.subscribe((event) => {
			if (event.type === "turn_start") resolve();
		}));
		const steering = session.steer("steer now", undefined, { source: "interactive" });
		await laterHookEntered.promise;

		// Let the host finish its active model turn while a later input hook is still awaiting.
		firstStream.resolve();
		await firstPrompt;
		assert.equal(session.isIdle, true, "the first turn completed before the later input hook");

		laterInputHook.resolve();
		await steering;
		await session.waitForIdle();
		// Known host limitation, not a passing fix: no extension preempts a join until Pi has a
		// supported post-admission ordering guarantee. The input is retained, but is dormant.
		assert.equal(queuedUserTexts.includes("steer now"), false);
		assert.deepEqual(session.getSteeringMessages(), ["steer now"]);
		assert.equal(session.isIdle, true);
		assert.equal(faux.state.callCount, 1, "steering admitted after idle does not start another model request");
	} finally {
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});

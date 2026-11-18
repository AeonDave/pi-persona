import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installSupervisorContinuity } from "../../src/extension/supervisor-continuity.ts";

test("native manual compaction exposes a fresh request-only checkpoint exactly through the first response", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-continuity-sdk-"));
	const requests: string[] = [];
	const faux = fauxProvider({ provider: "continuity-faux", models: [{ id: "local", contextWindow: 1000 }] });
	faux.setResponses(Array.from({ length: 4 }, () => (context) => {
		requests.push(JSON.stringify(context.messages));
		return fauxAssistantMessage("offline answer");
	}));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("continuity-faux", "synthetic-key-never-transmitted");
	const manager = SessionManager.inMemory(dir);
	for (let i = 0; i < 3; i++) {
		manager.appendMessage({ role: "user", content: `history ${i} ${"x ".repeat(200)}`, timestamp: 100 + i * 2 });
		manager.appendMessage(fauxAssistantMessage("previous answer"));
	}
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 16, keepRecentTokens: 1 } });
	let status: "running" | "queued" = "running";
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => {
			installSupervisorContinuity(pi, () => ({ runs: [{ id: "run-1", label: "scout", status }], asks: [] }));
			pi.on("session_before_compact", (event) => ({ compaction: { summary: "offline summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0]!, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [] });
	try {
		await session.bindExtensions({ mode: "rpc" });
		await session.compact();
		assert.equal(faux.state.callCount, 0, "compaction hook and checkpoint do not invoke a provider");
		status = "queued";
		await session.prompt("first request");
		assert.match(requests[0]!, /run-1 scout queued/);
		assert.doesNotMatch(JSON.stringify(manager.getEntries()), /Supervisor continuity/);
		await session.prompt("second request");
		assert.doesNotMatch(requests[1]!, /Supervisor continuity/);
	} finally {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

test("native automatic compaction inside a tool loop injects at the next request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-continuity-auto-"));
	const requests: string[] = [];
	let compactions = 0;
	let starts = 0;
	const faux = fauxProvider({ provider: "continuity-auto-faux", models: [{ id: "local", contextWindow: 2000 }] });
	faux.setResponses([
		(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxToolCall("large_output", {}, { id: "call-1" }), { stopReason: "toolUse" }); },
		(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("offline answer"); },
	]);
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("continuity-auto-faux", "synthetic-key-never-transmitted");
	const manager = SessionManager.inMemory(dir);
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => {
			installSupervisorContinuity(pi, () => ({ runs: [{ id: "run-2", status: "running" }], asks: [] }));
			pi.on("before_agent_start", () => { starts++; });
			pi.on("session_before_compact", (event) => { compactions++; return { compaction: { summary: "automatic summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }; });
			pi.registerTool({ name: "large_output", label: "Large output", description: "Generate synthetic data", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "large output ".repeat(2000) }], details: {} }) });
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0]!, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager });
	try {
		await session.bindExtensions({ mode: "rpc" });
		await session.prompt("Call large_output and answer.");
		assert.ok(compactions > 0, "the real host performed automatic compaction");
		assert.equal(starts, 1, "tool-loop continuation has no before_agent_start");
		assert.doesNotMatch(requests[0]!, /Supervisor continuity/);
		assert.match(requests[1]!, /run-2 running/);
	} finally {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});

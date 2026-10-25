import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_EVENT, COMPANION_EVENT, type CompanionPresence } from "../../src/core/companion.ts";
import { installActivityIngress, installCompanionPresence } from "../../src/extension/companion.ts";
import { AgentTree } from "../../src/ui/agent-tree.ts";

test("current native host scopes companion subscriptions to its loaded extension lifetime", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-companion-sdk-"));
	const events = createEventBus();
	const query = (): CompanionPresence | undefined => {
		let result: CompanionPresence | undefined;
		events.emit(COMPANION_EVENT, { version: 1, respond: (presence: CompanionPresence) => { result = presence; } });
		return result;
	};
	assert.equal(query(), undefined);
	const faux = fauxProvider({ provider: "companion-native-test", models: [{ id: "local" }] });
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	const manager = SessionManager.inMemory(dir);
	const tree = new AgentTree();
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, eventBus: events, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [(pi) => {
		installCompanionPresence(pi, "supervisor");
		const ingress = installActivityIngress(pi, tree);
		pi.on("session_start", (_event, ctx) => ingress.start(ctx));
		pi.on("session_shutdown", () => ingress.stop());
	}] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0]!, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: manager });
	try {
		assert.equal(query()?.capabilities.memory, 1, "factory presence is available before startup hook ordering matters");
		await session.bindExtensions({ mode: "rpc" });
		events.emit(ACTIVITY_EVENT, { version: 1, producerId: "pi-persona-mind", activityId: "actual-sdk", sessionId: manager.getSessionId(), phase: "inspect", state: "running", target: "project" });
		assert.equal(tree.snapshot()[0]?.label, "Mind");
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(tree.snapshot().length, 0);
	} finally {
		session.dispose();
		assert.equal(query(), undefined, "native dispose revokes the loaded extension subscription");
		assert.equal(faux.state.callCount, 0);
		await rm(dir, { recursive: true, force: true });
	}
});

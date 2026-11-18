import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installSessionContract, SESSION_CONTRACT_ENTRY } from "../../src/engine/session-contract.ts";

test("SDK persists the contract and rejects changed skill content before the resumed provider call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-worker-contract-sdk-"));
	const faux = fauxProvider({ provider: "worker-contract-faux", models: [{ id: "local" }] });
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("offline answer")));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("worker-contract-faux", "synthetic-key-never-transmitted");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let file = "";
	async function run(resume: boolean, section: string) {
		let guard!: ReturnType<typeof installSessionContract>;
		const manager = resume ? SessionManager.open(file) : SessionManager.create(dir, dir);
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [(pi) => {
				pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.skills = section; });
				guard = installSessionContract(pi, resume);
			}],
		});
		await loader.reload();
		const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.models[0]!, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: [] });
		try {
			await session.bindExtensions({ mode: "rpc" });
			await session.prompt("perform work");
			file = manager.getSessionFile()!;
			return { failure: guard.getFailure(), entries: manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SESSION_CONTRACT_ENTRY).length };
		} finally {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}
	try {
		const fresh = await run(false, "skill body one");
		assert.equal(fresh.failure, undefined);
		assert.equal(fresh.entries, 1);
		assert.equal(faux.state.callCount, 1);
		const same = await run(true, "skill body one");
		assert.equal(same.failure, undefined);
		assert.equal(same.entries, 1);
		assert.equal(faux.state.callCount, 2);
		const changed = await run(true, "skill body two");
		assert.match(changed.failure ?? "", /contract changed/);
		assert.equal(faux.state.callCount, 2, "contract mismatch was stopped before the provider");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

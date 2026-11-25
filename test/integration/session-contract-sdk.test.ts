import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installSessionContract, SESSION_CONTRACT_ENTRY } from "../../src/engine/session-contract.ts";
import { ConversationStore } from "../../src/conversations/store.ts";

test("SDK rejects changed skill content before inference and the lease preserves the prior transcript", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-worker-contract-sdk-"));
	const parent = join(dir, "supervisor.jsonl");
	await writeFile(parent, '{"type":"session","id":"owner"}\n');
	const entries: unknown[] = [];
	const store = new ConversationStore({ sessionId: "owner", sessionFile: parent, entries: () => entries,
		append: (customType, data) => entries.push({ type: "custom", customType, data }) });
	const faux = fauxProvider({ provider: "worker-contract-faux", models: [{ id: "local" }] });
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("offline answer")));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("worker-contract-faux", "synthetic-key-never-transmitted");
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	async function run(file: string, resume: boolean, section: string) {
		let guard!: ReturnType<typeof installSessionContract>;
		const manager = SessionManager.open(file, undefined, dir);
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
			return { failure: guard.getFailure(), rejectedAtStart: guard.wasResumeRejectedAtStart(),
				entries: manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SESSION_CONTRACT_ENTRY).length };
		} finally {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}
	try {
		const created = store.create();
		assert.ok(created.ok);
		const lease = created.value;
		const fresh = await run(lease.file, false, "skill body one");
		assert.equal(fresh.failure, undefined);
		assert.equal(fresh.entries, 1);
		assert.equal(faux.state.callCount, 1);
		const original = await readFile(lease.file);
		assert.ok(lease.commit({ rootRunId: "run-1", runId: "run-1", cwd: dir, persona: null,
			fingerprint: "a".repeat(64), spec: { agent: "scout", task: "perform work" }, model: "worker-contract-faux/local" }).ok);
		lease.release();
		const retry = store.acquire("run-1");
		assert.ok(retry.ok);
		const changed = await run(retry.value.lease.file, true, "skill body two");
		assert.match(changed.failure ?? "", /contract changed/);
		assert.equal(faux.state.callCount, 1, "contract mismatch was stopped before the provider");
		assert.equal(changed.rejectedAtStart, true);
		assert.ok(retry.value.lease.restoreRejectedResume());
		retry.value.lease.release();
		assert.deepEqual(await readFile(lease.file), original);
		const restored = store.acquire("run-1");
		assert.ok(restored.ok);
		const same = await run(restored.value.lease.file, true, "skill body one");
		assert.equal(same.failure, undefined);
		assert.equal(same.rejectedAtStart, false);
		assert.equal(same.entries, 1);
		assert.equal(faux.state.callCount, 2);
		restored.value.lease.release();
	} finally { await rm(dir, { recursive: true, force: true }); }
});

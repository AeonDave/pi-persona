import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";
import { makeEngine } from "../../src/engine/adapter.ts";
import { ConversationStore } from "../../src/conversations/store.ts";

test("real Pi in-process worker reopens its conversation without replaying old events or usage", { timeout: 20_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "persona-worker-sdk-"));
	const file = join(cwd, "worker.jsonl");
	const requests: string[] = [];
	let workerPrompt = "Test worker.";
	try {
		const faux = fauxProvider({ provider: "worker-faux", models: [{ id: "local" }] });
		faux.setResponses([
			(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("FIRST OBSERVATION"); },
			(context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("SECOND ANSWER"); },
		]);
		const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey("worker-faux", "synthetic-key");
		const engine = makeInProcessEngine({ cwd, agentDir: cwd, resolveAgent: () => ({ name: "a", source: "test", systemPrompt: workerPrompt }), modelRegistry: new ModelRegistry(runtime) });
		const base = { agent: "a", model: "worker-faux/local", tools: [] };
		const first = await engine.run({ ...base, task: "first task", session: { file, resume: false } });
		assert.equal(first.ok, true, first.error);
		assert.equal(first.sessionSaved, true);
		const second = await engine.run({ ...base, task: "follow up", session: { file, resume: true } });
		assert.equal(second.ok, true, second.error);
		assert.equal(second.sessionSaved, true);
		assert.equal(second.output, "SECOND ANSWER");
		assert.equal(second.usage.turns, 1);
		assert.match(requests[1]!, /FIRST OBSERVATION/);
		assert.match(requests[1]!, /follow up/);
		assert.equal(faux.state.callCount, 2);
		workerPrompt = "Changed worker.";
		const changed = await engine.run({ ...base, task: "follow up again", session: { file, resume: true } });
		assert.equal(changed.ok, false);
		assert.equal(changed.failureKind, "contract");
		assert.equal(changed.sessionSaved, false);
		assert.equal(changed.sessionQuiescent, true);
		assert.equal(changed.resumeRejectedAtStart, true);
		assert.equal(faux.state.callCount, 2, "changed worker prompt never reaches the provider");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("real child Pi reopens its saved conversation and emits only the new turn", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "persona-worker-child-sdk-"));
	try {
		// Pi migrates loose session JSONL files out of its agent directory at CLI startup.
		// Keep the transcript in its own directory, as the production conversation store does.
		const file = join(cwd, "worker-sessions", "worker.jsonl");
		await mkdir(dirname(file), { recursive: true });
		const receipt = join(cwd, "receipt.jsonl");
		const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
		const provider = fileURLToPath(new URL("../fixtures/selected-skills-provider.mjs", import.meta.url));
		await writeFile(receipt, "");
		await writeFile(join(cwd, "settings.json"), JSON.stringify({ extensions: [provider], retry: { enabled: false }, compaction: { enabled: false } }));
		const engine = makeEngine({ cwd, resolveAgent: (name) => ({ name, model: "skill-child-test/local", systemPrompt: "Test worker.", source: "test" }), childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: [cli, ...args] }), env: { PI_AGENT_DIR: cwd, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1", SELECTED_SKILLS_RECEIPT: receipt } } });
		const first = await engine.run({ agent: "a", task: "first task", tools: [], session: { file, resume: false } });
		assert.equal(first.ok, true, first.error);
		assert.equal(first.sessionSaved, true);
		const second = await engine.run({ agent: "a", task: "follow up", tools: [], session: { file, resume: true } });
		assert.equal(second.ok, true, second.error);
		assert.equal(second.sessionSaved, true);
		assert.equal(second.output, "selected-skills-child-ok");
		assert.equal(second.usage.turns, 1);
		const requests = (await readFile(receipt, "utf8")).trim().split("\n");
		assert.equal(requests.length, 2);
		assert.match(requests[1]!, /first task/);
		assert.match(requests[1]!, /selected-skills-child-ok/);
		assert.match(requests[1]!, /follow up/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("real child rejects changed selected skill before the resumed provider request", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "persona-worker-skills-"));
	try {
		const parent = join(cwd, "parent", "supervisor.jsonl");
		await mkdir(dirname(parent), { recursive: true });
		await writeFile(parent, '{"type":"session","id":"owner"}\n');
		const entries: unknown[] = [];
		const store = new ConversationStore({ sessionId: "owner", sessionFile: parent, entries: () => entries,
			append: (customType, data) => entries.push({ type: "custom", customType, data }) });
		const created = store.create();
		assert.ok(created.ok);
		const initial = created.value;
		const { file } = initial;
		const receipt = join(cwd, "receipt.jsonl");
		const skillDir = join(cwd, "skills", "audit");
		const skill = join(skillDir, "SKILL.md");
		const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
		const provider = fileURLToPath(new URL("../fixtures/selected-skills-provider.mjs", import.meta.url));
		await mkdir(skillDir, { recursive: true });
		const originalSkill = "---\nname: audit\ndescription: audit\n---\nORIGINAL BODY\n";
		await writeFile(skill, originalSkill);
		await writeFile(receipt, "");
		await writeFile(join(cwd, "settings.json"), JSON.stringify({ extensions: [provider], retry: { enabled: false }, compaction: { enabled: false } }));
		const engine = makeEngine({ cwd, resolveAgent: (name) => ({ name, model: "skill-child-test/local", systemPrompt: "Test worker.", source: "test" }), childOptions: { resolveInvocation: (args) => ({ command: process.execPath, args: [cli, ...args] }), env: { PI_AGENT_DIR: cwd, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1", SELECTED_SKILLS_RECEIPT: receipt } } });
		const spec = { agent: "a", task: "first", skills: ["audit"], tools: [] };
		const first = await engine.run({ ...spec, session: { file, resume: false, setExternalWriter: initial.setExternalWriter } });
		assert.equal(first.ok, true, first.error);
		assert.equal(first.sessionSaved, true);
		assert.ok(initial.commit({ rootRunId: "run-1", runId: "run-1", cwd, persona: null,
			fingerprint: "a".repeat(64), spec, model: "skill-child-test/local" }).ok);
		initial.release();
		const before = await readFile(receipt, "utf8");
		const original = await readFile(file);
		const acquired = store.acquire("run-1");
		assert.ok(acquired.ok);
		const resume = { file, resume: true, setExternalWriter: acquired.value.lease.setExternalWriter };
		await writeFile(skill, "---\nname: audit\ndescription: audit\n---\nCHANGED BODY\n");
		const second = await engine.run({ ...spec, task: "follow up", session: resume });
		assert.equal(second.ok, false);
		assert.equal(second.failureKind, "contract");
		assert.equal(second.sessionSaved, false);
		assert.equal(second.sessionQuiescent, true);
		assert.equal(second.resumeRejectedAtStart, true);
		assert.match(second.error ?? "", /contract changed/i);
		assert.equal(await readFile(receipt, "utf8"), before);
		assert.ok(acquired.value.lease.restoreRejectedResume());
		acquired.value.lease.release();
		assert.deepEqual(await readFile(file), original);
		await writeFile(skill, originalSkill);
		const retry = store.acquire("run-1");
		assert.ok(retry.ok);
		const third = await engine.run({ ...spec, task: "follow up", session: { ...resume, setExternalWriter: retry.value.lease.setExternalWriter } });
		assert.equal(third.ok, true, third.error);
		assert.equal(third.sessionSaved, true);
		retry.value.lease.release();
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, loadSkills, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeInProcessEngine } from "../../src/engine/inproc.ts";

const ALPHA_BODY = "ALPHA_SELECTED_INSTRUCTIONS_7f81";
const BETA_BODY = "BETA_UNSELECTED_PRIVATE_BODY_31b2";
const BETA_DESCRIPTION = "BETA_UNSELECTED_METADATA_98e3";
const PROVIDER = "persona-selected-skills-test";

type CapturedRequest = { system: string; skillSection: string; skillSections: number[]; toolNames: string[] };

function requestText(context: TranscriptContext): CapturedRequest {
	const systems = context.messages.filter((message) => message.role === "system");
	const system = systems.map((message) => {
		const content = message.content;
		const body = typeof content === "string" ? content : Array.isArray(content)
			? content.map((block) => block && typeof block === "object" && "text" in block ? String(block.text) : "").join("\n")
			: "";
		const sections = message.sections && typeof message.sections === "object" ? message.sections as Record<string, unknown> : {};
		return [body, ...Object.values(sections).map((value) => typeof value === "string" ? value : "")].join("\n");
	}).join("\n");
	const skillSection = systems.map((message) => {
		const sections = message.sections && typeof message.sections === "object" ? message.sections as Record<string, unknown> : {};
		return typeof sections.skills === "string" ? sections.skills : "";
	}).join("\n");
	const skillSections = systems.map((message) => {
		const sections = message.sections && typeof message.sections === "object" ? message.sections as Record<string, unknown> : {};
		return typeof sections.skills === "string" ? sections.skills.length : 0;
	});
	const toolNames = systems.flatMap((message) => Array.isArray(message.toolsAdded)
		? message.toolsAdded.flatMap((tool) => tool && typeof tool === "object" && "name" in tool ? [String(tool.name)] : [])
		: []);
	return { system, skillSection, skillSections, toolNames: [...new Set(toolNames)].sort() };
}

async function writeSkill(agentDir: string, name: string, description: string, body: string, disabled = false): Promise<void> {
	const dir = join(agentDir, "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}${disabled ? "\ndisable-model-invocation: true" : ""}\n---\n\n${body}\n`, "utf8");
}

async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-persona-selected-skills-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	// An explicit empty project skill-path list prevents this test from inheriting any host-configured
	// directories while the temporary agentDir's native default skill directory remains available.
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: [] }), "utf8");
	await writeSkill(agentDir, "alpha", "Alpha selected skill", ALPHA_BODY);
	await writeSkill(agentDir, "beta", BETA_DESCRIPTION, BETA_BODY);
	await writeSkill(agentDir, "locked", "Cannot be invoked by the model", "LOCKED_SKILL_BODY", true);
	for (let index = 0; index < 60; index += 1) {
		const id = String(index).padStart(2, "0");
		await writeSkill(agentDir, `catalog-${id}`, `Realistic skill metadata for topic ${id}, with brief guidance and tags`, `Catalog-only body ${id}.`);
	}
	const faux = fauxProvider({ provider: PROVIDER, models: [{ id: "offline" }] });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey(PROVIDER, "offline-test-key");
	return { root, agentDir, cwd, faux, runtime, model: `${PROVIDER}/offline` };
}

async function runCaptured(fixture: Awaited<ReturnType<typeof makeFixture>>, skills?: string[]) {
	const requests: CapturedRequest[] = [];
	fixture.faux.appendResponses([(context) => {
		requests.push(requestText(context));
		return fauxAssistantMessage("offline worker completed");
	}]);
	const engine = makeInProcessEngine({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		modelRegistry: new ModelRegistry(fixture.runtime),
		resolveAgent: (name) => ({ name, model: fixture.model, tools: ["read"], systemPrompt: "Return the supplied answer.", source: "<selected-skills-test>" }),
	});
	const result = await engine.run({ agent: `worker-${requests.length}`, task: "Finish the assigned work.", ...(skills ? { skills } : {}) });
	assert.equal(result.ok, true, result.error);
	assert.equal(requests.length, 1, "one faux provider request should capture the worker prompt");
	return requests[0]!;
}

test("in-process workers preload only selected skill bodies and preserve native grants", { timeout: 20_000 }, async (t) => {
	const fixture = await makeFixture();
	t.after(async () => rm(fixture.root, { recursive: true, force: true }));
	const baseline = await runCaptured(fixture);
	const selected = await runCaptured(fixture, ["alpha"]);
	const fixtureSkills = loadSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir, skillPaths: [], includeDefaults: true }).skills;
	const fixtureCatalogChars = formatSkillsForPrompt(fixtureSkills).length;
	assert.equal((selected.skillSection.match(new RegExp(ALPHA_BODY, "g")) ?? []).length, 1, "the selected body is loaded once");
	assert.doesNotMatch(selected.system, /BETA_UNSELECTED_(?:PRIVATE_BODY|METADATA)/, "unselected skill metadata and body stay out of the request");
	assert.deepEqual(selected.toolNames, baseline.toolNames, "skill selection does not grant tools");
	assert.equal(fixtureSkills.length, 63, "the measured catalog is exactly the isolated fixture (60 catalog entries + alpha + beta + locked)");
	assert.ok(fixtureCatalogChars > selected.skillSection.length, "on this 63-skill fixture, metadata for every skill exceeds one selected body");
	t.diagnostic(`isolated fixture native catalog: ${fixtureCatalogChars} chars / ${fixtureSkills.length} skills; selected body section: ${selected.skillSection.length} chars; delta: ${fixtureCatalogChars - selected.skillSection.length} chars`);
});

test("concurrent in-process workers keep selected skill bodies isolated", { timeout: 20_000 }, async (t) => {
	const fixture = await makeFixture();
	t.after(async () => rm(fixture.root, { recursive: true, force: true }));
	const captured: CapturedRequest[][] = [[], []];
	const captureWorker = (context: TranscriptContext) => {
		// SDK setup and skill I/O can reverse provider arrival order. Identify the request by
		// its assigned task, independently of the skill section whose isolation we assert.
		const userRequest = JSON.stringify(context.messages.filter((message) => message.role === "user"));
		const alpha = userRequest.includes("Do alpha work.");
		const beta = userRequest.includes("Do beta work.");
		assert.notEqual(alpha, beta, "each request identifies exactly one assigned worker task");
		captured[alpha ? 0 : 1]!.push(requestText(context));
		return fauxAssistantMessage(`${alpha ? "alpha" : "beta"} done`);
	};
	fixture.faux.setResponses([captureWorker, captureWorker]);
	const engine = makeInProcessEngine({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		modelRegistry: new ModelRegistry(fixture.runtime),
		resolveAgent: (name) => ({ name, model: fixture.model, tools: ["read"], systemPrompt: "Return the supplied answer.", source: "<selected-skills-test>" }),
	});
	const results = await Promise.all([
		engine.run({ agent: "beta-worker", task: "Do beta work.", skills: ["beta"] }),
		engine.run({ agent: "alpha-worker", task: "Do alpha work.", skills: ["alpha"] }),
	]);
	for (const result of results) assert.equal(result.ok, true, result.error);
	assert.equal(captured[0]!.length, 1);
	assert.equal(captured[1]!.length, 1);
	assert.match(captured[0]![0]!.system, new RegExp(ALPHA_BODY));
	assert.doesNotMatch(captured[0]![0]!.system, new RegExp(BETA_BODY));
	assert.match(captured[1]![0]!.system, new RegExp(BETA_BODY));
	assert.doesNotMatch(captured[1]![0]!.system, new RegExp(ALPHA_BODY));
	assert.deepEqual(captured[0]![0]!.toolNames, captured[1]![0]!.toolNames);
	t.diagnostic(`concurrent provider calls captured: ${fixture.faux.state.callCount}`);
});

test("missing or model-disabled in-process selected skills fail before provider use", { timeout: 20_000 }, async (t) => {
	const fixture = await makeFixture();
	t.after(async () => rm(fixture.root, { recursive: true, force: true }));
	for (const [name, pattern] of [["absent", /unavailable in this worker/], ["locked", /disabled for model invocation/]] as const) {
		const before = fixture.faux.state.callCount;
		const engine = makeInProcessEngine({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: new ModelRegistry(fixture.runtime),
			resolveAgent: (agent) => ({ name: agent, model: fixture.model, tools: [], systemPrompt: "No output needed.", source: "<selected-skills-test>" }),
		});
		const result = await engine.run({ agent: "invalid-worker", task: "Should not reach a provider.", skills: [name] });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "contract");
		assert.match(result.error ?? "", pattern);
		assert.equal(fixture.faux.state.callCount, before, "invalid skills do not make a provider request");
	}
});

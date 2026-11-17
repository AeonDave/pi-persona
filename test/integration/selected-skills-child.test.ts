import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeEngine } from "../../src/engine/adapter.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const provider = fileURLToPath(new URL("../fixtures/selected-skills-provider.mjs", import.meta.url));

async function createFixture(root: string, handler?: string) {
	for (const [name, description, body] of [
		["alpha-audit", "alpha uniquely", "ALPHA_BODY_MARKER"],
		["beta-audit", "beta uniquely", "BETA_BODY_MARKER"],
	] as const) {
		const skillDir = join(root, "skills", name);
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
	}
	const extensions = [provider];
	if (handler) {
		const override = join(root, "override.mjs");
		await writeFile(override, `export default function(pi) { pi.on("before_agent_start", ${handler}); }`);
		extensions.push(override);
	}
	const receipt = join(root, "receipt.jsonl");
	await writeFile(receipt, "");
	await writeFile(join(root, "settings.json"), JSON.stringify({ extensions, retry: { enabled: false }, compaction: { enabled: false } }));
	const engine = makeEngine({
		cwd: root,
		resolveAgent: (name) => ({ name, model: "skill-child-test/local", systemPrompt: "worker", source: "test" }),
		childOptions: {
			resolveInvocation: (args) => ({ command: process.execPath, args: [cli, ...args] }),
			env: { PI_AGENT_DIR: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", SELECTED_SKILLS_RECEIPT: receipt },
		},
	});
	return { engine, receipt };
}

test("real child Pi loader preloads exact skill and stops before provider for missing names", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-skills-child-"));
	try {
		const { engine, receipt } = await createFixture(root);
		const selected = await engine.run({ agent: "operator", task: "test", skills: ["alpha-audit"], tools: ["read"] });
		assert.equal(selected.ok, true, selected.error);
		const first = await readFile(receipt, "utf8");
		assert.match(first, /ALPHA_BODY_MARKER/);
		assert.doesNotMatch(first, /BETA_BODY_MARKER|beta uniquely|available_skills/);
		const missing = await engine.run({ agent: "operator", task: "test", skills: ["not-installed"], tools: ["read"] });
		assert.equal(missing.ok, false);
		assert.equal(missing.failureKind, "contract");
		assert.match(missing.error ?? "", /not-installed/);
		assert.equal(await readFile(receipt, "utf8"), first, "missing skill never reached faux provider");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const [label, handler, diagnostic] of [
	["opaque prompt override", '() => ({ systemPrompt: "OVERRIDE_WITHOUT_SELECTED_SKILL" })', /opaque system prompt override/],
	["skills section replacement", '(event) => { event.systemPromptOptions.sections = { skills: "REPLACED_SELECTED_SKILL" }; }', /selected skills section was replaced/i],
] as const) {
	test(`real child rejects a later ${label} before calling the provider`, { timeout: 30_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "persona-skills-child-override-"));
		try {
			const { engine, receipt } = await createFixture(root, handler);
			const result = await engine.run({ agent: "operator", task: "test", skills: ["alpha-audit"], tools: ["read"] });
			assert.equal(result.ok, false, "a late prompt override must not silently discard the selected skills");
			assert.equal(result.failureKind, "contract");
			assert.match(result.error ?? "", diagnostic);
			assert.equal(await readFile(receipt, "utf8"), "", "the rejected prompt never reached the faux provider");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

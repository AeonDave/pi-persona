import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { installSelectedSkills } from "../../../src/engine/skills.ts";

type PromptOptions = {
	skills: Skill[];
	sections: Record<string, string>;
	selectedTools?: string[];
	forceSystemPrompt?: string;
};
type Hook = (event: { systemPromptOptions: PromptOptions }, ctx: { abort(): void; signal?: AbortSignal }) => Promise<void>;
type StartHook = (event: object, ctx: { abort(): void }) => void;

function createHarness(names: string[], onFailure?: (message: string) => void) {
	let before!: Hook;
	let start!: StartHook;
	let aborts = 0;
	const pi = { on: (name: string, handler: unknown) => {
		if (name === "before_agent_start") before = handler as Hook;
		if (name === "agent_start") start = handler as StartHook;
	} } as unknown as ExtensionAPI;
	const controller = installSelectedSkills(pi, names, onFailure ? { onFailure } : {});
	const ctx = { abort() { aborts++; } };
	return {
		before: (options: PromptOptions) => before({ systemPromptOptions: options }, ctx),
		start: () => start({}, ctx),
		getAborts: () => aborts,
		getFailure: controller.getFailure,
	};
}

function skill(filePath: string, baseDir: string): Skill {
	return { name: "alpha", filePath, baseDir, description: "test" } as Skill;
}

test("selected skills reject opaque overrides on either side of their start handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-skill-override-"));
	try {
		const filePath = join(root, "SKILL.md");
		await writeFile(filePath, "---\nname: alpha\ndescription: test\n---\nALPHA_BODY\n");
		for (const overrideFirst of [false, true]) {
			const failures: string[] = [];
			const harness = createHarness(["alpha"], (message) => { failures.push(message); });
			const options: PromptOptions = { skills: [skill(filePath, root)], sections: {},
				...(overrideFirst ? { forceSystemPrompt: "opaque" } : {}),
			};
			await harness.before(options);
			options.forceSystemPrompt = "opaque";
			harness.start();
			assert.ok(harness.getAborts() > 0);
			assert.equal(failures.length, 1, "a failed preload is diagnosed once across both hooks");
			assert.match(harness.getFailure() ?? "", /opaque system prompt override/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selected skills accept a new sections object only when its prepared instructions survive", async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-skill-section-"));
	try {
		const filePath = join(root, "SKILL.md");
		await writeFile(filePath, "---\nname: alpha\ndescription: test\n---\nALPHA_BODY\n");
		for (const preserve of [false, true]) {
			const harness = createHarness(["alpha"]);
			const options: PromptOptions = { skills: [skill(filePath, root)], sections: {} };
			await harness.before(options);
			options.sections = { ...options.sections, ...(preserve ? {} : { skills: "replaced" }) };
			harness.start();
			assert.equal(harness.getAborts(), preserve ? 0 : 1);
			if (preserve) assert.equal(harness.getFailure(), undefined);
			else assert.match(harness.getFailure() ?? "", /selected skills section was replaced/i);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selected skills preload exact bodies once without deleting Pi's registry or changing tool grants", async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-selected-skills-"));
	try {
		const path = join(root, "SKILL.md");
		await writeFile(path, "---\nname: alpha\ndescription: test\n---\nBODY alpha\n");
		const harness = createHarness(["alpha", "alpha"]);
		const skills = [skill(path, root), { ...skill(join(root, "beta"), root), name: "beta", description: "other" }];
		const options: PromptOptions = { skills, sections: { other: "preserved" }, selectedTools: ["read"] };
		await harness.before(options);
		harness.start();
		assert.equal(harness.getAborts(), 0);
		assert.equal(harness.getFailure(), undefined);
		assert.equal(options.skills, skills);
		assert.deepEqual(options.selectedTools, ["read"]);
		assert.equal(options.sections.skills?.match(/BODY alpha/g)?.length, 1);
		assert.match(options.sections.skills!, /alpha/);
		await writeFile(path, "CHANGED");
		const next: PromptOptions = { skills, sections: {}, selectedTools: ["read"] };
		await harness.before(next);
		harness.start();
		assert.match(next.sections.skills!, /BODY alpha/);
		assert.doesNotMatch(next.sections.skills!, /CHANGED/);
		assert.equal(harness.getAborts(), 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing and disabled selected skills invoke abort with exact diagnostics", async () => {
	for (const skills of [[], [{ ...skill("unused", "unused"), disableModelInvocation: true }]]) {
		let failure = "";
		const harness = createHarness(["alpha"], (message) => { failure = message; });
		await harness.before({ skills, sections: {}, selectedTools: [] });
		assert.equal(harness.getAborts(), 1);
		assert.match(failure, /alpha/);
		assert.equal(harness.getFailure(), failure);
	}
});

test("a throwing failure observer cannot prevent cancellation", async () => {
	const harness = createHarness(["missing"], () => { throw new Error("observer failed"); });
	await assert.rejects(harness.before({ skills: [], sections: {} }), /observer failed/);
	assert.equal(harness.getAborts(), 1);
});

test("selected skill size, type and UTF-8 failures abort with named diagnostics", async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-skill-limits-"));
	try {
		const bad = join(root, "bad.md");
		for (const [content, expected] of [[Buffer.alloc(65537), /64 KiB/], [Buffer.from([0xff]), /UTF-8/]] as const) {
			await writeFile(bad, content);
			const harness = createHarness(["alpha"]);
			await harness.before({ skills: [skill(bad, root)], sections: {} });
			assert.equal(harness.getAborts(), 1);
			assert.match(harness.getFailure() ?? "", expected);
			assert.match(harness.getFailure() ?? "", /alpha/);
		}
		const harness = createHarness(["directory"]);
		await harness.before({ skills: [{ ...skill(root, root), name: "directory" }], sections: {} });
		assert.equal(harness.getAborts(), 1);
		assert.match(harness.getFailure() ?? "", /directory/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selection rechecks current skill frontmatter before loading it", async () => {
	const root = await mkdtemp(join(tmpdir(), "persona-skill-stale-"));
	try {
		const path = join(root, "SKILL.md");
		for (const [frontmatter, diagnostic] of [
			["name: alpha\ndescription: test\ndisable-model-invocation: true", /disabled/],
			["name: changed\ndescription: test", /name.*changed/i],
		] as const) {
			await writeFile(path, `---\n${frontmatter}\n---\nBODY\n`);
			const harness = createHarness(["alpha"]);
			await harness.before({ skills: [skill(path, root)], sections: {} });
			assert.equal(harness.getAborts(), 1);
			assert.match(harness.getFailure() ?? "", diagnostic);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

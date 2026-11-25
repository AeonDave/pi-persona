import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSessionContract } from "../../../src/engine/session-contract.ts";

function harness(resume: boolean, entries: Array<{ type: string; customType: string; data: unknown }> = []) {
	const handlers = new Map<string, (...args: any[]) => void>();
	let active = ["read"];
	let schema = { type: "object", properties: { path: { type: "string" } } };
	let catalog = [{ name: "audit", description: "audit sources", filePath: "/skills/audit/SKILL.md", baseDir: "/skills/audit", disableModelInvocation: false }];
	let aborted = 0;
	const pi = {
		on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
		getActiveTools: () => active,
		getAllTools: () => [{ name: "read", description: "read a file", parameters: schema, exposure: "direct" }],
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const guard = installSessionContract(pi, resume);
	const ctx = { abort: () => aborted++, sessionManager: { getBranch: () => entries } };
	return {
		guard, entries, get aborted() { return aborted; },
		setActive(value: string[]) { active = value; },
		setSchema(value: typeof schema) { schema = value; },
		setCatalog(value: typeof catalog) { catalog = value; },
		run(skills = "selected skill body", appendSystemPrompt = "") {
			const options = { cwd: "/work", sections: { skills }, skills: catalog, selectedTools: ["read"], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt, contextFiles: [] };
			handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
			handlers.get("agent_start")!({}, ctx);
		},
	};
}

test("fresh session records one contract, identical continuation accepts it", () => {
	const first = harness(false);
	first.run();
	first.run();
	assert.equal(first.entries.length, 1);
	assert.equal(first.aborted, 0);
	const next = harness(true, first.entries.slice());
	next.run();
	assert.equal(next.aborted, 0);
	assert.equal(next.guard.getFailure(), undefined);
});

test("changed selected skill body, tool grants or schema abort resume", () => {
	const first = harness(false);
	first.run();
	for (const [change, component] of Object.entries({
		skill: "selected skill instructions", catalog: "skill catalog", grant: "tool selection", schema: "tool definitions",
	})) {
		const next = harness(true, first.entries.slice());
		if (change === "grant") next.setActive([]);
		if (change === "schema") next.setSchema({ type: "object", properties: { path: { type: "number" } } });
		if (change === "catalog") next.setCatalog([{ name: "audit", description: "changed", filePath: "/skills/audit/SKILL.md", baseDir: "/skills/audit", disableModelInvocation: false }]);
		next.run(change === "skill" ? "changed body" : undefined);
		assert.equal(next.aborted, 1, change);
		assert.equal(next.guard.getFailure(), `Worker session contract changed: ${component}`);
	}
	assert.doesNotMatch(JSON.stringify(first.entries[0]!.data), /selected skill body|audit sources|read a file/);
});

test("a saved digest without component details still enforces the same contract", () => {
	const fresh = harness(false);
	fresh.run();
	const entry = fresh.entries[0]!;
	// Recorded from the original v1 projection of this fixture.
	const original = { ...entry, data: { version: 1, sha256: "fb981b6f3682e70f8e3a84eec871a98c5cfebdc9833f5c628290e5363144fade" } };
	const identical = harness(true, [original]);
	identical.run();
	assert.equal(identical.aborted, 0);
	const changed = harness(true, [original]);
	changed.setActive([]);
	changed.run();
	assert.equal(changed.aborted, 1);
	assert.match(changed.guard.getFailure() ?? "", /contract changed/);
});

test("a rejection names every changed group without exposing either prompt", () => {
	const fresh = harness(false);
	fresh.run();
	const next = harness(true, fresh.entries.slice());
	next.setActive([]);
	next.run("private skill body", "private prompt");
	assert.equal(next.aborted, 1);
	assert.equal(next.guard.getFailure(), "Worker session contract changed: tool selection, selected skill instructions, prompt configuration");
});

test("resume without a valid prior contract fails closed", () => {
	const next = harness(true);
	next.run();
	assert.equal(next.aborted, 1);
	assert.match(next.guard.getFailure() ?? "", /missing/i);
});

test("a resume that already started cannot attest to rejection at initial startup", () => {
	const first = harness(false);
	first.run();
	const resumed = harness(true, first.entries.slice());
	resumed.run();
	resumed.run("changed body");
	assert.equal(resumed.aborted, 1);
	assert.match(resumed.guard.getFailure() ?? "", /contract changed/i);
	assert.equal(resumed.guard.wasResumeRejectedAtStart(), false);
});

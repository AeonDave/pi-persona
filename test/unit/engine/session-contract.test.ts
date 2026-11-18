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
		run(skills = "selected skill body") {
			const options = { cwd: "/work", sections: { skills }, skills: catalog, selectedTools: ["read"], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] };
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
	for (const change of ["skill", "catalog", "grant", "schema"] as const) {
		const next = harness(true, first.entries.slice());
		if (change === "grant") next.setActive([]);
		if (change === "schema") next.setSchema({ type: "object", properties: { path: { type: "number" } } });
		if (change === "catalog") next.setCatalog([{ name: "audit", description: "changed", filePath: "/skills/audit/SKILL.md", baseDir: "/skills/audit", disableModelInvocation: false }]);
		next.run(change === "skill" ? "changed body" : undefined);
		assert.equal(next.aborted, 1, change);
		assert.match(next.guard.getFailure() ?? "", /changed/i);
	}
});

test("resume without a valid prior contract fails closed", () => {
	const next = harness(true);
	next.run();
	assert.equal(next.aborted, 1);
	assert.match(next.guard.getFailure() ?? "", /missing/i);
});

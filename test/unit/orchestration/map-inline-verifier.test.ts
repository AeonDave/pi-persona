import assert from "node:assert/strict";
import { test } from "node:test";
import { map } from "../../../src/orchestration/strategies/map.ts";
import { makeSDK, type AgentRunSpec } from "../../../src/orchestration/sdk.ts";
import { makeRoster } from "../../../src/orchestration/roster.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

function harness() {
	const calls: AgentRunSpec[] = [];
	const sdk = makeSDK({
		roster: makeRoster({ work: ["splitter", "worker"] }),
		limits: { maxChildren: 4, maxConcurrency: 1, budgetTokens: 0, timeoutMs: 1000 },
		engine: { run: async (spec) => {
			calls.push(spec);
			return { agent: spec.agent, ok: true, output: spec.agent === "splitter" ? '["unit"]' : "checked", usage: emptyUsage(),
				...(spec.agent === "checker" ? { structured: { stance: "approve" } } : {}) };
		} },
	});
	return { sdk, calls };
}

test("map runs an inline verification actor with its declared role/model rather than silently skipping it", async () => {
	const { sdk, calls } = harness();
	await map.run({ task: "check", roster: "work", params: { verify: { agent: "checker", role: "TESTS review", model: "fixture/checker", skills: ["testing-reliability"] } } }, sdk);
	assert.equal(calls.length, 3);
	assert.equal(calls[2]?.agent, "checker");
	assert.equal(calls[2]?.role, "TESTS review");
	assert.equal(calls[2]?.model, "fixture/checker");
	assert.deepEqual(calls[2]?.skills, ["testing-reliability"]);
	assert.equal(calls[2]?.outputContract, "default");
});

test("map refuses a malformed verification actor before spending a splitter/worker request", async () => {
	const { sdk, calls } = harness();
	await assert.rejects(map.run({ task: "check", roster: "work", params: { verify: { agent: "checker", tools: ["read", 42] } } }, sdk), /verify.*tools|tools.*verify/i);
	assert.equal(calls.length, 0);
});

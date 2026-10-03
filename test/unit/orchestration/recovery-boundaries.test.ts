import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSDK, type AgentRunSpec, type SDKDeps } from "../../../src/orchestration/sdk.ts";
import type { AgentResult, FailureKind } from "../../../src/orchestration/types.ts";

const failure = (model: string, kind: FailureKind, error: string): AgentResult => ({
	agent: "reviewer", output: "", ok: false, modelUsed: model, failureKind: kind, error,
	usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
});

function harness(overrides: Partial<SDKDeps> = {}, secondKind: FailureKind = "provider") {
	const calls: AgentRunSpec[] = [];
	const sdk = makeSDK({
		roster: { team: () => [] },
		limits: { maxChildren: 4, maxConcurrency: 1, budgetTokens: 0, timeoutMs: 1000 },
		sessionModel: "fixture/main",
		engine: { run: async (spec) => {
			calls.push(spec);
			return calls.length === 1
				? failure("fixture/configured", "provider", "configured model unavailable")
				: failure("fixture/main", secondKind, "main attempt failed");
		} },
		...overrides,
	});
	return { sdk, calls };
}

test("a local stop at the initial SDK start prevents even the first engine invocation", async () => {
	const { sdk, calls } = harness({ onAgentStart: (_agent, stop) => stop() });
	const result = await sdk.agent({ agent: "reviewer", task: "check", model: "fixture/configured" });
	assert.equal(calls.length, 0);
	assert.equal(result.failureKind, "abort");
});

test("a local stop from the recovery notification cannot be lost by replacing the attempt controller", async () => {
	let stop: (() => void) | undefined;
	const { sdk, calls } = harness({
		onAgentStart: (_agent, abort) => { stop = abort; },
		onModelFallback: () => stop?.(),
	});
	await sdk.agent({ agent: "reviewer", task: "check", model: "fixture/configured" });
	assert.equal(calls.length, 1, "the notification's cancellation must prevent the retry");
});

test("a failed main attempt retains its terminal cause, actual model, and both error diagnostics", async () => {
	const { sdk, calls } = harness({}, "timeout");
	const result = await sdk.agent({ agent: "reviewer", task: "check", model: "fixture/configured" });
	assert.equal(calls.length, 2);
	assert.equal(result.failureKind, "timeout");
	assert.equal(result.modelUsed, "fixture/main");
	assert.match(result.error ?? "", /configured model unavailable/);
	assert.match(result.error ?? "", /main attempt failed/);
	assert.equal(result.usage.input, 6);
	assert.deepEqual(result.modelRecovery, { from: "fixture/configured", to: "fixture/main" });
});

test("an authoritative live getter with no main model does not resurrect a stale snapshot", async () => {
	const { sdk, calls } = harness({ getSessionModel: () => undefined, sessionModel: "fixture/stale-main" });
	await sdk.agent({ agent: "reviewer", task: "check", model: "fixture/configured" });
	assert.equal(calls.length, 1);
	assert.equal(sdk.sessionModel, undefined);
});

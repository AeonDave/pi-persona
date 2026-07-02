import { test } from "node:test";
import assert from "node:assert/strict";

import { withModelFallback } from "../../../src/engine/fallback.ts";
import type { ModelLite } from "../../../src/core/models.ts";
import type { AgentRunSpec, StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult, FailureKind } from "../../../src/orchestration/types.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

const MODELS: ModelLite[] = [
	{ provider: "anthropic", id: "m" },
	{ provider: "amazon-bedrock", id: "m" },
	{ provider: "copilot", id: "m" },
];

/** A scripted engine: returns the next queued result per call, recording the model each ran on. */
function stubEngine(results: Array<Partial<AgentResult>>): { engine: StrategyEngine; calls: string[] } {
	const calls: string[] = [];
	let i = 0;
	const engine: StrategyEngine = {
		async run(spec: AgentRunSpec): Promise<AgentResult> {
			calls.push(spec.model ?? "(default)");
			const scripted = results[Math.min(i, results.length - 1)] ?? {};
			i += 1;
			const r: AgentResult = { agent: spec.agent, output: scripted.output ?? "", usage: emptyUsage(), ok: scripted.ok ?? true };
			const mu = scripted.modelUsed ?? spec.model; // default: report the model actually attempted
			if (mu) r.modelUsed = mu;
			if (scripted.failureKind) r.failureKind = scripted.failureKind;
			if (scripted.error) r.error = scripted.error;
			return r;
		},
	};
	return { engine, calls };
}

// A provider failure that leaves modelUsed to the stub's base (= the model actually attempted),
// so each reroute reports the model it really ran on.
const provider = (): Partial<AgentResult> => ({ ok: false, failureKind: "provider" as FailureKind, error: "boom" });

test("a provider failure reroutes to the same id under another provider and succeeds", async () => {
	const { engine, calls } = stubEngine([provider(), { ok: true, modelUsed: "amazon-bedrock/m", output: "done" }]);
	const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic" });
	const r = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.equal(r.ok, true);
	assert.equal(r.modelUsed, "amazon-bedrock/m");
	assert.equal(calls.length, 2, "one reroute");
	assert.equal(calls[1], "amazon-bedrock/m", "retried on the alternate provider");
});

test("a NON-provider failure (agent/contract/abort/timeout) is never retried", async () => {
	for (const kind of ["agent", "contract", "abort", "timeout", "unknown-model"] as FailureKind[]) {
		const { engine, calls } = stubEngine([{ ok: false, failureKind: kind, modelUsed: "anthropic/m", error: kind }]);
		const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic" });
		const r = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
		assert.equal(r.ok, false);
		assert.equal(calls.length, 1, `${kind} must not reroute`);
	}
});

test("aggressive: it walks the WHOLE chain, then returns the last provider failure", async () => {
	// every attempt fails at the provider → try anthropic, bedrock, copilot, then give up.
	const { engine, calls } = stubEngine([provider()]); // stub echoes spec.model into modelUsed for the rest
	const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic" });
	const r = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "provider");
	assert.deepEqual(calls, ["anthropic/m", "amazon-bedrock/m", "copilot/m"], "each provider tried exactly once");
});

test("an already-aborted signal stops the chain after the first attempt", async () => {
	const { engine, calls } = stubEngine([provider()]);
	const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic" });
	const ac = new AbortController();
	ac.abort();
	const r = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" }, undefined, ac.signal);
	assert.equal(r.ok, false);
	assert.equal(calls.length, 1, "no reroute once aborted");
});

test("onFallback is notified for each reroute (transparency breadcrumb)", async () => {
	const { engine } = stubEngine([provider()]);
	const seen: Array<{ from: string; to: string }> = [];
	const wrapped = withModelFallback(engine, {
		models: MODELS,
		preferProvider: "anthropic",
		onFallback: ({ from, to }) => seen.push({ from, to }),
	});
	await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.deepEqual(seen, [
		{ from: "anthropic/m", to: "amazon-bedrock/m" },
		{ from: "amazon-bedrock/m", to: "copilot/m" },
	]);
});

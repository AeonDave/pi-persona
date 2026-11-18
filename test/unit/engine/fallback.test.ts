import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../../src/conversations/store.ts";

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
			const r: AgentResult = { agent: spec.agent, output: scripted.output ?? "", usage: scripted.usage ?? emptyUsage(), ok: scripted.ok ?? true };
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

test("provider fallback preserves retained work and does not rerun a pinned opt-in leg", async () => {
	const worktreeRecovery = { path: "/retained", baseCommit: "abc", reason: "export failed", availability: "retained" as const };
	let calls = 0;
	const engine: StrategyEngine = { async run() { calls++; return { agent: "x", output: "partial", usage: emptyUsage(), ok: false, failureKind: "provider", modelUsed: "anthropic/m", worktreeRecovery }; } };
	const result = await withModelFallback(engine, { models: MODELS, allowCrossProviderFallback: true }).run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.equal(calls, 1);
	assert.equal(result.failureKind, "provider");
	assert.deepEqual(result.worktreeRecovery, worktreeRecovery);
});

test("a provider failure reroutes to the same id under another provider and succeeds", async () => {
	const { engine, calls } = stubEngine([provider(), { ok: true, modelUsed: "amazon-bedrock/m", output: "done" }]);
	const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic", allowCrossProviderFallback: true });
	const r = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.equal(r.ok, true);
	assert.equal(r.modelUsed, "amazon-bedrock/m");
	assert.equal(calls.length, 2, "one reroute");
	assert.equal(calls[1], "amazon-bedrock/m", "retried on the alternate provider");
});

test("provider fallback accounts for every attempted route and preserves the final result metadata", async () => {
	for (const succeeds of [true, false]) {
		const attempts: AgentResult[] = [
			{ agent: "x", output: "first partial", ok: false, failureKind: "provider", modelUsed: "anthropic/m", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.125, contextTokens: 100, turns: 1 } },
			{ agent: "x", output: "second partial", ok: false, failureKind: "provider", modelUsed: "amazon-bedrock/m", usage: { input: 20, output: 4, cacheRead: 6, cacheWrite: 8, cost: 0.25, contextTokens: 200, turns: 2 } },
			{ agent: "x", output: "final answer", ok: succeeds, ...(!succeeds ? { failureKind: "provider" as const, error: "final provider failed" } : {}), modelUsed: "copilot/m", thinkingRequested: "high", thinkingEffective: "medium", structured: { answer: "final" }, sessionSaved: succeeds, sessionQuiescent: true, usage: { input: 30, output: 6, cacheRead: 9, cacheWrite: 12, cost: 0.5, contextTokens: 300, turns: 3 } },
		];
		const originals = structuredClone(attempts);
		let calls = 0;
		const engine: StrategyEngine = { async run() { return attempts[calls++]!; } };
		const result = await withModelFallback(engine, { models: MODELS, allowCrossProviderFallback: true }).run({ agent: "x", task: "t", model: "anthropic/m" });
		assert.equal(calls, 3);
		assert.deepEqual(result, { ...attempts[2], usage: { input: 60, output: 12, cacheRead: 18, cacheWrite: 24, cost: 0.875, contextTokens: 300, turns: 6 } });
		assert.deepEqual(attempts, originals, "accounting must not mutate engine-owned attempt results");
	}
});

test("a NON-provider failure (agent/contract/abort/timeout) is never retried", async () => {
	for (const kind of ["agent", "contract", "abort", "timeout", "unknown-model"] as FailureKind[]) {
		const { engine, calls } = stubEngine([{ ok: false, failureKind: kind, modelUsed: "anthropic/m", error: kind }]);
		const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic" });
		const r = await wrapped.run({ agent: "x", task: "t", model: "m" });
		assert.equal(r.ok, false);
		assert.equal(calls.length, 1, `${kind} must not reroute`);
	}
});

test("aggressive: it walks the WHOLE chain, then returns the last provider failure", async () => {
	// every attempt fails at the provider → try anthropic, bedrock, copilot, then give up.
	const { engine, calls } = stubEngine([provider()]); // stub echoes spec.model into modelUsed for the rest
	const wrapped = withModelFallback(engine, { models: MODELS, preferProvider: "anthropic", allowCrossProviderFallback: true });
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
		allowCrossProviderFallback: true,
		onFallback: ({ from, to }) => seen.push({ from, to }),
	});
	await wrapped.run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.deepEqual(seen, [
		{ from: "anthropic/m", to: "amazon-bedrock/m" },
		{ from: "amazon-bedrock/m", to: "copilot/m" },
	]);
});

test("a throwing fallback notification cannot discard billed attempts or prevent recovery", async () => {
	const { engine, calls } = stubEngine([
		{ ...provider(), usage: { ...emptyUsage(), input: 10, output: 2, cost: 0.125, turns: 1 } },
		{ ok: true, output: "recovered", usage: { ...emptyUsage(), input: 20, output: 4, cost: 0.25, contextTokens: 200, turns: 1 } },
	]);
	const result = await withModelFallback(engine, {
		models: MODELS, allowCrossProviderFallback: true,
		onFallback: () => { throw new Error("toast failed"); },
	}).run({ agent: "x", task: "t", model: "anthropic/m" });
	assert.deepEqual(calls, ["anthropic/m", "amazon-bedrock/m"]);
	assert.equal(result.ok, true);
	assert.equal(result.output, "recovered");
	assert.equal(result.modelUsed, "amazon-bedrock/m");
	assert.deepEqual(result.usage, { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.375, contextTokens: 200, turns: 2 });
});

test("provider fallback does not route a paid OpenAI model through OpenCode", async () => {
	const models: ModelLite[] = [
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
		{ provider: "opencode", id: "gpt-5.6-luna" },
		{ provider: "openrouter", id: "gpt-5.6-luna" },
	];
	const { engine, calls } = stubEngine([provider(), { ok: true, modelUsed: "opencode/gpt-5.6-luna" }]);
	const wrapped = withModelFallback(engine, { models });
	const r = await wrapped.run({ agent: "x", task: "t", model: "openai-codex/gpt-5.6-luna" });
	assert.equal(r.ok, false, "the forbidden fallback must not be attempted");
	assert.deepEqual(calls, ["openai-codex/gpt-5.6-luna"]);
});

test("a provider-qualified model can opt into cross-provider recovery", async () => {
	const models: ModelLite[] = [
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
		{ provider: "openai", id: "gpt-5.6-luna" },
	];
	const { engine, calls } = stubEngine([provider(), { ok: true, modelUsed: "openai/gpt-5.6-luna" }]);
	const wrapped = withModelFallback(engine, { models, allowCrossProviderFallback: true });
	const r = await wrapped.run({ agent: "x", task: "t", model: "openai-codex/gpt-5.6-luna" });
	assert.equal(r.ok, true);
	assert.deepEqual(calls, ["openai-codex/gpt-5.6-luna", "openai/gpt-5.6-luna"]);
});

test("fresh quiescent worker can retry after deleting only its failed transcript; resumed workers stay pinned", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-fallback-session-"));
	try {
		const store = new ConversationStore({ sessionId: "test", sessionFile: join(dir, "parent"), entries: () => [], append: () => {} });
		const created = store.create(); assert.ok(created.ok);
		const file = created.value.file;
		let calls = 0;
		const engine: StrategyEngine = { async run(spec) {
			calls++;
			if (calls === 1) { writeFileSync(file, "failed attempt"); return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, failureKind: "provider", modelUsed: "anthropic/m", sessionQuiescent: true }; }
			assert.equal(existsSync(file), false, "retry must not reuse the failed transcript");
			return { agent: spec.agent, output: "ok", usage: emptyUsage(), ok: true, modelUsed: spec.model! };
		} };
		const wrapped = withModelFallback(engine, { models: MODELS, allowCrossProviderFallback: true });
		const result = await wrapped.run({ agent: "x", task: "t", model: "anthropic/m", session: { file, resume: false } });
		assert.equal(result.modelUsed, "amazon-bedrock/m"); assert.equal(calls, 2);
		calls = 0;
		await wrapped.run({ agent: "x", task: "t", model: "anthropic/m", session: { file, resume: true } });
		assert.equal(calls, 1);
		created.value.release();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh worker with an uncertain writer does not retry", async () => {
	let calls = 0;
	const engine: StrategyEngine = { async run() { calls++; return { agent: "x", output: "", usage: emptyUsage(), ok: false, failureKind: "provider", modelUsed: "anthropic/m", sessionQuiescent: false }; } };
	await withModelFallback(engine, { models: MODELS, allowCrossProviderFallback: true }).run({ agent: "x", task: "t", model: "anthropic/m", session: { file: "C:/invalid", resume: false } });
	assert.equal(calls, 1);
});

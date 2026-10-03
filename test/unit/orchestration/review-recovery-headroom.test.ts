import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyUsage } from "../../../src/engine/stream.ts";
import { makeRoster, type RosterMember } from "../../../src/orchestration/roster.ts";
import { makeSDK, type AgentRunSpec, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { councilRounds } from "../../../src/orchestration/strategies/council-rounds.ts";
import { criticLoop } from "../../../src/orchestration/strategies/critic-loop.ts";
import { map } from "../../../src/orchestration/strategies/map.ts";
import { pipeline } from "../../../src/orchestration/strategies/pipeline.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const MAIN_MODEL = "fixture/main";
const BROKEN_MODEL = "fixture/broken";

function usage(input = 0, output = 0) {
	return { ...emptyUsage(), input, output };
}

function success(agent: string, output: string, inputTokens = 0, structured?: Record<string, unknown>): AgentResult {
	return {
		agent,
		output,
		usage: usage(inputTokens),
		ok: true,
		...(structured ? { structured } : {}),
	};
}

function providerFailure(agent: string, model: string): AgentResult {
	return {
		agent,
		output: "",
		usage: usage(10),
		ok: false,
		failureKind: "provider",
		modelUsed: model,
		error: "synthetic provider outage",
	};
}

function sdkFor(
	engine: StrategyEngine,
	members: RosterMember[],
	maxChildren: number,
	maxConcurrency = 1,
	logs: string[] = [],
) {
	return makeSDK({
		engine,
		roster: makeRoster({ review: members }),
		sessionModel: MAIN_MODEL,
		limits: { maxChildren, maxConcurrency, budgetTokens: 0, timeoutMs: 1_000 },
		log: (message) => logs.push(message),
	});
}

test("map splitter recovery leaves its full worker and verifier waves admitted", async () => {
	const calls: Array<{ agent: string; model?: string }> = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			calls.push({ agent: spec.agent, ...(spec.model ? { model: spec.model } : {}) });
			if (spec.agent === "splitter" && spec.model === BROKEN_MODEL) return providerFailure(spec.agent, BROKEN_MODEL);
			if (spec.agent === "splitter") return success(spec.agent, '["one", "two"]', 1);
			if (spec.agent === "worker") return success(spec.agent, "worked", 1);
			return success(spec.agent, "approved", 1, { stance: "approve" });
		},
	};
	const sdk = sdkFor(engine, [{ agent: "splitter", model: BROKEN_MODEL }, "worker"], 6, 2);

	const result = await map.run({ task: "split and implement", roster: "review", params: { verify: "verifier", maxItems: 2 } }, sdk);

	assert.equal(result.ok, true, result.error);
	assert.equal(calls.length, 6, "splitter retry, two workers, and two verifiers all fit the six-child budget");
	assert.deepEqual(calls.map((call) => call.agent), ["splitter", "splitter", "worker", "worker", "verifier", "verifier"]);
});

test("map worker recovery cannot consume the mandatory verifier slots", async () => {
	const calls: Array<{ agent: string; model?: string }> = [];
	const logs: string[] = [];
	let brokenWorkers = 0;
	let releaseBrokenWorkers!: () => void;
	const brokenWorkerBarrier = new Promise<void>((resolve) => {
		releaseBrokenWorkers = resolve;
	});
	let activeWorkers = 0;
	let maxActiveWorkers = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			calls.push({ agent: spec.agent, ...(spec.model ? { model: spec.model } : {}) });
			if (spec.agent === "splitter") return success(spec.agent, '["one", "two"]', 1);
			if (spec.agent === "worker") {
				activeWorkers++;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				if (spec.model === BROKEN_MODEL) {
					brokenWorkers++;
					if (brokenWorkers === 2) releaseBrokenWorkers();
					await brokenWorkerBarrier;
					activeWorkers--;
					return providerFailure(spec.agent, BROKEN_MODEL);
				}
				activeWorkers--;
				return success(spec.agent, "worked", 20);
			}
			return success(spec.agent, "approved", 3, { stance: "approve" });
		},
	};
	const sdk = sdkFor(engine, ["splitter", { agent: "worker", model: BROKEN_MODEL }], 6, 2, logs);

	const result = await map.run({ task: "split and implement", roster: "review", params: { verify: "verifier", maxItems: 2 } }, sdk);

	assert.equal(calls.filter((call) => call.agent === "worker" && call.model === MAIN_MODEL).length, 1, "only the recovery that fits beside all possible verifiers is admitted");
	assert.equal(calls.filter((call) => call.agent === "verifier").length, 1, "the recovered worker still receives its required verifier");
	assert.equal(calls.length, 5, "the unrecovered failed worker needs no verifier and no extra child is admitted");
	assert.equal(maxActiveWorkers, 2, "parallel workers still obey maxConcurrency");
	assert.equal(result.usage.input, 44, "split, both failed attempts, recovery, and verifier usage are all charged once");
	assert.equal(result.ok, false, "the worker whose optional recovery did not fit remains an ordinary failed item");
	assert.ok(logs.some((line) => /no child budget left to recover/i.test(line)));
});

test("map skips a splitter retry when it would leave too few slots for the declared waves", async () => {
	const calls: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			calls.push(spec.agent);
			if (spec.agent === "splitter") return providerFailure(spec.agent, BROKEN_MODEL);
			return success(spec.agent, "worked");
		},
	};
	const sdk = sdkFor(engine, [{ agent: "splitter", model: BROKEN_MODEL }, "worker"], 5, 2);

	const result = await map.run({ task: "split and implement", roster: "review", params: { verify: "verifier", maxItems: 2 } }, sdk);

	assert.equal(result.ok, false);
	assert.equal(result.failureKind, "provider");
	assert.deepEqual(calls, ["splitter"], "a failed split ends cleanly when retry plus both declared waves cannot fit");
});

test("pipeline reserves later steps but spends a retry when the budget has room", async () => {
	for (const [maxChildren, expectRecovery] of [[3, false], [4, true]] as const) {
		const calls: Array<{ agent: string; model?: string }> = [];
		const engine: StrategyEngine = {
			run: async (spec) => {
				calls.push({ agent: spec.agent, ...(spec.model ? { model: spec.model } : {}) });
				if (spec.agent === "first" && spec.model === BROKEN_MODEL) return providerFailure(spec.agent, BROKEN_MODEL);
				return success(spec.agent, `${spec.agent} output`);
			},
		};
		const sdk = sdkFor(engine, [{ agent: "first", model: BROKEN_MODEL }, "second", "third"], maxChildren);

		const result = await pipeline.run({ task: "build in order", roster: "review", params: {} }, sdk);

		if (expectRecovery) {
			assert.equal(result.ok, true, result.error);
			assert.deepEqual(calls.map((call) => call.agent), ["first", "first", "second", "third"]);
			assert.equal(calls[1]?.model, MAIN_MODEL);
		} else {
			assert.equal(result.ok, false, "the failed first step is reported instead of letting an admission throw kill the run");
			assert.deepEqual(calls.map((call) => call.agent), ["first"], "the retry is skipped because two required steps remain");
		}
	}
});

test("critic-loop reserves exact future work at each phase and preserves a genuinely affordable retry", async () => {
	for (const [phase, maxChildren, expectedCalls, expectRecovery] of [
		["generator", 4, 1, false],
		["critic", 4, 2, false],
		["revision", 4, 3, false],
		["generator", 5, 5, true],
		["critic", 5, 5, true],
		["revision", 5, 5, true],
	] as const) {
		const calls: Array<{ agent: string; model?: string; task: string }> = [];
		let settledCritics = 0;
		let criticFailureInjected = false;
		const engine: StrategyEngine = {
			run: async (spec) => {
				calls.push({ agent: spec.agent, ...(spec.model ? { model: spec.model } : {}), task: spec.task });
				const revision = spec.task.includes("Revise the work");
				const shouldFail =
					(phase === "generator" && spec.agent === "generator" && !revision && spec.model === BROKEN_MODEL) ||
					(phase === "critic" && spec.agent === "critic" && !criticFailureInjected && spec.model === BROKEN_MODEL) ||
					(phase === "revision" && spec.agent === "generator" && revision && spec.model === BROKEN_MODEL);
				if (phase === "critic" && shouldFail) criticFailureInjected = true;
				if (shouldFail) return providerFailure(spec.agent, BROKEN_MODEL);
				if (spec.agent === "critic") {
					const stance = settledCritics++ === 0 ? "reject" : "approve";
					return success(spec.agent, "reviewed", 1, { stance });
				}
				return success(spec.agent, revision ? "draft two" : "draft one", 1);
			},
		};
		const sdk = sdkFor(engine, [
			{ agent: "generator", model: BROKEN_MODEL },
			{ agent: "critic", model: BROKEN_MODEL },
		], maxChildren);

		const result = await criticLoop.run({ task: "draft", roster: "review", params: { rounds: 2 } }, sdk);

		assert.equal(calls.length, expectedCalls, `${phase} phase at maxChildren=${maxChildren}`);
		assert.equal(calls.some((call) => call.model === MAIN_MODEL), expectRecovery, `${phase} recovery admission at maxChildren=${maxChildren}`);
		if (expectRecovery) assert.equal(result.ok, true, result.error);
		else {
			assert.equal(result.ok, false);
			assert.notEqual(result.failureKind, "agent", "headroom exhaustion must preserve the original model failure");
		}
	}
});

test("council-rounds reserves later rounds and spends a retry only when it fits", async () => {
	for (const [maxChildren, expectRecovery] of [[4, false], [5, true]] as const) {
		const calls: Array<{ agent: string; model?: string; laterRound: boolean }> = [];
		let releaseBrokenMember!: () => void;
		const otherMemberEntered = new Promise<void>((resolve) => {
			releaseBrokenMember = resolve;
		});
		let firstBrokenAttempt = true;
		const engine: StrategyEngine = {
			run: async (spec: AgentRunSpec) => {
				const laterRound = spec.task.includes("round 1 debate");
				calls.push({ agent: spec.agent, ...(spec.model ? { model: spec.model } : {}), laterRound });
				if (spec.agent === "broken" && !laterRound && firstBrokenAttempt) {
					firstBrokenAttempt = false;
					await otherMemberEntered;
					return providerFailure(spec.agent, BROKEN_MODEL);
				}
				if (spec.agent === "other" && !laterRound) {
					releaseBrokenMember();
					return success(spec.agent, "other's first-round vote", 1, { vote: "B", confidence: 0.8 });
				}
				return success(spec.agent, `${spec.agent} vote`, 1, { vote: "A", confidence: 0.8 });
			},
		};
		const sdk = sdkFor(engine, [{ agent: "broken", model: BROKEN_MODEL }, "other"], maxChildren, 2);

		const result = await councilRounds.run({ task: "choose", roster: "review", params: { rounds: 2, bestOf: 2 } }, sdk);

		assert.equal(result.ok, true, result.error);
		assert.equal(result.structured?.rounds, 2);
		assert.equal(calls.length, maxChildren, "the later round fits exactly after any admitted recovery");
		assert.equal(calls.filter((call) => call.model === MAIN_MODEL).length, expectRecovery ? 1 : 0);
		assert.equal(calls.filter((call) => call.laterRound).length, 2);
	}
});

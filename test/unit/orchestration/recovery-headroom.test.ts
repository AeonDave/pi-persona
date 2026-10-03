import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../../../src/orchestration/strategies/judge.ts";
import { synthesize } from "../../../src/orchestration/strategies/synthesize.ts";
import { makeSDK } from "../../../src/orchestration/sdk.ts";
import { makeRoster } from "../../../src/orchestration/roster.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

for (const strategy of [judge, synthesize]) {
	for (const maxChildren of [4, 5]) {
	for (const maxConcurrency of [1, 2, 3]) {
		test(`${strategy.name} recovery preserves the final actor and uses genuine spare budget (${maxChildren} children, concurrency ${maxConcurrency})`, async () => {
			const calls: string[] = [];
			const sdk = makeSDK({
				roster: makeRoster({ panel: [{ agent: "broken", model: "fixture/broken" }, "second", "third"] }),
				limits: { maxChildren, maxConcurrency, budgetTokens: 0, timeoutMs: 1000 },
				sessionModel: "fixture/main",
				engine: { run: async (spec) => {
					calls.push(spec.agent);
					if (spec.model === "fixture/broken") return { agent: spec.agent, output: "", ok: false, usage: emptyUsage(), failureKind: "provider", modelUsed: "fixture/broken", error: "synthetic unavailable" };
					return { agent: spec.agent, output: "usable answer", ok: true, usage: emptyUsage(), ...(spec.agent === "arbiter" ? { structured: { vote: "A", output: "chosen" } } : {}) };
				} },
			});
			const result = await strategy.run({ task: "choose", roster: "panel", params: strategy.name === "judge" ? { judge: "arbiter" } : { synthesizer: "arbiter" } }, sdk);
			assert.equal(result.ok, true, result.error);
			assert.equal(calls.length, maxChildren);
			assert.equal(calls.at(-1), "arbiter", "optional recovery must leave the required judge/merge slot intact");
		});
	}
	}
}

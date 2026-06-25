import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../src/agents/agent.ts";
import { makeEngine } from "../../src/engine/adapter.ts";
import { makeSDK } from "../../src/orchestration/sdk.ts";
import { getStrategy } from "../../src/orchestration/strategy.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const resolveFake = (args: string[]) => ({ command: process.execPath, args: [FAKE, ...args] });
const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 5000, budgetTokens: 1_000_000 };

const mk = (name: string): AgentConfig => ({ name, systemPrompt: `You are ${name}.`, systemPromptMode: "replace", source: "x" });
const AGENTS: Record<string, AgentConfig> = { a: mk("a"), b: mk("b"), c: mk("c") };

test("full spine: fanout strategy → SDK → engine adapter → real child processes → aggregate", async () => {
	const engine = makeEngine({
		resolveAgent: (n) => AGENTS[n],
		childOptions: { resolveInvocation: resolveFake },
	});
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "review" ? ["a", "b", "c"] : []) }, limits: LIMITS });

	const fanout = getStrategy("fanout");
	assert.ok(fanout, "fanout strategy is registered");

	const result = await fanout.run({ task: "audit this", roster: "review", params: {} }, sdk);

	assert.equal(result.ok, true);
	assert.equal(result.structured?.count, 3);
	assert.match(result.output, /\[a\]/);
	assert.match(result.output, /\[b\]/);
	assert.match(result.output, /\[c\]/);
	assert.match(result.output, /echo: Task: audit this/);
	assert.ok(result.usage.input >= 15, "usage summed across 3 children (5 each)");
});

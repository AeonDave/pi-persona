import { test } from "node:test";
import assert from "node:assert/strict";

import { planModelRecovery, RETRYABLE_MODEL_FAILURES } from "../../../src/orchestration/model-retry.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

function res(over: Partial<AgentResult> & { agent: string }): AgentResult {
	return { output: "", usage: usage(), ok: true, ...over };
}

const bad = (modelUsed?: string, failureKind: AgentResult["failureKind"] = "provider") =>
	res({ agent: "core", ok: false, failureKind, error: "boom", ...(modelUsed ? { modelUsed } : {}) });

test("a model-caused failure plans one retry on the session's own model", () => {
	for (const kind of RETRYABLE_MODEL_FAILURES) {
		assert.deepEqual(planModelRecovery(bad("openai-codex/gpt-5.6", kind), { sessionModel: "anthropic/sonnet-5" }), {
			from: "openai-codex/gpt-5.6",
			to: "anthropic/sonnet-5",
			reason: "session",
		});
	}
});

test("only a model-caused failure retries; a user stop never does", () => {
	for (const kind of ["abort", "timeout", "contract", "agent", "unknown-agent"] as const) {
		assert.equal(planModelRecovery(bad("openai-codex/gpt-5.6", kind), { sessionModel: "anthropic/sonnet-5" }), null, kind);
	}
	assert.equal(
		planModelRecovery(res({ agent: "core", ok: false, error: "boom", modelUsed: "x/y" }), { sessionModel: "anthropic/sonnet-5" }),
		null,
		"a missing failureKind is not evidence of a model problem",
	);
	assert.equal(planModelRecovery(res({ agent: "core", ok: true }), { sessionModel: "anthropic/sonnet-5" }), null, "a healthy leg is never planned");
});

test("no main model, or a main model equal to what just failed, plans nothing", () => {
	// There is no other model in play by design — a retry on the same model is a second bill for
	// an identical outcome, and an arbitrary other provider is never an authorised substitute.
	assert.equal(planModelRecovery(bad("x/y"), {}), null, "no session model");
	assert.equal(planModelRecovery(bad("x/y"), { sessionModel: "  " }), null, "blank session model");
	assert.equal(planModelRecovery(bad("anthropic/sonnet-5"), { sessionModel: "anthropic/sonnet-5" }), null, "same resolved model");
	assert.equal(planModelRecovery(bad(), { sessionModel: "anthropic/sonnet-5", requested: "anthropic/sonnet-5" }), null, "same requested model");
});

test("a failure that never resolved a model still plans the session model", () => {
	// The ref did not even resolve — that is the strongest case for handing the leg a model the
	// user is demonstrably running on right now.
	assert.deepEqual(planModelRecovery(bad(undefined, "unknown-model"), { sessionModel: "anthropic/sonnet-5" }), {
		to: "anthropic/sonnet-5",
		reason: "session",
	});
});
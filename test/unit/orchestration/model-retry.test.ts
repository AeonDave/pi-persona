import { test } from "node:test";
import assert from "node:assert/strict";

import { planModelRetries, RETRYABLE_MODEL_FAILURES } from "../../../src/orchestration/model-retry.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

function res(over: Partial<AgentResult> & { agent: string }): AgentResult {
	return { output: "", usage: usage(), ok: true, ...over };
}

const ok = (agent: string, modelUsed: string) => res({ agent, ok: true, modelUsed });
const bad = (agent: string, modelUsed: string, failureKind: AgentResult["failureKind"] = "provider") =>
	res({ agent, ok: false, failureKind, modelUsed, error: "boom" });

test("a failed core borrows a model that worked for a peer in this same run", () => {
	const plan = planModelRetries(
		[bad("melchior", "anthropic/opus-4-6"), ok("balthasar", "anthropic/sonnet-5"), ok("casper", "openai/gpt-5.6")],
		{ sessionModel: "anthropic/sonnet-5" },
	);
	assert.deepEqual(plan, [{ index: 0, agent: "melchior", from: "anthropic/opus-4-6", model: "anthropic/sonnet-5", reason: "peer" }]);
});

test("with no peer left standing every failed core falls back to the session's own model", () => {
	// "the first one, or all of them" — there is no healthy peer to borrow from, so the model the
	// user is already running on is the best evidence of something that works.
	const plan = planModelRetries(
		[bad("melchior", "anthropic/opus-4-6"), bad("balthasar", "x/broken"), bad("casper", "y/also-broken")],
		{ sessionModel: "anthropic/sonnet-5" },
	);
	assert.deepEqual(plan.map((p) => [p.agent, p.model, p.reason]), [
		["melchior", "anthropic/sonnet-5", "session"],
		["balthasar", "anthropic/sonnet-5", "session"],
		["casper", "anthropic/sonnet-5", "session"],
	]);
});

test("the session model is preferred over an arbitrary peer when it is itself proven", () => {
	// Two models worked; the session one is the user's own choice and the most likely authed.
	const plan = planModelRetries(
		[ok("balthasar", "openai/gpt-5.6"), bad("melchior", "anthropic/opus-4-6"), ok("casper", "anthropic/sonnet-5")],
		{ sessionModel: "anthropic/sonnet-5" },
	);
	assert.deepEqual(plan, [{ index: 1, agent: "melchior", from: "anthropic/opus-4-6", model: "anthropic/sonnet-5", reason: "peer" }]);
});

test("peer choice is deterministic — roster order, not iteration accident", () => {
	const plan = planModelRetries(
		[ok("balthasar", "openai/gpt-5.6"), ok("casper", "z/other"), bad("melchior", "anthropic/opus-4-6")],
		{ sessionModel: "unrelated/model" },
	);
	assert.equal(plan[0]?.model, "openai/gpt-5.6", "the first healthy peer in roster order wins");
});

test("only a model-caused failure retries; a user stop never does", () => {
	for (const kind of ["abort", "timeout", "contract", "agent", "unknown-agent"] as const) {
		const plan = planModelRetries([bad("melchior", "anthropic/opus-4-6", kind), ok("casper", "anthropic/sonnet-5")], { sessionModel: "anthropic/sonnet-5" });
		assert.deepEqual(plan, [], `${kind} must not be retried on a different model`);
	}
	for (const kind of RETRYABLE_MODEL_FAILURES) {
		const plan = planModelRetries([bad("melchior", "anthropic/opus-4-6", kind), ok("casper", "anthropic/sonnet-5")], { sessionModel: "anthropic/sonnet-5" });
		assert.equal(plan.length, 1, `${kind} is model-caused and must be retried`);
	}
});

test("a core is never retried on the model that just failed it", () => {
	// Every peer that worked was on the same model this core already failed on: there is nothing
	// new to try, so re-running would only burn tokens to fail identically.
	const plan = planModelRetries(
		[bad("melchior", "anthropic/sonnet-5"), ok("casper", "anthropic/sonnet-5")],
		{ sessionModel: "anthropic/sonnet-5" },
	);
	assert.deepEqual(plan, []);
});

test("a failed core skips a matching healthy model and borrows the next distinct peer model", () => {
	const plan = planModelRetries(
		[bad("melchior", "anthropic/shared"), ok("balthasar", "anthropic/shared"), ok("casper", "openai/gpt-5.6")],
		{ sessionModel: "anthropic/shared" },
	);
	assert.deepEqual(plan, [{ index: 0, agent: "melchior", from: "anthropic/shared", model: "openai/gpt-5.6", reason: "peer" }]);
});

test("a run with no session model and no healthy peer plans nothing", () => {
	const plan = planModelRetries([bad("melchior", "a/b"), bad("casper", "c/d")], {});
	assert.deepEqual(plan, []);
});

test("a failure with no known model still retries when a peer proves one", () => {
	// The engine could not even resolve a ref, so `modelUsed` is absent — that is the strongest
	// case for handing the core a model that demonstrably resolves.
	const plan = planModelRetries(
		[res({ agent: "melchior", ok: false, failureKind: "unknown-model", error: "no such model" }), ok("casper", "anthropic/sonnet-5")],
		{ sessionModel: "anthropic/sonnet-5" },
	);
	assert.deepEqual(plan, [{ index: 0, agent: "melchior", model: "anthropic/sonnet-5", reason: "peer" }]);
});

test("healthy cores are never planned for a retry", () => {
	assert.deepEqual(planModelRetries([ok("a", "m/1"), ok("b", "m/2")], { sessionModel: "m/1" }), []);
});

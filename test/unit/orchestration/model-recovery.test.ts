/**
 * Central main-only model recovery — the SDK seam every strategy (all 11, plus flows, council,
 * and the judge arbiter/critic) shares. A leg whose MODEL is unreachable is re-run ONCE on the
 * session's own model; nothing else about the leg changes, and nothing about the run's honesty
 * (usage, limits, cancellation, one logical UI node) does either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeSDK, type AgentRunSpec, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult, FailureKind } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 0 };
const usage = (over: Partial<AgentResult["usage"]> = {}): AgentResult["usage"] => ({
	input: 1,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 1,
	...over,
});

interface Attempt {
	agent: string;
	spec: AgentRunSpec;
	/** 1-based attempt number for this agent. */
	n: number;
}

/** A recording engine: `reply` answers each attempt, in order, per agent. */
function harness(reply: (attempt: Attempt) => AgentResult | Promise<AgentResult>) {
	const attempts: Attempt[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			const mine = attempts.filter((a) => a.agent === spec.agent).length + 1;
			const attempt: Attempt = { agent: spec.agent, spec, n: mine };
			attempts.push(attempt);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				const r = await reply(attempt);
				// Let concurrent legs interleave deterministically enough for the in-flight ceiling.
				await new Promise<void>((resolve) => setImmediate(resolve));
				return r;
			} finally {
				inFlight--;
			}
		},
	};
	return { engine, attempts, maxInFlight: () => maxInFlight };
}

const broken = (agent: string, modelUsed: string, failureKind: FailureKind = "provider"): AgentResult => ({
	agent,
	output: "",
	usage: usage(),
	ok: false,
	error: `provider 503 on ${modelUsed}`,
	modelUsed,
	failureKind,
});

const good = (agent: string, modelUsed?: string): AgentResult => ({
	agent,
	output: `${agent} answered`,
	usage: usage(),
	ok: true,
	...(modelUsed ? { modelUsed } : {}),
});

const sdkFor = (engine: StrategyEngine, deps: Partial<Parameters<typeof makeSDK>[0]> = {}) =>
	makeSDK({ engine, roster: { team: () => [] }, limits: LIMITS, ...deps });

// ---------------------------------------------------------------------------------------------
// The recovery itself

test("a provider failure is retried ONCE on the session model, even behind a provider-qualified pin", async () => {
	// The pin is an explicit provider/billing choice — but it may simply be UNAVAILABLE (unreachable
	// ref, dead auth, retired route). The user's own running model is the one thing proven reachable,
	// so a leg that lost its model gets one attempt on it rather than being lost entirely.
	const { engine, attempts } = harness((a) => (a.n === 1 ? broken(a.agent, a.spec.model!) : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t", model: "openai-codex/gpt-5.6" });

	assert.deepEqual(attempts.map((a) => a.n), [1, 2], "exactly one retry, never a loop");
	assert.equal(attempts[1]?.spec.model, "anthropic/sonnet-5", "the retry runs on the MAIN model");
	assert.equal(r.ok, true);
	assert.deepEqual(r.modelRecovery, { from: "openai-codex/gpt-5.6", to: "anthropic/sonnet-5" });
	assert.equal(r.modelUsed, "anthropic/sonnet-5", "the result reports what actually answered");
});

test("an unknown-model failure recovers the same way", async () => {
	const { engine, attempts } = harness((a) => (a.n === 1 ? broken(a.agent, "ghost/model", "unknown-model") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 2);
	assert.equal(r.ok, true);
	assert.deepEqual(r.modelRecovery, { from: "ghost/model", to: "anthropic/sonnet-5" });
});

test("the retry preserves every other aspect of the leg", async () => {
	const { engine, attempts } = harness((a) => (a.n === 1 ? broken(a.agent, "x/gone") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const spec: AgentRunSpec = {
		agent: "reviewer",
		name: "lens·SECURITY",
		task: "audit",
		tools: ["read"],
		skills: ["owasp"],
		role: "security lens",
		outputContract: "default",
		isolation: "worktree",
		mcp: true,
		peers: true,
		timeoutMs: 4242,
		model: "x/gone",
	};
	await sdk.agent(spec);
	const retry = attempts[1]?.spec as AgentRunSpec;
	assert.deepEqual({ ...retry, model: undefined }, { ...spec, model: undefined }, "only `model` changes");
	assert.equal(retry.agent, "reviewer", "identity/routing is unchanged — one logical node");
});

test("no terminal failure class is ever retried on another model", async () => {
	for (const kind of ["abort", "timeout", "contract", "agent", "unknown-agent"] as const) {
		const { engine, attempts } = harness((a) => broken(a.agent, "x/gone", kind));
		const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
		const r = await sdk.agent({ agent: "core", task: "t" });
		assert.equal(attempts.length, 1, `${kind} must not respawn on another model`);
		assert.equal(r.failureKind, kind);
		assert.equal(r.modelRecovery, undefined);
	}
});

test("nothing is retried when the main model is missing, blank, or the model that just failed", async () => {
	const cases: Array<[string, string | undefined, string | undefined]> = [
		["no session model", undefined, "x/gone"],
		["blank session model", "   ", "x/gone"],
		["same as the RESOLVED failure", "anthropic/sonnet-5", "anthropic/sonnet-5"],
	];
	for (const [label, sessionModel, brokenModel] of cases) {
		const { engine, attempts } = harness((a) => broken(a.agent, brokenModel!));
		const sdk = sdkFor(engine, sessionModel ? { sessionModel } : {});
			const r = await sdk.agent({ agent: "core", task: "t", ...(brokenModel ? { model: brokenModel } : {}) });
		assert.equal(attempts.length, 1, `${label}: re-running on the same model changes nothing`);
		assert.equal(r.modelRecovery, undefined);
	}
});

test("a failure that never resolved a model still does not retry onto the model the run ASKED for", async () => {
	// `modelUsed` is absent (the ref did not even resolve) but the requested pin IS the main model —
	// asking again would ask for the identical run.
	const { engine, attempts } = harness((a) => ({ agent: a.agent, output: "", usage: usage(), ok: false, error: "no such model", failureKind: "unknown-model" }));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t", model: "anthropic/sonnet-5" });
	assert.equal(attempts.length, 1);
	assert.match(r.error ?? "", /no such model/);
});

test("a failed retry is NOT retried a third time and keeps the ORIGINAL cause", async () => {
	const { engine, attempts } = harness((a) => broken(a.agent, a.spec.model ?? "?"));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t", model: "openai-codex/gpt-5.6" });

	assert.equal(attempts.length, 2, "recovery is bounded to one attempt");
	assert.equal(r.ok, false);
	assert.equal(r.failureKind, "provider");
	assert.match(r.error ?? "", /openai-codex\/gpt-5\.6/, "the reported cause describes the model's own configured failure");
	assert.deepEqual(r.modelRecovery, { from: "openai-codex/gpt-5.6", to: "anthropic/sonnet-5" }, "the failed recovery is still disclosed");
});

test("an engine rejection is contained and never retried", async () => {
	let runs = 0;
	const sdk = sdkFor({ run: async () => {
		runs++;
		throw new Error("harness blew up");
	} }, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(runs, 1, "infra is not evidence about the model");
	assert.equal(r.failureKind, "agent");
	assert.match(r.error ?? "", /harness blew up/);
	assert.equal(r.modelRecovery, undefined);
});

// ---------------------------------------------------------------------------------------------
// Limits, usage, cancellation

test("both attempts are billed exactly once, cache fields and cost included", async () => {
	const { engine } = harness((a) =>
		a.n === 1
			? { ...broken(a.agent, "x/gone"), usage: usage({ input: 10, output: 2, cacheRead: 7, cacheWrite: 3, cost: 0.25 }) }
			: good(a.agent, a.spec.model),
	);
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5" });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.deepEqual(r.usage, usage({ input: 11, output: 2, cacheRead: 7, cacheWrite: 3, cost: 0.25, turns: 2 }));
});

test("a completed token budget blocks the retry and returns the original cause instead of failing the run", async () => {
	const { engine, attempts } = harness((a) => ({ ...broken(a.agent, "x/gone"), usage: usage({ input: 100 }) }));
	const logs: string[] = [];
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", limits: { ...LIMITS, budgetTokens: 100 }, log: (m) => logs.push(m) });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 1, "no billable leg starts past the budget");
	assert.equal(r.failureKind, "provider", "an optional recovery must never turn into a run-fatal throw");
	assert.match(logs.join(" | "), /token budget/i, "the skipped recovery is stated, not silent");
});

test("an affordable remainder is spent on the retry", async () => {
	const { engine, attempts } = harness((a) => (a.n === 1 ? { ...broken(a.agent, "x/gone"), usage: usage({ input: 10 }) } : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", limits: { ...LIMITS, budgetTokens: 15 } });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 2);
	assert.equal(r.ok, true);
});

test("the retry is charged to maxChildren and skipped — never thrown — when no child slot is left", async () => {
	const { engine, attempts } = harness((a) => broken(a.agent, "x/gone"));
	const logs: string[] = [];
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", limits: { ...LIMITS, maxChildren: 1 }, log: (m) => logs.push(m) });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 1);
	assert.equal(r.failureKind, "provider");
	assert.match(logs.join(" | "), /maxChildren/i);
});

test("a root abort before the retry leaves the stopped leg stopped", async () => {
	const root = new AbortController();
	const { engine, attempts } = harness((a) => {
		root.abort(); // the stop lands while the first attempt is in flight
		return broken(a.agent, "x/gone");
	});
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", signal: root.signal });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 1, "a stopped run is never resurrected");
	assert.equal(r.failureKind, "provider");
});

test("a stop DURING the retry settles as an abort, so the leg still reads as stopped", async () => {
	const root = new AbortController();
	const { engine } = harness(async (a) => {
		if (a.n === 2) {
			root.abort();
			return { agent: a.agent, output: "", usage: usage(), ok: false, error: "aborted", failureKind: "abort" };
		}
		return broken(a.agent, "x/gone");
	});
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", signal: root.signal });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(r.failureKind, "abort", "a stopped leg must not read as a plain model failure");
	assert.deepEqual(r.modelRecovery, { from: "x/gone", to: "anthropic/sonnet-5" });
});

test("a per-leg stop (UI stop) is never recovered", async () => {
	const { engine, attempts } = harness((a) => {
		void a;
		return broken(a.agent, "x/gone");
	});
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", onAgentStart: (_agent, abort) => abort() });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts.length, 0, "the user stopped before engine start; no attempt is invoked");
	assert.equal(r.failureKind, "abort");
});

test("the retry never exceeds the concurrency ceiling and never deadlocks its own slot", async () => {
	const { engine, attempts, maxInFlight } = harness((a) => (a.n === 1 ? broken(a.agent, "x/gone") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", limits: { ...LIMITS, maxConcurrency: 1 } });
	const results = await Promise.all([sdk.agent({ agent: "a", task: "t" }), sdk.agent({ agent: "b", task: "t" })]);
	assert.equal(attempts.length, 4, "two legs, each recovered once");
	assert.equal(maxInFlight(), 1, "the retry runs inside the held slot, never beside it");
	assert.deepEqual(results.map((r) => r.ok), [true, true], "the run completes — no recursive-slot deadlock");
});

// ---------------------------------------------------------------------------------------------
// Transparency

test("onModelFallback fires before the retry, with the run-scoped UI key", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const { engine } = harness((a) => (a.n === 1 ? broken(a.agent, "x/gone") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, {
		sessionModel: "anthropic/sonnet-5",
		onModelFallback: (info) => seen.push({ ...info }),
	});
	await sdk.agent({ agent: "core", task: "t", role: "security lens" });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], { agent: "core", from: "x/gone", to: "anthropic/sonnet-5", key: "core · security lens" });
});

test("a throwing recovery callback cannot discard a billed, finished result", async () => {
	const { engine } = harness((a) => (a.n === 1 ? broken(a.agent, "x/gone") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, {
		sessionModel: "anthropic/sonnet-5",
		onModelFallback: () => {
			throw new Error("the toast renderer blew up");
		},
	});
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(r.ok, true, "the host's cosmetic hook is not allowed to eat the leg");
	assert.equal(r.output, "core answered");
});

test("one logical node: running → failed → running (re-attempt clears the failed state) → done", async () => {
	const seen: Array<{ status: string; output?: string }> = [];
	const { engine } = harness((a) => (a.n === 1 ? broken(a.agent, "x/gone") : good(a.agent, a.spec.model)));
	const sdk = sdkFor(engine, {
		sessionModel: "anthropic/sonnet-5",
		onAgentStatus: (_agent, status, result) => seen.push({ status, ...(result ? { output: result.output } : {}) }),
	});
	await sdk.agent({ agent: "core", task: "t" });
	assert.deepEqual(seen.map((s) => s.status), ["running", "failed", "running", "done"]);
	assert.equal(seen.at(-1)?.output, "core answered", "the terminal status carries the recovered result");
});
test("the recovery model is resolved AT FAILURE TIME, so a mid-run main-model switch is honoured", async () => {
	// The user can switch models (e.g. a `/model` pick) while a council is running. A leg that then
	// loses its model must land on the CURRENT main model, not the one that was main when the run
	// started — the stale snapshot is exactly the pin that has just proven unreachable.
	let main: string | undefined = "anthropic/sonnet-5";
	const { engine, attempts } = harness((a) => {
		if (a.n === 1) {
			main = "openai/gpt-5.6"; // the user's switch, landing mid-run
			return broken(a.agent, "x/gone");
		}
		return good(a.agent, a.spec.model);
	});
	const sdk = sdkFor(engine, { sessionModel: "anthropic/sonnet-5", getSessionModel: () => main });
	const r = await sdk.agent({ agent: "core", task: "t" });
	assert.equal(attempts[1]?.spec.model, "openai/gpt-5.6", "recovery follows the CURRENT main model");
	assert.deepEqual(r.modelRecovery, { from: "x/gone", to: "openai/gpt-5.6" });
});

test("sdk.sessionModel uses the live main model, or a snapshot only when no live getter exists", async () => {
	let main: string | undefined = "a/one";
	const live = sdkFor(harness(() => broken("core", "x/gone")).engine, { sessionModel: "b/pinned", getSessionModel: () => main });
	assert.equal(live.sessionModel, "a/one", "the getter wins while it answers");
	main = undefined;
	assert.equal(live.sessionModel, undefined, "an absent live model must not resurrect a stale assignment");
	const pinned = sdkFor(harness(() => broken("core", "x/gone")).engine, { sessionModel: "b/pinned" });
	assert.equal(pinned.sessionModel, "b/pinned", "the legacy dep still works with no getter");
});

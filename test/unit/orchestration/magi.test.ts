import { test } from "node:test";
import assert from "node:assert/strict";

import { makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { magi } from "../../../src/orchestration/strategies/magi.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

function votingEngine(votes: Record<string, string>): StrategyEngine {
	return {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: `${s.agent} says ${votes[s.agent]}`,
			structured: { vote: votes[s.agent], confidence: 0.7 },
			usage: usage(),
			ok: true,
		}),
	};
}

test("magi runs the roster, votes by majority, and reports the ruling + tally", async () => {
	const sdk = makeSDK({
		engine: votingEngine({ melchior: "A", balthasar: "A", casper: "B" }),
		roster: { team: (n) => (n === "magi" ? ["melchior", "balthasar", "casper"] : []) },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.equal(r.ok, true);
	assert.equal(r.structured?.status, "winner");
	assert.match(r.output, /a=2/);
	assert.match(r.output, /dissent/i);
});

test("magi's ruling renders the winner's human fields, not the raw JSON envelope", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: '```json\n{"result":"ship json","vote":"json","output":"because reasons","confidence":0.9}\n```',
			structured: { result: "ship json", vote: "json", output: "because reasons", confidence: 0.9 },
			usage: usage(),
			ok: true,
		}),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["melchior", "balthasar", "casper"] }, limits: LIMITS });
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.match(r.output, /ship json/, "shows the winner's one-line result");
	assert.match(r.output, /because reasons/, "shows the winner's output synthesis");
	assert.doesNotMatch(r.output, /```/, "no code fence leaks into the ruling");
	assert.doesNotMatch(r.output, /"vote":/, "no raw JSON envelope in the ruling");
});

test("magi leads with the ruling (not the decision/tally plumbing) and exposes a headline", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => ({
			agent: s.agent,
			output: "raw",
			structured: { result: "ship json", vote: "json", output: "because reasons", confidence: 0.9 },
			usage: usage(),
			ok: true,
		}),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["melchior", "balthasar", "casper"] }, limits: LIMITS });
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.doesNotMatch(r.output.split("\n")[0] ?? "", /MAGI decision|tally/, "content leads with the ruling, not the plumbing");
	assert.match(r.output, /ship json/);
	assert.equal(r.structured?.headline, "ship json", "headline is the winner's one-liner, for the collapsed card");
});

test("magi honours unanimity and surfaces no_consensus when the 3 disagree", async () => {
	const sdk = makeSDK({
		engine: votingEngine({ melchior: "A", balthasar: "B", casper: "C" }),
		roster: { team: () => ["melchior", "balthasar", "casper"] },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { aggregate: "unanimity" } }, sdk);
	assert.match(r.output, /no_consensus/);
});

test("magi runs a reflection round by default: cores see the others' positions and can converge", async () => {
	// melchior/balthasar split 2-1 in round 1; casper is 'moved' by seeing the others in round 2.
	let calls = 0;
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => {
			calls++;
			const reflected = /positions so far/.test(s.task);
			// Round 1: melchior=A, balthasar=A, casper=B. Round 2: casper switches to A (converges).
			const vote = s.agent === "casper" ? (reflected ? "A" : "B") : "A";
			return { agent: s.agent, output: `${s.agent}:${vote}`, structured: { vote, confidence: 0.7 }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["melchior", "balthasar", "casper"] }, limits: LIMITS });
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.equal(calls, 6, "two rounds of three cores ran");
	assert.match(r.output, /reflection round/, "the ruling notes the reflection round happened");
	assert.match(r.output, /a=3/i, "the final tally reflects the round-2 votes (casper moved to A)");
	assert.equal(r.structured?.reflected, true);
});

test("magi with reflect:false is a single independent poll (no reflection round)", async () => {
	let calls = 0;
	const sdk = makeSDK({
		engine: {
			run: async (s): Promise<AgentResult> => {
				calls++;
				return { agent: s.agent, output: s.agent, structured: { vote: "A", confidence: 0.7 }, usage: usage(), ok: true };
			},
		},
		roster: { team: () => ["melchior", "balthasar", "casper"] },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);
	assert.equal(calls, 3, "exactly one round of three cores");
	assert.equal(r.structured?.reflected, false);
	assert.doesNotMatch(r.output, /reflection round/);
});

test("magi's reflection preserves dissent even when the panel does NOT converge", async () => {
	// Cores hold their positions across both rounds → the minority report survives.
	const sdk = makeSDK({
		engine: votingEngine({ melchior: "A", balthasar: "A", casper: "B" }),
		roster: { team: () => ["melchior", "balthasar", "casper"] },
		limits: LIMITS,
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.match(r.output, /dissent/i, "the held minority position is still reported");
	assert.match(r.output, /a=2/);
});

test("magi requires a roster", async () => {
	const sdk = makeSDK({ engine: votingEngine({}), roster: { team: () => [] }, limits: LIMITS });
	await assert.rejects(() => magi.run({ task: "decide", params: {} }, sdk));
});

// --------------------------------------------------------------------------------------------
// Model recovery — a core whose MODEL broke is re-run once on one that demonstrably works, so a
// provider outage costs the council one member's diversity rather than its vote.

/** An engine that fails a given agent while its model is the broken one, and succeeds otherwise. */
function brokenModelEngine(broken: Record<string, string>, opts: { failureKind?: AgentResult["failureKind"] } = {}) {
	const attempts: Array<{ agent: string; model?: string }> = [];
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => {
			attempts.push({ agent: s.agent, ...(s.model ? { model: s.model } : {}) });
			const brokenFor = broken[s.agent];
			if (brokenFor !== undefined && (s.model ?? brokenFor) === brokenFor) {
				return { agent: s.agent, output: "", usage: usage(), ok: false, error: "provider exploded", modelUsed: brokenFor, failureKind: opts.failureKind ?? "provider" };
			}
			return { agent: s.agent, output: `${s.agent} ok`, structured: { vote: "A", confidence: 0.8 }, usage: usage(), ok: true, modelUsed: s.model ?? "session/base" };
		},
	};
	return { engine, attempts };
}

const magiRoster = (models: Record<string, string>) => ({
	team: (n: string) =>
		n === "magi" ? [{ agent: "melchior", model: models.melchior! }, { agent: "balthasar", model: models.balthasar! }, { agent: "casper", model: models.casper! }] : [],
});

test("a core whose model broke is re-run on a model that worked for a peer, and its vote counts", async () => {
	const { engine, attempts } = brokenModelEngine({ melchior: "anthropic/opus-4-6" });
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);

	const retry = attempts.filter((a) => a.agent === "melchior");
	assert.equal(retry.length, 2, `melchior runs once and is recovered once: ${JSON.stringify(retry)}`);
	assert.equal(retry[1]?.model, "anthropic/sonnet-5", "recovered on the model a peer proved");
	assert.equal(r.ok, true);
	assert.match(r.output, /a=3/, "the recovered core's vote is in the tally");
	// A borrowed model costs the council real diversity, so the ruling must say it happened —
	// sdk.log has no production sink, and a silent recovery is a silently weaker poll.
	assert.match(r.output, /1 core recovered on anthropic\/sonnet-5/, `the ruling must name the recovery: ${r.output}`);
});

test("with every model broken the cores are recovered on the session's own model", async () => {
	const { engine, attempts } = brokenModelEngine({ melchior: "x/one", balthasar: "y/two", casper: "z/three" });
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "x/one", balthasar: "y/two", casper: "z/three" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);
	assert.deepEqual(
		attempts.filter((a) => a.model === "anthropic/sonnet-5").map((a) => a.agent).sort(),
		["balthasar", "casper", "melchior"],
		"every core falls back to the session model when no peer survived",
	);
	assert.equal(r.ok, true);
});

test("an aborted core is never re-run on another model", async () => {
	// A stop that silently respawned work would be a stop that does not stop.
	const { engine, attempts } = brokenModelEngine({ melchior: "anthropic/opus-4-6" }, { failureKind: "abort" });
    const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);
	assert.equal(attempts.filter((a) => a.agent === "melchior").length, 1, "an aborted core is not retried");
});

test("recovery is bounded to one pass — a core broken on every model is not retried forever", async () => {
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> =>
			s.agent === "melchior"
				? { agent: s.agent, output: "", usage: usage(), ok: false, error: "always broken", modelUsed: s.model ?? "?", failureKind: "provider" }
				: { agent: s.agent, output: "ok", structured: { vote: "A", confidence: 0.8 }, usage: usage(), ok: true, modelUsed: s.model ?? "session/base" },
	};
	let calls = 0;
	const counting: StrategyEngine = { run: async (...args) => { calls += 1; return engine.run(...args); } };
	const sdk = makeSDK({
		engine: counting,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);
	assert.equal(calls, 4, `3 cores + exactly 1 recovery, got ${calls}`);
	assert.equal(r.ok, true, "the surviving two still produce a ruling");
});

test("recovery survives the reflection round — the DEFAULT configuration, not just reflect:false", async () => {
	// The reflection round rebuilds every spec from the roster, so a recovery that is not carried
	// into it hands the rescued core back the model that just broke: it fails again, is quarantined
	// as invalid, and the run pays for the retry while LOSING the vote it was meant to save.
	// `reflect` defaults ON, so this is the configuration users actually get.
	const { engine, attempts } = brokenModelEngine({ melchior: "anthropic/opus-4-6" });
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);

	assert.equal(r.ok, true);
	assert.match(r.output, /a=3/, `the recovered core must vote in the final tally: ${r.output}`);
	assert.doesNotMatch(r.output, /invalid excluded/, "a recovered core must not be re-broken and quarantined");
	assert.ok(
		attempts.filter((a) => a.agent === "melchior").every((a, i) => i === 0 || a.model === "anthropic/sonnet-5"),
		`every melchior run after the first must use the rescued model: ${JSON.stringify(attempts.filter((a) => a.agent === "melchior"))}`,
	);
});

test("recovery never spends the child budget the rounds themselves need", async () => {
	// Recovery is an enhancement: 3 cores + 3 recoveries + 3 reflection runs is 9 children against a
	// cap of 8, and exceeding it THROWS out of sdk.agent() — turning a poll that had a ruling into no
	// ruling at all. It must take only what is left and leave the rest failed, honestly.
	const { engine, attempts } = brokenModelEngine({ melchior: "x/one", balthasar: "y/two", casper: "z/three" });
	const logs: string[] = [];
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "x/one", balthasar: "y/two", casper: "z/three" }),
		limits: LIMITS, // maxChildren 8: round 1 (3) + reflection (3) leaves 2 for recovery
		sessionModel: "anthropic/sonnet-5",
		log: (m) => logs.push(m),
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);

	assert.equal(r.ok, true, `the poll must still rule rather than throw: ${r.error ?? ""}`);
	assert.equal(attempts.length <= LIMITS.maxChildren, true, `${attempts.length} children against a cap of ${LIMITS.maxChildren}`);
	assert.match(logs.join(" | "), /no child budget left to retry it/, "a dropped recovery is stated, never silent");
});

test("recovery does not start when the opening round exhausted the token budget", async () => {
	const { engine, attempts } = brokenModelEngine({ melchior: "anthropic/opus-4-6" });
	const logs: string[] = [];
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: { ...LIMITS, budgetTokens: 3 },
		sessionModel: "anthropic/sonnet-5",
		log: (m) => logs.push(m),
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);

	assert.equal(r.ok, true, "the two healthy opening votes still produce a ruling");
	assert.equal(attempts.length, 3, "no recovery starts after the opening round consumes the budget");
	assert.equal(r.usage.input, 3, "usage still bills the opening round exactly once");
	assert.match(logs.join(" | "), /token budget/i, "the skipped recovery is stated");
});

test("magi skips its default reflection when the opening round exhausted the token budget", async () => {
	const { engine, attempts } = brokenModelEngine({ melchior: "anthropic/opus-4-6" });
	const logs: string[] = [];
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: { ...LIMITS, budgetTokens: 3 },
		sessionModel: "anthropic/sonnet-5",
		log: (m) => logs.push(m),
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);

	assert.equal(r.ok, true, "the two healthy opening votes still produce a ruling");
	assert.equal(attempts.length, 3, "neither recovery nor reflection starts after budget exhaustion");
	assert.equal(r.usage.input, 3, "usage bills only the opening round");
	assert.equal(r.structured?.reflected, false, "the result reports what actually ran");
	assert.match(logs.join(" | "), /reflection.*token budget/i, "the skipped reflection is stated");
});

test("recovery rechecks observed token spend before starting the next retry", async () => {
	const { engine, attempts } = brokenModelEngine({ melchior: "x/one", balthasar: "y/two", casper: "z/three" });
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "x/one", balthasar: "y/two", casper: "z/three" }),
		limits: { ...LIMITS, budgetTokens: 4 },
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: { reflect: false } }, sdk);

	assert.equal(attempts.length, 4, "only one retry starts against the one-token observable remainder");
	assert.equal(r.usage.input, 4, "usage includes the opening round and the one affordable retry exactly once");
});

test("with room to spare, every broken core is recovered and votes", async () => {
	const { engine } = brokenModelEngine({ melchior: "x/one", balthasar: "y/two", casper: "z/three" });
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "x/one", balthasar: "y/two", casper: "z/three" }),
		limits: { ...LIMITS, maxChildren: 12 },
		sessionModel: "anthropic/sonnet-5",
	});
	const r = await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	assert.equal(r.ok, true, `recovering every core must yield a ruling: ${r.error ?? ""} / ${r.output}`);
	assert.match(r.output, /a=3/);
});

test("a core that fails its retry too re-runs on its OWN model in reflection, not a phantom override", async () => {
	// Only a SUCCESSFUL retry earns an override; a twice-failed core keeps its roster model so its
	// failure stays honest and attributable to the model it was actually configured with.
	const seen: Array<{ agent: string; model?: string }> = [];
	const engine: StrategyEngine = {
		run: async (s): Promise<AgentResult> => {
			seen.push({ agent: s.agent, ...(s.model ? { model: s.model } : {}) });
			if (s.agent === "melchior") return { agent: s.agent, output: "", usage: usage(), ok: false, error: "always broken", modelUsed: s.model ?? "?", failureKind: "provider" };
			return { agent: s.agent, output: "ok", structured: { vote: "A", confidence: 0.8 }, usage: usage(), ok: true, modelUsed: s.model ?? "?" };
		},
	};
	const sdk = makeSDK({
		engine,
		roster: magiRoster({ melchior: "anthropic/opus-4-6", balthasar: "anthropic/sonnet-5", casper: "openai/gpt-5.6" }),
		limits: LIMITS,
		sessionModel: "anthropic/sonnet-5",
	});
	await magi.run({ task: "decide", roster: "magi", params: {} }, sdk);
	const melchior = seen.filter((a) => a.agent === "melchior");
	assert.equal(melchior.at(-1)?.model, "anthropic/opus-4-6", `reflection must use the roster model after a failed retry: ${JSON.stringify(melchior)}`);
});

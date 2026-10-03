import { test } from "node:test";
import assert from "node:assert/strict";

import { type AgentRunSpec, makeSDK, type StrategyEngine, type StrategySDK } from "../../../src/orchestration/sdk.ts";
import { parseAuxActor } from "../../../src/orchestration/params.ts";
import { knownParams } from "../../../src/orchestration/strategy.ts";
import { compete } from "../../../src/orchestration/strategies/compete.ts";
import { criticLoop } from "../../../src/orchestration/strategies/critic-loop.ts";
import { judge } from "../../../src/orchestration/strategies/judge.ts";
import { synthesize } from "../../../src/orchestration/strategies/synthesize.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

/** Record every leg the strategy spawns, with a per-agent answer factory. */
function recorder(answer: (spec: AgentRunSpec) => Partial<AgentResult> = () => ({})): {
	specs: AgentRunSpec[];
	sdk: (team: string[]) => StrategySDK;
} {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec): Promise<AgentResult> => {
			specs.push(spec);
			return { agent: spec.agent, output: `out:${spec.agent}`, usage: usage(), ok: true, ...answer(spec) };
		},
	};
	return {
		specs,
		sdk: (team) => makeSDK({ engine, roster: { team: (n) => (n === "team" ? team : []) }, limits: LIMITS }),
	};
}

const votes = (s: AgentRunSpec): Partial<AgentResult> => (s.agent === "arbiter" ? { structured: { vote: "A", output: "A wins" } } : {});
const diffs = (): Partial<AgentResult> => ({ output: "my approach\n\n```diff\n+added\n```" });
const approves = (s: AgentRunSpec): Partial<AgentResult> => (s.agent === "skeptic" ? { structured: { stance: "approve" } } : {});

test("judge: an inline judge member reaches the engine with its role and model", async () => {
	const { specs, sdk } = recorder(votes);
	await judge.run(
		{ task: "decide", roster: "team", params: { judge: { agent: "arbiter", role: "Judge on RISK", model: "p/arbiter" } } },
		sdk(["a", "b"]),
	);
	const arbiter = specs.find((s) => s.agent === "arbiter");
	assert.equal(arbiter?.role, "Judge on RISK");
	assert.equal(arbiter?.model, "p/arbiter");
	assert.deepEqual(
		specs.filter((s) => s.agent !== "arbiter").map((s) => s.role),
		[undefined, undefined],
		"panel members are untouched by the arbiter's specialisation",
	);
});

test("judge: a bare judge name still works (backward compatible)", async () => {
	const { specs, sdk } = recorder(votes);
	const r = await judge.run({ task: "decide", roster: "team", params: { judge: "arbiter" } }, sdk(["a", "b"]));
	assert.equal(r.ok, true);
	assert.equal(specs.find((s) => s.agent === "arbiter")?.role, undefined);
});

test("judge: a malformed judge param is diagnosed instead of defaulting", async () => {
	const { sdk } = recorder(votes);
	await assert.rejects(
		() => judge.run({ task: "decide", roster: "team", params: { judge: { role: "no agent" } } }, sdk(["a", "b"])),
		/params\.judge/,
	);
});

test("compete: an inline judge member reaches the engine with its role and model", async () => {
	const { specs, sdk } = recorder((s) => (s.agent === "arbiter" ? { ...votes(s), ...diffs() } : diffs()));
	const r = await compete.run(
		{ task: "T", roster: "team", params: { judge: { agent: "arbiter", role: "Pick on CLARITY", model: "p/arbiter" } } },
		sdk(["w1", "w2"]),
	);
	assert.equal(r.ok, true);
	const arbiter = specs.find((s) => s.agent === "arbiter");
	assert.equal(arbiter?.role, "Pick on CLARITY");
	assert.equal(arbiter?.model, "p/arbiter");
});

test("compete: a malformed judge param is diagnosed instead of defaulting", async () => {
	const { sdk } = recorder(diffs);
	await assert.rejects(
		() => compete.run({ task: "T", roster: "team", params: { judge: 7 } }, sdk(["w1", "w2"])),
		/params\.judge/,
	);
});

test("synthesize: an inline synthesizer member reaches the engine with its role and model", async () => {
	const { specs, sdk } = recorder();
	const r = await synthesize.run(
		{ task: "T", roster: "team", params: { synthesizer: { agent: "writer", role: "MERGE the findings", model: "p/writer" } } },
		sdk(["a", "b"]),
	);
	assert.equal(r.ok, true);
	const final = specs.find((s) => s.agent === "writer");
	assert.equal(final?.role, "MERGE the findings");
	assert.equal(final?.model, "p/writer");
});

test("synthesize: an explicit synthesizer wins the first-roster-agent default", async () => {
	const { specs, sdk } = recorder();
	await synthesize.run(
		{ task: "T", roster: "team", params: { synthesizer: { agent: "writer", role: "MERGE" } } },
		sdk(["a", "b"]),
	);
	assert.deepEqual(specs.map((s) => s.agent), ["a", "b", "writer"]);
});

test("synthesize: a malformed synthesizer is diagnosed, never silently replaced by a panel member", async () => {
	const { specs, sdk } = recorder();
	await assert.rejects(
		() => synthesize.run({ task: "T", roster: "team", params: { synthesizer: { model: "p/writer" } } }, sdk(["a", "b"])),
		/params\.synthesizer/,
	);
	assert.deepEqual(specs, [], "nothing spawned before the diagnostic");
});

test("critic-loop: inline generator and critic members reach the engine with their role and model", async () => {
	const { specs, sdk } = recorder(approves);
	await criticLoop.run(
		{
			task: "T",
			roster: "team",
			params: {
				generator: { agent: "writer", role: "Draft FAST", model: "p/writer" },
				critic: { agent: "skeptic", role: "Attack SAFETY", model: "p/skeptic" },
				rounds: 1,
			},
		},
		sdk(["builder", "skeptic"]),
	);
	const gen = specs.find((s) => s.agent === "writer");
	assert.equal(gen?.role, "Draft FAST");
	assert.equal(gen?.model, "p/writer");
	const critic = specs.find((s) => s.agent === "skeptic");
	assert.equal(critic?.role, "Attack SAFETY");
	assert.equal(critic?.model, "p/skeptic");
});

test("critic-loop: an absent aux param still falls back to the roster's two members", async () => {
	const { specs, sdk } = recorder(approves);
	await criticLoop.run({ task: "T", roster: "team", params: { rounds: 1 } }, sdk(["builder", "skeptic"]));
	assert.deepEqual(specs.map((s) => s.agent), ["builder", "skeptic"]);
});

test("critic-loop: a malformed generator is diagnosed, never silently replaced by a roster member", async () => {
	const { specs, sdk } = recorder(approves);
	await assert.rejects(
		() => criticLoop.run({ task: "T", roster: "team", params: { generator: { model: "p/writer" }, rounds: 1 } }, sdk(["builder", "skeptic"])),
		/params\.generator/,
	);
	assert.deepEqual(specs, []);
});
// ── strict runtime validation of an aux actor member ──────────────────────────────────────

test("parseAuxActor accepts a bare name and a fully-specified, well-typed member", () => {
	assert.deepEqual(parseAuxActor("arbiter", "judge"), { ok: true, spec: { agent: "arbiter" } });
	assert.deepEqual(
		parseAuxActor({ agent: "arbiter", role: "R", model: "p/a", skills: ["x"], tools: ["read"], isolation: "none", mcp: false }, "judge"),
		{ ok: true, spec: { agent: "arbiter", role: "R", model: "p/a", skills: ["x"], tools: ["read"], isolation: "none", mcp: false } },
	);
});

test("parseAuxActor treats absent/blank as unset, and REFUSES a wrongly-typed field", () => {
	assert.equal(parseAuxActor(undefined, "judge"), undefined);
	assert.equal(parseAuxActor("   ", "judge"), undefined, "a blank name is 'not supplied', not a member");
	const cases: Array<[unknown, RegExp]> = [
		[{ agent: "arbiter", tools: ["read", 42] }, /tools/],
		[{ agent: "arbiter", tools: "read" }, /tools/],
		[{ agent: "arbiter", skills: "x" }, /skills/],
		[{ agent: "arbiter", model: 42 }, /model/],
		[{ agent: "arbiter", mcp: "yes" }, /mcp/],
		[{ agent: "arbiter", isolation: "maybe" }, /isolation/],
		[{ agent: "arbiter", nickname: "x" }, /nickname/],
		[{ role: "no agent" }, /agent/],
		[42, /agent name/],
	];
	for (const [value, expected] of cases) {
		const parsed = parseAuxActor(value, "judge");
		assert.ok(parsed && !parsed.ok, `${JSON.stringify(value)} must be refused`);
		if (!parsed || parsed.ok) continue;
		assert.match(parsed.error, /params\.judge/, "the message names the param");
		assert.match(parsed.error, expected);
	}
});

test("a wrongly-typed aux member is refused BEFORE any engine call", async () => {
	const { specs, sdk } = recorder(votes);
	await assert.rejects(
		() => judge.run({ task: "decide", roster: "team", params: { judge: { agent: "arbiter", tools: ["read", 42] } } }, sdk(["a", "b"])),
		/params\.judge.*tools/,
	);
	assert.deepEqual(specs, [], "no panel member ran either");
});

test("critic-loop refuses a wrongly-typed critic before drafting", async () => {
	const { specs, sdk } = recorder(approves);
	await assert.rejects(
		() => criticLoop.run({ task: "T", roster: "team", params: { critic: { agent: "skeptic", mcp: "yes" }, rounds: 1 } }, sdk(["builder", "skeptic"])),
		/params\.critic.*mcp/,
	);
	assert.deepEqual(specs, [], "the generator never drafted a draft that could not be reviewed");
});

// ── declared metadata must be runtime-correct for a participant collector ──────────────────

test("an agent param declares rosterIndex (not a phony agent name) and only a REAL agent default", () => {
	const critic = knownParams("critic-loop");
	assert.ok(critic);
	// The runtime picks roster[0]/roster[1], then the `operator`/`verifier` agents — so
	// `rosterIndex` is the real default and `default` must name an agent that actually runs.
	assert.equal(critic.generator?.type, "agent");
	assert.equal(critic.generator?.rosterIndex, 0);
	assert.equal(critic.generator?.default, "operator");
	assert.equal(critic.critic?.rosterIndex, 1);
	assert.equal(critic.critic?.default, "verifier");

	const synth = knownParams("synthesize");
	assert.equal(synth?.synthesizer?.type, "agent");
	assert.equal(synth?.synthesizer?.rosterIndex, 0, "the default IS roster[0]");
	assert.equal(synth?.synthesizer?.default, undefined, "no phony agent name — a collector would spawn it");

	// A required arbiter has NO fallback at all, in any of the three forms.
	for (const name of ["judge", "compete"]) {
		const param = knownParams(name)?.judge;
		assert.equal(param?.type, "agent", `${name}.judge is agent-typed`);
		assert.equal(param?.rosterIndex, undefined, `${name}.judge never defaults to a panel member`);
		assert.equal(param?.default, undefined, `${name}.judge has no default arbiter`);
	}
});

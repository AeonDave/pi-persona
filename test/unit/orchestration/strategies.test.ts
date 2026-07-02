import { test } from "node:test";
import assert from "node:assert/strict";

import { type AgentRunSpec, makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { compete } from "../../../src/orchestration/strategies/compete.ts";
import { councilRounds } from "../../../src/orchestration/strategies/council-rounds.ts";
import { criticLoop } from "../../../src/orchestration/strategies/critic-loop.ts";
import { debate } from "../../../src/orchestration/strategies/debate.ts";
import { fanout } from "../../../src/orchestration/strategies/fanout.ts";
import { judge } from "../../../src/orchestration/strategies/judge.ts";
import { map } from "../../../src/orchestration/strategies/map.ts";
import { pair } from "../../../src/orchestration/strategies/pair.ts";
import { pipeline } from "../../../src/orchestration/strategies/pipeline.ts";
import { synthesize } from "../../../src/orchestration/strategies/synthesize.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

test("fanout runs every roster agent in parallel and aggregates the results", async () => {
	const calls: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			calls.push(spec.agent);
			return { agent: spec.agent, output: `out:${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "review" ? ["a", "b", "c"] : []) }, limits: LIMITS });
	const r = await fanout.run({ task: "T", roster: "review", params: {} }, sdk);
	assert.deepEqual(calls.sort(), ["a", "b", "c"]);
	assert.equal(r.structured?.count, 3);
	assert.match(r.output, /out:a/);
});

test("the SDK reports per-agent status (running → done) via onAgentStatus", async () => {
	const events: string[] = [];
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStatus: (a, st) => events.push(`${a}:${st}`),
	});
	await sdk.agent({ agent: "melchior", task: "t" });
	assert.deepEqual(events, ["melchior:running", "melchior:done"]);
});

test("the SDK hands the UI a role-disambiguated key so same-agent members are distinct nodes", async () => {
	const keys: string[] = [];
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStatus: (_a, st, _r, key) => {
			if (st === "running" && key) keys.push(key);
		},
	});
	// The `review` team pattern: one `reviewer`, three lenses via role.
	await sdk.agent({ agent: "reviewer", task: "t", role: "Focus ONLY on the SECURITY lens" });
	await sdk.agent({ agent: "reviewer", task: "t", role: "Focus ONLY on the PERFORMANCE lens" });
	await sdk.agent({ agent: "reviewer", task: "t", role: "Focus ONLY on the TESTS lens" });
	assert.deepEqual(keys, ["reviewer · SECURITY", "reviewer · PERFORMANCE", "reviewer · TESTS"]);
});

test("the SDK suffixes #N when the same base key repeats (identical members stay distinct nodes)", async () => {
	const keys: string[] = [];
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStart: (_a, _abort, key) => {
			if (key) keys.push(key);
		},
	});
	await sdk.agent({ agent: "scout", task: "t" });
	await sdk.agent({ agent: "scout", task: "t" });
	assert.deepEqual(keys, ["scout", "scout#2"]);
});

test("the SDK enforces maxChildren regardless of strategy code", async () => {
	const sdk = makeSDK({
		engine: { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) },
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 2 },
	});
	await sdk.agent({ agent: "a", task: "t" });
	await sdk.agent({ agent: "b", task: "t" });
	await assert.rejects(() => sdk.agent({ agent: "c", task: "t" }), /maxChildren/);
});

test("the SDK enforces the token budget across a run", async () => {
	const sdk = makeSDK({
		engine: {
			run: async (s) => ({ agent: s.agent, output: "o", usage: { ...usage(), input: 100, output: 100 }, ok: true }),
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, budgetTokens: 150 },
	});
	await sdk.agent({ agent: "a", task: "t" }); // spends 200 > 150
	await assert.rejects(() => sdk.agent({ agent: "b", task: "t" }), /budget/);
});

test("the SDK exposes a per-agent abort via onAgentStart (engine sees the aborted signal)", async () => {
	let sawAborted: boolean | undefined;
	const sdk = makeSDK({
		engine: {
			run: async (s, _p, signal) => {
				sawAborted = signal?.aborted;
				return { agent: s.agent, output: "o", usage: usage(), ok: true };
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStart: (_a, abort) => abort(), // stop this agent immediately
	});
	await sdk.agent({ agent: "x", task: "t" });
	assert.equal(sawAborted, true, "the engine received the per-agent abort signal");
});

test("the SDK forwards per-agent streaming progress via onAgentProgress", async () => {
	const seen: string[] = [];
	const sdk = makeSDK({
		engine: {
			run: async (s, onProgress) => {
				onProgress?.({ output: "partial", tokens: 5 });
				return { agent: s.agent, output: "final", usage: usage(), ok: true };
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentProgress: (a, p) => seen.push(`${a}:${p.output}:${p.tokens}`),
	});
	await sdk.agent({ agent: "melchior", task: "t" });
	assert.deepEqual(seen, ["melchior:partial:5"]);
});

test("fanout throws when no roster is provided", async () => {
	const engine: StrategyEngine = { run: async () => ({ agent: "x", output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: LIMITS });
	await assert.rejects(() => fanout.run({ task: "T", params: {} }, sdk));
});

test("council-rounds runs more rounds until best-of-X is reached, carrying the debate forward", async () => {
	const team = ["a", "b", "c"];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			const later = spec.task.includes("debate"); // round ≥ 2 carries the prior debate
			const vote = later ? "x" : spec.agent === "a" ? "x" : spec.agent === "b" ? "y" : "z";
			return { agent: spec.agent, output: `${spec.agent}:${vote}`, structured: { vote, confidence: 0.7 }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "t" ? team : []) }, limits: LIMITS });
	const r = await councilRounds.run({ task: "decide", roster: "t", params: { rounds: 3, bestOf: 3 } }, sdk);
	assert.equal(r.structured?.status, "winner");
	assert.equal(r.structured?.rounds, 2, "split in round 1, converged in round 2");
	assert.match(r.output, /best-of-3/);
});

test("council-rounds falls back to best-by-confidence on the final round without a supermajority", async () => {
	const team = ["a", "b", "c"];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			const vote = spec.agent === "a" ? "x" : spec.agent === "b" ? "y" : "z"; // never converges
			const confidence = spec.agent === "b" ? 0.9 : 0.4;
			return { agent: spec.agent, output: spec.agent, structured: { vote, confidence }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => team }, limits: LIMITS });
	const r = await councilRounds.run({ task: "decide", roster: "t", params: { rounds: 2, bestOf: 3 } }, sdk);
	assert.equal(r.structured?.usedFallback, true);
	assert.equal(r.structured?.rounds, 2);
});

test("critic-loop revises while the critic rejects, then stops on approve", async () => {
	let criticCalls = 0;
	let genCalls = 0;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "skeptic") {
				criticCalls++;
				return {
					agent: "skeptic",
					output: "crit",
					structured: { stance: criticCalls < 2 ? "reject" : "approve" },
					usage: usage(),
					ok: true,
				};
			}
			genCalls++;
			return { agent: spec.agent, output: `gen#${genCalls}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["writer"] }, limits: LIMITS });
	const r = await criticLoop.run({ task: "T", roster: "team", params: { critic: "skeptic", rounds: 5 } }, sdk);
	assert.equal(criticCalls, 2, "critic ran twice (reject then approve)");
	assert.equal(genCalls, 2, "generator ran initial + one revision");
	assert.equal(r.output, "gen#2");
});

test("critic-loop takes generator + critic from the roster's two entities by default", async () => {
	const seen: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			seen.push(spec.agent);
			if (spec.agent === "skeptic") {
				return { agent: "skeptic", output: "c", structured: { stance: "approve" }, usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: "draft", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["builder", "skeptic"] }, limits: LIMITS });
	await criticLoop.run({ task: "T", roster: "antagonist", params: {} }, sdk);
	assert.ok(seen.includes("builder"), "generator = roster[0]");
	assert.ok(seen.includes("skeptic"), "critic = roster[1]");
});

test("critic-loop stops at maxRounds even if the critic keeps rejecting", async () => {
	let genCalls = 0;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "skeptic") {
				return { agent: "skeptic", output: "crit", structured: { stance: "reject" }, usage: usage(), ok: true };
			}
			genCalls++;
			return { agent: spec.agent, output: `gen#${genCalls}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["writer"] }, limits: LIMITS });
	await criticLoop.run({ task: "T", roster: "team", params: { critic: "skeptic", generator: "writer", rounds: 2 } }, sdk);
	assert.equal(genCalls, 3, "initial generation + 2 revisions");
});

test("pipeline runs roster agents in sequence, each building on the previous output", async () => {
	const seen: Array<{ agent: string; sawUpstream: boolean }> = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			seen.push({ agent: spec.agent, sawUpstream: spec.task.includes("previous step") });
			return { agent: spec.agent, output: `out:${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "chain" ? ["a", "b", "c"] : []) }, limits: LIMITS });
	const r = await pipeline.run({ task: "T", roster: "chain", params: {} }, sdk);
	assert.deepEqual(seen.map((s) => s.agent), ["a", "b", "c"], "runs in roster order");
	assert.equal(seen[0]?.sawUpstream, false, "first step sees only the task");
	assert.equal(seen[1]?.sawUpstream, true, "second step sees the first's output");
	assert.equal(r.output, "out:c", "the pipeline's answer is the last step's output");
	assert.equal(r.ok, true);
});

test("pipeline stops the chain when a step fails", async () => {
	const seen: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			seen.push(spec.agent);
			return spec.agent === "b"
				? { agent: "b", output: "", usage: usage(), ok: false, error: "boom" }
				: { agent: spec.agent, output: `out:${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b", "c"] }, limits: LIMITS });
	const r = await pipeline.run({ task: "T", roster: "chain", params: {} }, sdk);
	assert.deepEqual(seen, ["a", "b"], "stopped after b failed; c never ran");
	assert.equal(r.ok, false);
});

test("pipeline throws when no roster is provided", async () => {
	const sdk = makeSDK({ engine: { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) }, roster: { team: () => [] }, limits: LIMITS });
	await assert.rejects(() => pipeline.run({ task: "T", params: {} }, sdk));
});

test("judge runs the panel in parallel, then an impartial arbiter picks one (anonymised)", async () => {
	const ran: string[] = [];
	const answers: Record<string, string> = { p1: "use-json", p2: "use-yaml", p3: "use-toml" };
	let arbiterSawIdentities = false;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			ran.push(spec.agent);
			if (spec.agent === "arbiter") {
				if (/\bp1\b|\bp2\b|\bp3\b/.test(spec.task)) arbiterSawIdentities = true; // agent identities must not leak
				assert.match(spec.task, /\[A\]/, "the ballot is label-anonymised");
				return { agent: "arbiter", output: "A wins", structured: { vote: "A", output: "A is best" }, usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: answers[spec.agent] ?? "?", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "panel" ? ["p1", "p2", "p3"] : []) }, limits: LIMITS });
	const r = await judge.run({ task: "decide", roster: "panel", params: { judge: "arbiter" } }, sdk);
	assert.ok(["p1", "p2", "p3"].every((a) => ran.includes(a)), "all panelists answered");
	assert.ok(ran.includes("arbiter"), "the arbiter judged");
	assert.equal(arbiterSawIdentities, false, "the arbiter never saw candidate agent identities");
	assert.equal(r.ok, true);
	assert.match(r.output, /use-(json|yaml|toml)/, "the winner is a panelist's answer (position A, shuffled)");
});

test("judge with params.contract shows each core's structured position (not raw JSON) and picks cleanly", async () => {
	// The Judge persona shape: voting cores (MAGI) emit JSON; with a contract the ballot must
	// carry the readable `output` field, and the winner's output must be that text, not the blob.
	let ballotHadCandidateBlob = false;
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "arbiter") {
				// The candidates' RAW output is `{"result":"<core> ruling",...}` — that blob must
				// not appear in the ballot; only the readable `output` field should. (The arbiter's
				// own "Return JSON ONLY" instruction legitimately contains JSON, so match the blob.)
				if (/\{"result":"\w+ ruling"/.test(spec.task)) ballotHadCandidateBlob = true;
				assert.match(spec.task, /\[A\]/, "ballot is label-anonymised");
				return { agent: "arbiter", output: "A", structured: { vote: "A", output: "A argued it best" }, usage: usage(), ok: true };
			}
			// A voting core: raw output is a JSON blob, structured carries the readable position.
			const pos = `${spec.agent} position`;
			return {
				agent: spec.agent,
				output: JSON.stringify({ result: `${spec.agent} ruling`, vote: "x", output: pos }),
				structured: { result: `${spec.agent} ruling`, vote: "x", output: pos },
				usage: usage(),
				ok: true,
			};
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "magi" ? ["melchior", "balthasar", "casper"] : []) }, limits: LIMITS });
	const r = await judge.run({ task: "decide", roster: "magi", params: { judge: "arbiter", contract: "default" } }, sdk);
	assert.equal(r.ok, true);
	assert.equal(ballotHadCandidateBlob, false, "the arbiter reads readable positions, not candidate JSON blobs");
	assert.match(r.output, /position/, "the winning candidate's output is the readable position text");
	assert.doesNotMatch(r.output.split("— chosen by")[0] ?? "", /\{"result"/, "no JSON blob leaks into the winner");
});

test("judge requires a panel roster and a params.judge arbiter", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "o", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	await assert.rejects(() => judge.run({ task: "t", roster: "panel", params: {} }, sdk), /judge/);
});

test("synthesize fans the roster out, then one synthesiser merges the labeled findings", async () => {
	const ran: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			ran.push(spec.agent);
			if (spec.agent === "writer") {
				assert.match(spec.task, /--- \[g1\] ---/, "the synthesiser sees each gatherer's labeled findings");
				assert.match(spec.task, /finding-from-g2/);
				return { agent: "writer", output: "the merged answer", usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: `finding-from-${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "g" ? ["g1", "g2"] : []) }, limits: LIMITS });
	const r = await synthesize.run({ task: "research X", roster: "g", params: { synthesizer: "writer" } }, sdk);
	assert.deepEqual(ran.slice(0, 2).sort(), ["g1", "g2"], "gatherers ran first, in parallel");
	assert.equal(ran[2], "writer", "the synthesiser ran last");
	assert.equal(r.output, "the merged answer");
	assert.equal(r.structured?.gatherers, 2);
	assert.equal(r.ok, true);
});

test("synthesize defaults the synthesiser to the first roster agent and skips failed gatherers", async () => {
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.task.includes("Findings:")) {
				assert.doesNotMatch(spec.task, /\[broken\]/, "a failed gatherer's section is excluded");
				return { agent: spec.agent, output: "merged", usage: usage(), ok: true };
			}
			if (spec.agent === "broken") return { agent: "broken", output: "", usage: usage(), ok: false, error: "boom" };
			return { agent: spec.agent, output: `ok:${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["lead", "broken"] }, limits: LIMITS });
	const r = await synthesize.run({ task: "T", roster: "g", params: {} }, sdk);
	assert.equal(r.ok, true);
	assert.equal(r.structured?.gatherers, 1, "only the usable gatherer counted");
});

test("synthesize fails cleanly when no gatherer produced output", async () => {
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => ({ agent: spec.agent, output: "", usage: usage(), ok: false, error: "dead" }),
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	const r = await synthesize.run({ task: "T", roster: "g", params: {} }, sdk);
	assert.equal(r.ok, false);
	assert.match(r.output, /no gatherer produced output/);
});

test("map splits into a runtime list, works each item in parallel, and aggregates", async () => {
	const worked: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "splitter") {
				return { agent: "splitter", output: '["alpha","beta","gamma"]', usage: usage(), ok: true };
			}
			worked.push(spec.task.split("sub-item: ")[1] ?? "");
			return { agent: spec.agent, output: `did:${spec.task.split("sub-item: ")[1]}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: (n) => (n === "m" ? ["splitter", "worker"] : []) }, limits: LIMITS });
	const r = await map.run({ task: "process everything", roster: "m", params: {} }, sdk);
	assert.deepEqual(worked.sort(), ["alpha", "beta", "gamma"], "one worker per item");
	assert.equal(r.structured?.count, 3, "aggregated all three");
	assert.equal(r.ok, true);
});

test("map caps the fan-out at params.maxItems and stops cleanly on an empty split", async () => {
	const engine: StrategyEngine = {
		run: async (spec: AgentRunSpec): Promise<AgentResult> => {
			if (spec.agent === "splitter") return { agent: "splitter", output: "not a list", usage: usage(), ok: true };
			return { agent: spec.agent, output: "x", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["splitter"] }, limits: LIMITS });
	const r = await map.run({ task: "t", roster: "m", params: { maxItems: 2 } }, sdk);
	assert.equal(r.ok, false, "no items → not ok");
});

test("debate requires a roster of at least 2", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["solo"] }, limits: LIMITS });
	await assert.rejects(() => debate.run({ task: "T", roster: "x", params: {} }, sdk), /at least 2/);
});

test("debate runs every member with live peer exchange and the protocol delivered via the task", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			return { agent: spec.agent, output: spec.agent, structured: { vote: "x", confidence: 0.8 }, usage: usage(), ok: true };
		},
	};
	const team = [
		{ agent: "reviewer", role: "Focus ONLY on the SECURITY lens" },
		{ agent: "reviewer", role: "Focus ONLY on the PERFORMANCE lens" },
	];
	const sdk = makeSDK({ engine, roster: { team: () => team }, limits: LIMITS });
	const r = await debate.run({ task: "decide", roster: "t", params: {} }, sdk);
	assert.equal(specs.length, 2);
	for (const s of specs) {
		assert.equal(s.peers, true, "peer messaging enabled for every member");
		assert.match(s.task, /contact_peer/, "the protocol (referencing the peer tool) rides the task, not the role");
		assert.match(s.role ?? "", /Focus ONLY on the (SECURITY|PERFORMANCE) lens/, "the member's own lens is preserved on role");
		assert.equal(s.outputContract, "default");
		assert.ok(s.task.startsWith("decide"), "ONE parallel pass — the original task text leads");
		assert.match(s.task, /--- debate protocol ---/, "the task carries the debate protocol");
	}
	assert.equal(r.structured?.status, "winner");
	assert.match(r.output, /DEBATE ruling/);
	assert.equal(r.ok, true);
});

test("debate keeps role UNSET for bare (unspecialised) roster members — the protocol lives in the task", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			return { agent: spec.agent, output: spec.agent, structured: { vote: "x", confidence: 0.8 }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	await debate.run({ task: "decide", roster: "t", params: {} }, sdk);
	assert.equal(specs.length, 2);
	for (const s of specs) {
		assert.equal(s.role, undefined, "a bare member gets no role — matches rosterNodeKeys' base-label seeding");
	}
});

test("debate warns (without clamping) when the roster exceeds maxConcurrency", async () => {
	const logs: string[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => ({ agent: spec.agent, output: spec.agent, structured: { vote: "x", confidence: 0.8 }, usage: usage(), ok: true }),
	};
	const team = ["a", "b", "c", "d", "e"];
	const sdk = makeSDK({ engine, roster: { team: () => team }, limits: { ...LIMITS, maxConcurrency: 2 }, log: (m) => logs.push(m) });
	const r = await debate.run({ task: "decide", roster: "t", params: {} }, sdk);
	assert.ok(logs.some((l) => /batched/.test(l) && /5/.test(l) && /2/.test(l)), `expected a batching warning, got: ${JSON.stringify(logs)}`);
	assert.equal(r.ok, true, "no clamping — every member still ran");
});

test("map with params.peers gives WORKERS peer messaging + cross-talk protocol (splitter stays solo)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "splitter") return { agent: "splitter", output: '["a","b"]', usage: usage(), ok: true };
			return { agent: spec.agent, output: "done", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["splitter", "worker"] }, limits: LIMITS });
	const r = await map.run({ task: "T", roster: "m", params: { peers: true } }, sdk);
	assert.equal(r.ok, true);
	const split = specs.find((s) => s.agent === "splitter");
	const workers = specs.filter((s) => s.agent === "worker");
	assert.equal(split?.peers, undefined, "the splitter runs alone — no peers");
	assert.equal(workers.length, 2);
	for (const w of workers) {
		assert.equal(w.peers, true);
		assert.match(w.task, /contact_peer/, "cross-talk protocol lives in the task text");
	}
});

test("map and synthesize without params.peers leave peers unset (default unchanged)", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "splitter") return { agent: "splitter", output: '["a"]', usage: usage(), ok: true };
			return { agent: spec.agent, output: "x", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["splitter", "worker"] }, limits: LIMITS });
	await map.run({ task: "T", roster: "m", params: {} }, sdk);
	const sdk2 = makeSDK({ engine, roster: { team: () => ["g1", "g2"] }, limits: LIMITS });
	await synthesize.run({ task: "T", roster: "g", params: {} }, sdk2);
	assert.ok(
		specs.every((s) => s.peers === undefined && !s.task.includes("cross-talk")),
		"no peers flag, no protocol by default",
	);
});

test("synthesize with params.peers gives GATHERERS cross-talk but never the synthesizer", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "writer") return { agent: "writer", output: "merged", usage: usage(), ok: true };
			return { agent: spec.agent, output: `finding-${spec.agent}`, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["g1", "g2"] }, limits: LIMITS });
	const r = await synthesize.run({ task: "T", roster: "g", params: { synthesizer: "writer", peers: true } }, sdk);
	assert.equal(r.ok, true);
	const gatherers = specs.filter((s) => s.agent === "g1" || s.agent === "g2");
	const writer = specs.find((s) => s.agent === "writer");
	assert.equal(gatherers.length, 2);
	for (const g of gatherers) {
		assert.equal(g.peers, true);
		assert.match(g.task, /contact_peer/);
	}
	assert.equal(writer?.peers, undefined, "the synthesizer runs after the gatherers — no peers");
});

test("debate honours bestOf and falls back to best-by-confidence without consensus", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => {
			const vote = spec.agent === "a" ? "x" : spec.agent === "b" ? "y" : "z";
			const confidence = spec.agent === "b" ? 0.9 : 0.3;
			return { agent: spec.agent, output: spec.agent, structured: { vote, confidence }, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b", "c"] }, limits: LIMITS });
	const r = await debate.run({ task: "decide", roster: "t", params: { bestOf: 3 } }, sdk);
	assert.equal(r.structured?.usedFallback, true);
	assert.match(r.output, /best-of-3/);
	assert.equal(r.ok, true, "keepBestFallback yields a winner");
});

test("pair runs driver and navigator in parallel with peer messaging and distinct protocols", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			const out = spec.agent === "operator" ? "the implemented work" : "verdict: solid; residual risks: none";
			return { agent: spec.agent, output: out, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["operator", "verifier"] }, limits: LIMITS });
	const r = await pair.run({ task: "build it", roster: "repair", params: {} }, sdk);
	assert.equal(specs.length, 2);
	const drv = specs.find((s) => s.agent === "operator");
	const nav = specs.find((s) => s.agent === "verifier");
	assert.equal(drv?.peers, true);
	assert.equal(nav?.peers, true);
	assert.match(drv?.task ?? "", /DRIVER/);
	assert.match(drv?.task ?? "", /milestone/);
	assert.match(nav?.task ?? "", /NAVIGATOR/);
	assert.match(nav?.task ?? "", /risk checklist/);
	assert.equal(r.ok, true);
	assert.match(r.output, /the implemented work/);
	assert.match(r.output, /--- navigator review \(verifier\) ---/);
	assert.match(r.output, /verdict: solid/);
	assert.equal(r.structured?.driverOk, true);
	assert.equal(r.structured?.navigatorOk, true);
});

test("pair requires a roster of at least 2", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["solo"] }, limits: LIMITS });
	await assert.rejects(() => pair.run({ task: "t", roster: "x", params: {} }, sdk), /driver, navigator/);
});

test("pair stays ok when the navigator fails — the driver's work is the deliverable", async () => {
	const engine: StrategyEngine = {
		run: async (spec) =>
			spec.agent === "verifier"
				? { agent: spec.agent, output: "", usage: usage(), ok: false, error: "died" }
				: { agent: spec.agent, output: "solo work", usage: usage(), ok: true },
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["operator", "verifier"] }, limits: LIMITS });
	const r = await pair.run({ task: "t", roster: "repair", params: {} }, sdk);
	assert.equal(r.ok, true);
	assert.match(r.output, /solo work/);
	assert.doesNotMatch(r.output, /navigator review/);
	assert.equal(r.structured?.navigatorOk, false);
});

test("compete isolates every competitor in a worktree and returns the winning diff in full", async () => {
	const specs: AgentRunSpec[] = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			specs.push(spec);
			if (spec.agent === "arbiter") {
				assert.match(spec.task, /\[A\]/, "the ballot is label-anonymised");
				return { agent: "arbiter", output: "A", structured: { vote: "A", output: "A is cleanest" }, usage: usage(), ok: true };
			}
			const diff = `diff --git a/${spec.agent}.txt b/${spec.agent}.txt\n+x\nEND-${spec.agent}`;
			return { agent: spec.agent, output: `my approach\n\n\`\`\`diff\n${diff}\n\`\`\``, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk);
	assert.equal(r.ok, true);
	const comps = specs.filter((s) => s.agent !== "arbiter");
	assert.equal(comps.length, 2);
	for (const c of comps) {
		assert.equal(c.isolation, "worktree", "every competitor runs isolated");
		assert.match(c.task, /competition protocol/);
	}
	assert.equal(specs.find((s) => s.agent === "arbiter")?.isolation, undefined, "the judge is not isolated");
	assert.match(r.output, /COMPETE winner: (one|two)/, "the shuffle is real — either can sit at A");
	assert.match(r.output, /END-(one|two)/, "the winner's FULL diff is in the result");
	assert.equal(r.structured?.entered, 2);
	assert.equal(r.structured?.valid, 2);
});

test("compete excludes a competitor without a tail diff fence; all excluded ⇒ not ok", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => {
			if (spec.agent === "arbiter") return { agent: "arbiter", output: "A", structured: { vote: "A" }, usage: usage(), ok: true };
			if (spec.agent === "forgetful") return { agent: spec.agent, output: "did stuff, no diff", usage: usage(), ok: true };
			return { agent: spec.agent, output: "sum\n\n```diff\ndiff --git a/w.txt b/w.txt\n+w\n```", usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["forgetful", "worker"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk);
	assert.equal(r.ok, true);
	assert.equal(r.structured?.winner, "worker", "only the fenced candidate could win");
	assert.equal(r.structured?.valid, 1);

	const noneEngine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "no fence", usage: usage(), ok: true }) };
	const sdk2 = makeSDK({ engine: noneEngine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	const r2 = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter" } }, sdk2);
	assert.equal(r2.ok, false);
	assert.match(r2.output, /no competitor delivered a diff/);
});

test("compete clips diffs in the ballot but returns the winner untruncated", async () => {
	let judgeTask = "";
	const long = `diff --git a/big.txt b/big.txt\n${"+x\n".repeat(3000)}TAIL-MARKER`;
	const engine: StrategyEngine = {
		run: async (spec) => {
			if (spec.agent === "arbiter") {
				judgeTask = spec.task;
				return { agent: "arbiter", output: "A", structured: { vote: "A" }, usage: usage(), ok: true };
			}
			return { agent: spec.agent, output: `sum\n\n\`\`\`diff\n${long}\n\`\`\``, usage: usage(), ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: LIMITS });
	const r = await compete.run({ task: "T", roster: "c", params: { judge: "arbiter", ballotDiffChars: 500 } }, sdk);
	assert.match(judgeTask, /\[diff clipped for the ballot/);
	assert.doesNotMatch(judgeTask, /TAIL-MARKER/, "the tail never reaches the ballot");
	assert.match(r.output, /TAIL-MARKER/, "the winner's diff is full in the result");
	assert.equal(r.ok, true);
});

test("compete requires 2+ competitors and params.judge", async () => {
	const engine: StrategyEngine = { run: async (s) => ({ agent: s.agent, output: "", usage: usage(), ok: true }) };
	const sdk = makeSDK({ engine, roster: { team: () => ["a", "b"] }, limits: LIMITS });
	await assert.rejects(() => compete.run({ task: "t", roster: "c", params: {} }, sdk), /params\.judge/);
	const sdk1 = makeSDK({ engine, roster: { team: () => ["solo"] }, limits: LIMITS });
	await assert.rejects(() => compete.run({ task: "t", roster: "c", params: { judge: "j" } }, sdk1), /at least 2/);
});

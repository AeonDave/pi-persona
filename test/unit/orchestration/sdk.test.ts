import { test } from "node:test";
import assert from "node:assert/strict";

import { isInfrastructureFailure, makeSDK, type StrategyEngine, withResultRefs } from "../../../src/orchestration/sdk.ts";
import { createRunBudget } from "../../../src/orchestration/run-budget.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { parseAuxActor } from "../../../src/orchestration/params.ts";
import { parseMembersBlock } from "../../../src/persona/persona.ts";
import { rosterSpec } from "../../../src/orchestration/roster.ts";

const LIMITS = { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const ok = (agent: string): AgentResult => ({ agent, output: `out:${agent}`, usage: usage(), ok: true });

/** An engine that rejects (rather than settling `ok:false`) for the named agents. */
const engineRejectingFor = (...bad: string[]): StrategyEngine => ({
	run: async (spec) => {
		if (bad.includes(spec.agent)) throw new Error(`engine exploded on ${spec.agent}`);
		return ok(spec.agent);
	},
});

test("SDK lifecycle carries frozen exact attempt identity through same-hint legs and model recovery", async () => {
	const seen: Array<{ phase: string; key: string; identity: any }> = [];
	const record = (phase: string, args: unknown[]): void => {
		const identity = args[args.length - 1];
		assert.ok(identity && typeof identity === "object", `${phase} includes the actual attempt identity`);
		assert.equal(Object.isFrozen(identity), true);
		assert.deepEqual(Object.keys(identity).sort(), ["agent", "model", "role", "thinking"]);
		seen.push({ phase, key: args[args.length - 2] as string, identity });
	};
	const sdk = makeSDK({ engine: { run: async (spec, progress, _signal, steer) => {
		progress?.({ output: "progress" });
		steer?.(() => true);
		return spec.model === "broken/model" ? { ...ok(spec.agent), ok: false, failureKind: "provider", modelUsed: spec.model }
			: { ...ok(spec.agent), modelUsed: spec.model! };
	} }, roster: { team: () => [] }, limits: LIMITS, sessionModel: "main/model",
		onAgentStart: (...args: unknown[]) => record("start", args),
		onAgentStatus: (...args: unknown[]) => record(String(args[1]), args),
		onAgentProgress: (...args: unknown[]) => record("progress", args),
		onAgentSteerable: (...args: unknown[]) => record("steer", args),
		onAgentResult: (...args: unknown[]) => record("result", args),
	});
	await sdk.agent({ agent: "reviewer", role: "PI_PERSONA_RESULT_READER_TOKEN", model: "broken/model", thinking: "xhigh", task: "private task", resultRefs: ["private grant"] });
	await sdk.agent({ agent: "reviewer", role: "HEAD", model: "inline/second", thinking: "low", task: "other task" });
	const running = seen.filter((e) => e.phase === "running");
	assert.deepEqual(running.map((e) => [e.identity.role, e.identity.model, e.identity.thinking]), [
		["PI_PERSONA_RESULT_READER_TOKEN", "broken/model", "xhigh"], ["PI_PERSONA_RESULT_READER_TOKEN", "main/model", "xhigh"], ["HEAD", "inline/second", "low"],
	]);
	assert.equal(running[0]!.key, running[1]!.key, "recovery repairs the same logical node");
	assert.notEqual(running[1]!.key, running[2]!.key, "different occurrences remain distinct despite the same neutral hint");
	assert.equal(seen.find((e) => e.phase === "result")!.identity, running[1]!.identity, "terminal capture names the last attempt");
});

// Every leg failure is per-leg: an engine rejection and a run-limit refusal are THAT leg's result,
// so the fan-out keeps its siblings' completed work. Only a user/lifecycle abort cancels legs.

test("SDK forwards thinking from inline/persona members and auxiliary actors through model recovery unchanged", async () => {
	const seen: Array<{ model?: string; thinking?: string }> = [];
	const sdk = makeSDK({
		engine: { run: async (spec) => {
			seen.push({ ...spec });
			return spec.model === "broken/m"
				? { ...ok(spec.agent), ok: false, failureKind: "provider", modelUsed: "broken/m" }
				: { ...ok(spec.agent), modelUsed: "main/m", ...(spec.thinking ? { thinkingRequested: spec.thinking } : {}), thinkingEffective: "high" };
		} },
		roster: { team: () => [] }, limits: LIMITS, sessionModel: "main/m",
	});
	const members = parseMembersBlock([{ agent: "a", thinking: "low" }, { agent: "a", thinking: "high" }]);
	assert.equal(members.ok, true);
	if (!members.ok) return;
	const aux = parseAuxActor({ agent: "arbiter", model: "broken/m", thinking: "xhigh" }, "arbiter");
	assert.ok(aux?.ok);
	const results = await sdk.parallel(members.members.map((member) => () => sdk.agent({ ...rosterSpec(member), task: "t" })));
	const recovered = await sdk.agent({ ...aux.spec, task: "t" });
	assert.deepEqual(seen.map((s) => s.thinking), ["low", "high", "xhigh", "xhigh"]);
	assert.deepEqual(results.map((r) => r.thinkingRequested), ["low", "high"]);
	assert.equal(recovered.thinkingRequested, "xhigh");
	assert.equal(recovered.thinkingEffective, "high");
	assert.deepEqual(recovered.modelRecovery, { from: "broken/m", to: "main/m" });
});

test("a rejecting engine becomes that leg's ok:false result, so the fan-out keeps its siblings' work", async () => {
	const sdk = makeSDK({ engine: engineRejectingFor("b"), roster: { team: () => [] }, limits: LIMITS });
	const results = await sdk.parallel(["a", "b", "c"].map((a) => () => sdk.agent({ agent: a, task: "t" })));

	assert.equal(results.length, 3, "a strategy must still see one result per member");
	assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
	assert.deepEqual(results.map((r) => r.agent), ["a", "b", "c"], "order is preserved");
	assert.equal(results[0]?.output, "out:a", "the completed sibling's work survives");
	assert.equal(results[2]?.output, "out:c");
	assert.match(results[1]?.error ?? "", /engine exploded on b/, "the failed leg carries a usable error");
	assert.equal(results[1]?.failureKind, "agent");
});

test("a contained rejection stays distinguishable from a failure the engine itself reported", async () => {
	// Both arrive as ok:false, but only one is evidence about the agent. Consumers that punish
	// failure (the delegate ledger's permanent veto) key off this to avoid blacklisting a task the
	// harness — not the agent — dropped.
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				if (spec.agent === "crashed") throw new Error("ENOSPC writing the prompt file");
				return { agent: spec.agent, output: "", usage: usage(), ok: false, error: "gave up", failureKind: "agent" };
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
	});
	const crashed = await sdk.agent({ agent: "crashed", task: "t" });
	const reported = await sdk.agent({ agent: "reported", task: "t" });

	assert.equal(crashed.ok, false);
	assert.equal(reported.ok, false);
	assert.equal(isInfrastructureFailure(crashed), true, "the harness broke — not the agent");
	assert.equal(isInfrastructureFailure(reported), false, "the engine reported this one itself");
});

test("a non-Error rejection still yields a usable error string on the failed leg", async () => {
	const sdk = makeSDK({
		engine: { run: async () => Promise.reject("plain string blowup") },
		roster: { team: () => [] },
		limits: LIMITS,
	});
	const r = await sdk.agent({ agent: "a", task: "t" });
	assert.equal(r.ok, false);
	assert.match(r.error ?? "", /plain string blowup/);
});

test("a rejected leg reports 'failed' to the UI WITH its result, not an empty status", async () => {
	const seen: Array<{ status: string; result?: AgentResult }> = [];
	const sdk = makeSDK({
		engine: engineRejectingFor("a"),
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStatus: (_agent, status, result) => seen.push({ status, ...(result ? { result } : {}) }),
	});
	await sdk.agent({ agent: "a", task: "t" });
	assert.deepEqual(seen.map((e) => e.status), ["running", "failed"]);
	assert.equal(seen[1]?.result?.ok, false, "the UI needs the failed result to render the leg");
	assert.match(seen[1]?.result?.error ?? "", /engine exploded/);
});

test("an engine that rejects after the leg was aborted settles as 'abort', so cancellation stays detectable", async () => {
	const sdk = makeSDK({
		engine: { run: async () => Promise.reject(new Error("AbortError")) },
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStart: (_agent, abort) => abort(),
	});
	const r = await sdk.agent({ agent: "a", task: "t" });
	assert.equal(r.failureKind, "abort", "a stopped leg must not masquerade as an agent failure");
});

test("a throwing UI callback must not rewrite a COMPLETED leg into a failure", async () => {
	// The containment is for ENGINE rejections. If the try also covered the post-run bookkeeping,
	// a bug in the host's status callback would discard a finished, already-billed agent result and
	// hand the strategy an ok:false whose "error" is the UI's message — the exact loss the fix exists
	// to prevent, with a lie attached.
	const sdk = makeSDK({
		engine: { run: async (spec) => ok(spec.agent) },
		roster: { team: () => [] },
		limits: LIMITS,
		// Throws only on "done" — the realistic asymmetry: extension.ts's status callback formats the
		// member's OUTPUT (`compactMemberResult`) only when there IS output, so a bug in that render
		// fires on a completed leg and NOT on the synthesised (empty-output) failure.
		onAgentStatus: (_agent, status) => {
			if (status === "done") throw new Error("the tree renderer blew up");
		},
	});
	await assert.rejects(() => sdk.agent({ agent: "a", task: "t" }), /tree renderer blew up/);
});

test("engine-rejection containment does not depend on the status callback surviving", async () => {
	const sdk = makeSDK({
		engine: engineRejectingFor("a"),
		roster: { team: () => [] },
		limits: LIMITS,
		onAgentStatus: () => {
			throw new Error("the tree renderer blew up");
		},
	});
	// A host callback that throws is the host's bug, not the leg's — it must not be laundered into
	// the member result either way.
	await assert.rejects(() => sdk.agent({ agent: "a", task: "t" }), /tree renderer blew up/);
});

test("a maxChildren refusal is that leg's 'limit' result: the engine is never called for it and siblings keep their work", async () => {
	let runs = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			runs += 1;
			return ok(spec.agent);
		},
	};
	const settled: Array<{ agent: string; status: string; result?: AgentResult }> = [];
	const captured: AgentResult[] = [];
	const sdk = makeSDK({
		engine, roster: { team: () => [] }, limits: { ...LIMITS, maxChildren: 2 },
		onAgentStatus: (agent, status, result) => settled.push({ agent, status, ...(result ? { result } : {}) }),
		onAgentResult: (result) => captured.push(result),
	});
	const results = await sdk.parallel(["a", "b", "c"].map((a) => () => sdk.agent({ agent: a, task: "t" })));
	assert.equal(runs, 2, "the refused leg never reaches the engine");
	assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
	assert.equal(results[2]?.failureKind, "limit");
	assert.match(results[2]?.error ?? "", /^not run: .*maxChildren limit \(2\)/);
	assert.deepEqual(settled.filter((e) => e.agent === "c").map((e) => e.status), ["failed"], "the seeded row settles without a fake start");
	assert.equal(settled.find((e) => e.agent === "c")?.result?.failureKind, "limit");
	assert.equal(captured.find((r) => r.agent === "c")?.failureKind, "limit", "the refusal is captured like any final leg");
});

test("canSpawn denies a member before the engine runs and does not consume a child slot", async () => {
	let runs = 0;
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				runs++;
				return ok(spec.agent);
			},
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 1 },
		canSpawn: (agent) => agent !== "ghost",
	});
	const denied = await sdk.agent({ agent: "ghost", task: "t" });
	assert.equal(denied.ok, false);
	assert.match(denied.error ?? "", /may not spawn "ghost"/);
	assert.equal(runs, 0, "a denied spawn never reaches the engine");
	const allowed = await sdk.agent({ agent: "scout", task: "t" });
	assert.equal(allowed.ok, true);
	assert.equal(runs, 1, "the denied attempt did not consume maxChildren");
});

test("a token-budget refusal resolves as a 'limit' result per refused leg, never a rejection", async () => {
	let runs = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			runs++;
			return { agent: spec.agent, output: "o", usage: { ...usage(), input: 200 }, ok: true };
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: { ...LIMITS, budgetTokens: 150 } });
	await sdk.agent({ agent: "a", task: "t" });
	const results = await sdk.parallel(["b", "c"].map((a) => () => sdk.agent({ agent: a, task: "t" })));
	assert.equal(runs, 1);
	assert.deepEqual(results.map((r) => r.failureKind), ["limit", "limit"]);
	assert.match(results[0]?.error ?? "", /token budget \(150\)/);
	assert.doesNotMatch(results[0]?.error ?? "", /maxChildren/, "a token stop is never named as a child limit");
});

/** An engine whose legs stay in flight until their signal aborts (or `release` is called),
 *  recording each leg's signal so a test can see whether a sibling was cancelled. */
function holdingEngine(opts: { tokens?: (agent: string) => number; immediate?: (agent: string) => AgentResult | undefined } = {}) {
	const signals = new Map<string, AbortSignal>();
	const releases = new Map<string, () => void>();
	const engine: StrategyEngine = {
		run: async (spec, _progress, signal) => {
			const immediate = opts.immediate?.(spec.agent);
			if (immediate) return immediate;
			if (!signal) throw new Error("engine did not receive a per-leg signal");
			signals.set(spec.agent, signal);
			const aborted = await new Promise<boolean>((resolve) => {
				if (signal.aborted) return resolve(true);
				signal.addEventListener("abort", () => resolve(true), { once: true });
				releases.set(spec.agent, () => resolve(false));
			});
			const spent = { ...usage(), input: opts.tokens?.(spec.agent) ?? 1 };
			return aborted
				? { agent: spec.agent, output: "", usage: spent, ok: false, error: "aborted", failureKind: "abort" }
				: { agent: spec.agent, output: `out:${spec.agent}`, usage: spent, ok: true };
		},
	};
	return { engine, signals, releases };
}

test("a maxChildren refusal cancels nothing: in-flight siblings finish and keep their results", { timeout: 1000 }, async () => {
	const root = new AbortController();
	const { engine, signals, releases } = holdingEngine();
	const sdk = makeSDK({
		engine,
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 2, maxConcurrency: 3 },
		signal: root.signal,
	});
	const run = Promise.all(["a", "b", "c", "d"].map((agent) => sdk.agent({ agent, task: "t" })));
	while (!releases.has("a") || !releases.has("b")) await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(signals.get("a")?.aborted, false, "in-flight sibling a is not cancelled");
	assert.equal(signals.get("b")?.aborted, false, "in-flight sibling b is not cancelled");
	releases.get("a")!();
	releases.get("b")!();
	const results = await run;
	assert.deepEqual(results.map((r) => r.ok), [true, true, false, false]);
	assert.deepEqual(results.map((r) => r.output), ["out:a", "out:b", "", ""], "the paid siblings' work survives");
	assert.deepEqual(results.slice(2).map((r) => r.failureKind), ["limit", "limit"]);
	assert.equal(signals.has("c") || signals.has("d"), false, "refused legs never reached the engine");
	assert.equal(root.signal.aborted, false, "the caller's signal is untouched");
	assert.equal(sdk.signal, root.signal);
});

test("a token-budget refusal leaves the sibling still running alone", { timeout: 1000 }, async () => {
	const { engine, signals, releases } = holdingEngine({ tokens: (agent) => (agent === "a" ? 200 : 1) });
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: { ...LIMITS, maxConcurrency: 2, budgetTokens: 150 } });
	const run = sdk.parallel(["a", "b", "c"].map((agent) => () => sdk.agent({ agent, task: "t" })));
	while (!releases.has("a") || !releases.has("b")) await new Promise<void>((resolve) => setImmediate(resolve));
	releases.get("a")!();
	while (signals.size < 2) await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(signals.get("b")?.aborted, false, "the budget stop does not cancel b");
	releases.get("b")!();
	const results = await run;
	assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
	assert.equal(results[2]?.failureKind, "limit");
});

test("two SDKs sharing one budget share its children, tokens and concurrency slot", { timeout: 1000 }, async () => {
	const budget = createRunBudget({ ...LIMITS, maxChildren: 2, maxConcurrency: 1 });
	const { engine, releases } = holdingEngine();
	const stopped: string[] = [];
	const a = makeSDK({ engine, roster: { team: () => [] }, budget });
	const b = makeSDK({ engine, roster: { team: () => [] }, budget, onAgentStatus: (agent, status) => { if (status === "failed") stopped.push(agent); } });
	const first = a.agent({ agent: "a1", task: "t" });
	while (!releases.has("a1")) await new Promise<void>((resolve) => setImmediate(resolve));
	const second = b.agent({ agent: "b1", task: "t" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(releases.has("b1"), false, "B waits on the slot A holds");
	assert.deepEqual(b.remaining, { children: 1, tokens: 1000 });
	releases.get("a1")!();
	while (!releases.has("b1")) await new Promise<void>((resolve) => setImmediate(resolve));
	releases.get("b1")!();
	assert.deepEqual((await Promise.all([first, second])).map((r) => r.ok), [true, true]);
	const third = await b.agent({ agent: "b2", task: "t" });
	assert.equal(third.failureKind, "limit", "A's child counts against B");
	assert.deepEqual(stopped, ["b2"]);
	assert.deepEqual(a.remaining, { children: 0, tokens: 998 }, "both SDKs read the one shared spend");
});

test("a per-leg failure (a returned ok:false) does not cancel its siblings", { timeout: 1000 }, async () => {
	const { engine, signals, releases } = holdingEngine({
		immediate: (agent) => (agent === "bad" ? { agent, output: "", usage: usage(), ok: false, error: "gave up", failureKind: "agent" } : undefined),
	});
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: LIMITS });
	const run = sdk.parallel(["bad", "good"].map((agent) => () => sdk.agent({ agent, task: "t" })));
	while (!releases.has("good")) await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(signals.get("good")?.aborted, false, "a sibling's ordinary failure must not cancel the healthy leg");
	releases.get("good")!();
	const results = await run;
	assert.deepEqual(results.map((r) => r.ok), [false, true]);
});

test("an engine rejection releases its SDK slot for the next queued leg", async () => {
	let runs = 0;
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				runs++;
				if (spec.agent === "first") throw new Error("first leg failed");
				return ok(spec.agent);
			},
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, maxConcurrency: 1 },
	});

	const first = sdk.agent({ agent: "first", task: "t" });
	const second = sdk.agent({ agent: "second", task: "t" });
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.ok, false);
	assert.equal(secondResult.ok, true);
	assert.equal(runs, 2, "a rejected leg must not strand the SDK slot");
});

test("the SDK caps parallel overrides and independently launched agents at maxConcurrency", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => setImmediate(resolve));
			inFlight--;
			return ok(spec.agent);
		},
	};
	const sdk = makeSDK({
		engine,
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 20, maxConcurrency: 2 },
	});

	let rawInFlight = 0;
	let rawMaxInFlight = 0;
	await sdk.parallel(
		Array.from({ length: 6 }, () => async () => {
			rawInFlight++;
			rawMaxInFlight = Math.max(rawMaxInFlight, rawInFlight);
			await new Promise<void>((resolve) => setImmediate(resolve));
			rawInFlight--;
		}),
		{ concurrency: 6 },
	);
	assert.equal(rawMaxInFlight, 2, `parallel override should use the configured ceiling: ${rawMaxInFlight}`);

	await sdk.parallel(
		Array.from({ length: 6 }, (_, i) => () => sdk.agent({ agent: `parallel-${i}`, task: "t" })),
		{ concurrency: 6 },
	);
	assert.equal(maxInFlight, 2, `parallel override should use the configured ceiling: ${maxInFlight}`);

	maxInFlight = 0;
	await Promise.all(Array.from({ length: 6 }, (_, i) => sdk.agent({ agent: `direct-${i}`, task: "t" })));
	assert.equal(maxInFlight, 2, `direct Promise.all should use the configured ceiling: ${maxInFlight}`);
});

test("a queued agent rechecks the token budget after it acquires a slot", async () => {
	let releaseFirst = (): void => {};
	let markFirstStarted = (): void => {};
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let runs = 0;
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				runs++;
				if (spec.agent === "first") {
					markFirstStarted();
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return { agent: spec.agent, output: "o", usage: { ...usage(), input: 100 }, ok: true };
			},
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 4, maxConcurrency: 1, budgetTokens: 100 },
	});

	const first = sdk.agent({ agent: "first", task: "t" });
	await firstStarted;
	const second = sdk.agent({ agent: "second", task: "t" });
	releaseFirst();
	await first;
	assert.equal((await second).failureKind, "limit");
	assert.equal(runs, 1, "the queued leg must not start after the first leg exhausts the budget");
});

test("a root abort cancels queued work and reaches the active engine leg", { timeout: 1000 }, async () => {
	const root = new AbortController();
	let markFirstStarted = (): void => {};
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let runs = 0;
	let activeSawAbort = false;
	const sdk = makeSDK({
		engine: {
			run: async (spec, _progress, signal) => {
				runs++;
				if (spec.agent === "first") {
					markFirstStarted();
					await new Promise<void>((resolve) => {
						if (!signal) throw new Error("engine did not receive a per-leg signal");
						if (signal.aborted) {
							resolve();
							return;
						}
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					activeSawAbort = signal?.aborted === true;
					return { agent: spec.agent, output: "", usage: usage(), ok: false, error: "aborted", failureKind: "abort" };
				}
				return ok(spec.agent);
			},
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 4, maxConcurrency: 1 },
		signal: root.signal,
	});

	const first = sdk.agent({ agent: "first", task: "t" });
	await firstStarted;
	const queued = sdk.agent({ agent: "queued", task: "t" });
	root.abort();
	const [firstResult, queuedResult] = await Promise.all([first, queued]);

	assert.equal(activeSawAbort, true, "the root signal must abort the active engine leg");
	assert.equal(firstResult.failureKind, "abort");
	assert.equal(queuedResult.failureKind, "abort");
	assert.equal(runs, 1, "the queued leg must never reach the engine");
});

test("a root abort between a slot grant and the engine seam still prevents the queued leg", async () => {
	const root = new AbortController();
	let markFirstStarted = (): void => {};
	let releaseFirst = (): void => {};
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				if (spec.agent === "first") {
					markFirstStarted();
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return ok(spec.agent);
			},
		},
		roster: { team: () => [] },
		limits: { ...LIMITS, maxChildren: 4, maxConcurrency: 1 },
		signal: root.signal,
	});

	const first = sdk.agent({ agent: "first", task: "t" });
	await firstStarted;
	const queued = sdk.agent({ agent: "queued", task: "t" });
	releaseFirst();
	// The first leg's completion releases the slot, then this queued microtask aborts before
	// Semaphore.with can resume the granted waiter and cross the SDK's engine seam.
	queueMicrotask(() => root.abort());
	const [firstResult, queuedResult] = await Promise.all([first, queued]);

	assert.equal(firstResult.ok, true);
	assert.equal(queuedResult.failureKind, "abort");
});

// ── reference-mode result refs (frozen contract): internal, strategy-strippable ──

test("sdk strips a strategy-supplied resultRefs grant — strategies cannot enlarge it", async () => {
	const seen: Array<readonly string[] | undefined> = [];
	const sdk = makeSDK({
		engine: {
			run: async (spec) => {
				seen.push(spec.resultRefs);
				return ok(spec.agent);
			},
		},
		roster: { team: () => [] },
		limits: LIMITS,
	});
	await sdk.agent({ agent: "a", task: "t", resultRefs: ["result:00000000-0000-4000-8000-00000000000a"] });
	assert.deepEqual(seen, [undefined], "the strategy's own refs never reach the engine");
});

test("sdk strips a strategy-supplied private worker session, including on recovery", async () => {
	const seen: Array<Parameters<StrategyEngine["run"]>[0]> = [];
	const sdk = makeSDK({
		engine: { run: async (spec) => {
			seen.push(spec);
			return seen.length === 1 ? { ...ok(spec.agent), ok: false, failureKind: "provider", modelUsed: "old/model" } : ok(spec.agent);
		} },
		roster: { team: () => [] }, limits: LIMITS, sessionModel: "new/model",
	});
	await sdk.agent({ agent: "a", task: "t", session: { file: "/arbitrary/session.jsonl", resume: true } });
	assert.equal(seen.length, 2);
	assert.ok(seen.every((spec) => !("session" in spec)), "neither attempt may open a strategy-provided session");
});

test("withResultRefs pins a trusted grant at the engine seam (flow reference mode wiring)", async () => {
	const seen: Array<readonly string[] | undefined> = [];
	const engine: StrategyEngine = {
		run: async (spec) => {
			seen.push(spec.resultRefs);
			return ok(spec.agent);
		},
	};
	const refs = ["result:00000000-0000-4000-8000-00000000000a"] as const;
	const sdk = makeSDK({
		engine: withResultRefs(engine, refs),
		roster: { team: () => [] },
		limits: LIMITS,
	});
	// A strategy tries to smuggle its own ref; the trusted wrapper's grant is what runs.
	await sdk.agent({ agent: "a", task: "t", resultRefs: ["result:00000000-0000-4000-8000-00000000ff"] });
	assert.deepEqual(seen, [refs]);
	// The wrapper overrides, it does not union.
	await withResultRefs(engine, []).run({ agent: "b", task: "t", resultRefs: ["result:00000000-0000-4000-8000-00000000000f"] });
	assert.deepEqual(seen.at(-1), []);
});

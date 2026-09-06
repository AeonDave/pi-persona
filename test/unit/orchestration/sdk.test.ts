import { test } from "node:test";
import assert from "node:assert/strict";

import { isInfrastructureFailure, makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const LIMITS = { maxChildren: 8, maxDepth: 2, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 };
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const ok = (agent: string): AgentResult => ({ agent, output: `out:${agent}`, usage: usage(), ok: true });

/** An engine that rejects (rather than settling `ok:false`) for the named agents. */
const engineRejectingFor = (...bad: string[]): StrategyEngine => ({
	run: async (spec) => {
		if (bad.includes(spec.agent)) throw new Error(`engine exploded on ${spec.agent}`);
		return ok(spec.agent);
	},
});

// The per-leg vs. run-fatal boundary: an engine rejection is THIS leg's failure (the fan-out keeps
// its siblings' completed work), while a run-scoped limit breach still stops the whole run.

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

test("a maxChildren breach still rejects the fan-out instead of degrading into a failed member", async () => {
	let runs = 0;
	const engine: StrategyEngine = {
		run: async (spec) => {
			runs += 1;
			return ok(spec.agent);
		},
	};
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: { ...LIMITS, maxChildren: 2 } });
	await assert.rejects(
		() => sdk.parallel(["a", "b", "c"].map((a) => () => sdk.agent({ agent: a, task: "t" }))),
		/maxChildren/,
	);
	assert.equal(runs, 2, "the breach stops the run — it must not keep spawning");
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

test("a token-budget breach still rejects the fan-out instead of degrading into a failed member", async () => {
	const engine: StrategyEngine = {
		run: async (spec) => ({ agent: spec.agent, output: "o", usage: { ...usage(), input: 200 }, ok: true }),
	};
	const sdk = makeSDK({ engine, roster: { team: () => [] }, limits: { ...LIMITS, budgetTokens: 150 } });
	await sdk.agent({ agent: "a", task: "t" });
	await assert.rejects(
		() => sdk.parallel(["b", "c"].map((a) => () => sdk.agent({ agent: a, task: "t" }))),
		/budget/,
	);
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
	await assert.rejects(second, /budget/);
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

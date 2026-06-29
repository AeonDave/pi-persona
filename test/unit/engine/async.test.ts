import { test } from "node:test";
import assert from "node:assert/strict";

import { AsyncRunTracker, buildPeekDigest } from "../../../src/engine/async.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("the tracker caps retained runs by evicting old completed ones", async () => {
	const tracker = new AsyncRunTracker();
	for (let i = 0; i < 40; i++) {
		tracker.launch({ agent: `a${i}`, task: "t" }, async () => ({ agent: `a${i}`, output: "o", usage: usage(), ok: true }));
	}
	await tick();
	await tick();
	assert.ok(tracker.list().length <= 25, `retained ${tracker.list().length} runs (expected ≤ 25)`);
});

test("launch tracks a run and exposes its result on completion", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "scout", task: "explore" }, async (onProgress) => {
		onProgress({ output: "working", turns: 1, tokens: 5 });
		return { agent: "scout", output: "done", usage: usage(), ok: true } satisfies AgentResult;
	});
	assert.match(id, /^run-/);
	await tick();
	const run = tracker.peek(id);
	assert.equal(run?.status, "done");
	assert.equal(run?.result?.output, "done");
});

test("launch passes the run id to the thunk (so the launcher can key a steer handle by it)", async () => {
	const tracker = new AsyncRunTracker();
	let seen: string | undefined;
	const id = tracker.launch({ agent: "a", task: "t" }, async (_onProgress, runId) => {
		seen = runId;
		return { agent: "a", output: "x", usage: usage(), ok: true };
	});
	await tick();
	assert.equal(seen, id, "the thunk receives the same id launch() returned");
});

test("onComplete fires when a run settles", async () => {
	const tracker = new AsyncRunTracker();
	const completed: string[] = [];
	tracker.onComplete((r) => completed.push(r.id));
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({ agent: "a", output: "x", usage: usage(), ok: true }));
	await tick();
	assert.deepEqual(completed, [id]);
});

test("a failing run is marked failed with its error", async () => {
	const tracker = new AsyncRunTracker();
	const id = tracker.launch({ agent: "a", task: "t" }, async () => ({
		agent: "a",
		output: "",
		usage: usage(),
		ok: false,
		error: "boom",
	}));
	await tick();
	assert.equal(tracker.peek(id)?.status, "failed");
	assert.equal(tracker.peek(id)?.error, "boom");
});

test("running() lists only in-flight runs", async () => {
	const tracker = new AsyncRunTracker();
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	tracker.launch({ agent: "a", task: "t" }, async () => {
		await gate;
		return { agent: "a", output: "x", usage: usage(), ok: true };
	});
	assert.equal(tracker.running().length, 1);
	release();
	await tick();
	assert.equal(tracker.running().length, 0);
});

test("buildPeekDigest summarises runs (counts, ids, statuses)", () => {
	const digest = buildPeekDigest([
		{ id: "run-1", agent: "scout", task: "t", status: "running", progress: { output: "", turns: 2, tokens: 30 } },
		{ id: "run-2", agent: "operator", task: "t", status: "done", progress: { output: "", turns: 1, tokens: 10 }, result: { agent: "operator", output: "all good", usage: usage(), ok: true } },
	]);
	assert.match(digest, /2 \(1 running\)/);
	assert.match(digest, /run-1/);
	assert.match(digest, /run-2/);
	assert.match(digest, /all good/);
});

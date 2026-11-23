import { test } from "node:test";
import assert from "node:assert/strict";

import { createRunBudget } from "../../../src/orchestration/run-budget.ts";

const LIMITS = { maxChildren: 2, maxConcurrency: 2, timeoutMs: 1000, budgetTokens: 100 };
const spent = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });

test("admit charges one child per call and refuses at the maxChildren ceiling, naming it", () => {
	const budget = createRunBudget(LIMITS);
	assert.equal(budget.admit(), undefined);
	assert.equal(budget.admit(), undefined);
	const stop = budget.admit();
	assert.equal(stop?.limit, "maxChildren");
	assert.match(stop?.error ?? "", /maxChildren limit \(2\)/);
	assert.deepEqual(budget.remaining, { children: 0, tokens: 100 }, "a refusal consumes nothing");
});

test("admit refuses once completed usage reaches the token budget, naming it", () => {
	const budget = createRunBudget({ ...LIMITS, maxChildren: 10 });
	assert.equal(budget.admit(), undefined);
	budget.charge(spent(60, 40));
	const stop = budget.admit();
	assert.equal(stop?.limit, "budgetTokens");
	assert.match(stop?.error ?? "", /token budget \(100\)/);
	assert.doesNotMatch(stop?.error ?? "", /maxChildren/);
	assert.deepEqual(budget.remaining, { children: 9, tokens: 0 });
});

test("budgetTokens 0 never refuses on tokens and reports unlimited token headroom", () => {
	const budget = createRunBudget({ ...LIMITS, maxChildren: 3, budgetTokens: 0 });
	budget.admit();
	budget.charge(spent(1_000_000));
	assert.equal(budget.admit(), undefined);
	assert.equal(budget.remaining.tokens, Infinity);
	assert.equal(budget.remaining.children, 1);
});

test("recovery headroom counts the caller's reserve plus every queued leg against the children left", () => {
	const budget = createRunBudget({ ...LIMITS, maxChildren: 4 });
	budget.admit();
	assert.equal(budget.recoverySkip(0), undefined, "1 spent + 0 reserved leaves room for a retry");
	const a = Symbol();
	const b = Symbol();
	budget.queued.add(a);
	budget.queued.add(b);
	assert.match(budget.recoverySkip(1) ?? "", /no child budget left to recover it \(maxChildren 4, 3 reserved for remaining work\)/);
	budget.queued.delete(b);
	assert.equal(budget.recoverySkip(1), undefined, "1 spent + 1 reserved + 1 queued still fits under 4");
	budget.charge(spent(100));
	assert.match(budget.recoverySkip(0) ?? "", /token budget exhausted \(100\)/);
});

test("one budget's semaphore bounds every holder to maxConcurrency", async () => {
	const budget = createRunBudget({ ...LIMITS, maxConcurrency: 1 });
	let inFlight = 0;
	let peak = 0;
	const job = () => budget.slots.with(async () => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise<void>((resolve) => setImmediate(resolve));
		inFlight--;
	});
	await Promise.all([job(), job(), job()]);
	assert.equal(peak, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { IdleCompactionPolicy, type IdleCompactionDeadline } from "../../../src/core/idle-compaction.ts";

const IDLE_MS = 15 * 60 * 1_000;
const check = (policy: IdleCompactionPolicy, deadline: IdleCompactionDeadline, percent: number | undefined = 41, quiescent = true, now = deadline.dueAt) =>
	policy.tryAttempt(deadline, { now, percent, quiescent });
function deadlineOf(policy: IdleCompactionPolicy): IdleCompactionDeadline {
	const deadline = policy.deadline;
	assert.ok(deadline);
	return deadline;
}
function idle(policy = new IdleCompactionPolicy({ enabled: true }), now = 100) {
	policy.activity();
	policy.settle(now);
	return { policy, deadline: deadlineOf(policy) };
}

test("disabled by default; enabled episodes require 15 minutes of real idle and strictly over 40 percent", () => {
	const disabled = new IdleCompactionPolicy();
	disabled.activity();
	disabled.settle(0);
	assert.equal(disabled.deadline, undefined);
	const { policy, deadline } = idle();
	assert.equal(deadline.dueAt, 100 + IDLE_MS);
	assert.equal(check(policy, deadline, 41, true, deadline.dueAt - 1), false);
	assert.equal(check(policy, deadline, 40), false);
	assert.equal(check(policy, deadline, 40.000001), true);
});

test("unknown and nonfinite context, invalid time, or nonquiescent adapter defer without consuming", () => {
	const { policy, deadline } = idle();
	for (const percent of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 39.9]) {
		assert.equal(policy.tryAttempt(deadline, { now: deadline.dueAt, percent, quiescent: true }), false);
		assert.deepEqual(policy.deadline, deadline);
	}
	for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(check(policy, deadline, 80, true, now), false);
	assert.equal(check(policy, deadline, 80, false), false);
	assert.deepEqual(policy.deadline, deadline);
	assert.equal(check(policy, deadline, 80), true);
});

test("consumes before launch and never retries the same episode after failure, cancellation or still-high context", () => {
	for (const outcome of ["success", "error", "cancelled", "still-high"]) {
		const { policy, deadline } = idle();
		assert.equal(check(policy, deadline), true, outcome);
		assert.equal(policy.deadline, undefined);
		assert.equal(check(policy, deadline), false, "a concurrent callback must already be vetoed");
		policy.compactionStarted();
		policy.settle(deadline.dueAt + 1);
		assert.equal(policy.deadline, undefined, outcome);
		assert.equal(check(policy, deadline, 99, true, deadline.dueAt + IDLE_MS), false, outcome);
	}
});

test("repeated settlement cannot move a deadline or create an episode without foreground activity", () => {
	const policy = new IdleCompactionPolicy({ enabled: true });
	policy.settle(0);
	assert.equal(policy.deadline, undefined);
	const { deadline } = idle(policy);
	policy.settle(500);
	policy.settle(deadline.dueAt + IDLE_MS);
	assert.deepEqual(policy.deadline, deadline);
});

test("foreground activity invalidates the old deadline and only subsequent settlement can rearm", () => {
	const { policy, deadline } = idle();
	policy.activity();
	assert.equal(policy.deadline, undefined);
	assert.equal(check(policy, deadline, 99), false);
	policy.settle(500);
	const next = deadlineOf(policy);
	assert.notEqual(next.generation, deadline.generation);
	assert.equal(next.dueAt, 500 + IDLE_MS);
	assert.equal(check(policy, deadline, 99, true, next.dueAt), false);
	assert.equal(check(policy, next), true);
	policy.activity();
	policy.settle(next.dueAt + 10);
	assert.equal(check(policy, deadlineOf(policy)), true);
});

test("native or manual compaction consumes the episode even before its deadline or foreground settlement", () => {
	const { policy, deadline } = idle();
	policy.compactionStarted();
	assert.equal(policy.deadline, undefined);
	assert.equal(check(policy, deadline, 99), false);
	policy.settle(deadline.dueAt);
	assert.equal(policy.deadline, undefined);
	policy.activity();
	policy.compactionStarted();
	policy.settle(deadline.dueAt + 1);
	assert.equal(policy.deadline, undefined);
	policy.activity();
	policy.settle(deadline.dueAt + 2);
	assert.ok(policy.deadline);
});

test("reset invalidates session/branch tokens even when the next episode has the same due time", () => {
	const { policy, deadline } = idle();
	policy.reset();
	assert.equal(policy.deadline, undefined);
	policy.settle(100);
	assert.equal(policy.deadline, undefined);
	idle(policy);
	const next = deadlineOf(policy);
	assert.equal(next.dueAt, deadline.dueAt);
	assert.equal(check(policy, deadline), false);
	assert.equal(check(policy, next), true);
});

test("invalid settlement time cannot create a bogus deadline or lose the pending activity", () => {
	const policy = new IdleCompactionPolicy({ enabled: true });
	policy.activity();
	for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		policy.settle(now);
		assert.equal(policy.deadline, undefined);
	}
	policy.settle(200);
	assert.equal(policy.deadline?.dueAt, 200 + IDLE_MS);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyUsage } from "../../../src/engine/stream.ts";
import {
	ChildUsageLedger,
	formatPersonaCostStatus,
	formatTokens,
	formatUsage,
	hasBillableUsage,
	PERSONA_COST_STATUS_KEY,
	toToolUsage,
	toolUsageField,
} from "../../../src/ui/usage.ts";

test("formatTokens scales to k/M", () => {
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(2344), "2.3k");
	assert.equal(formatTokens(12000), "12k");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatUsage shows input/output/cache/cost, omitting zeros", () => {
	assert.equal(
		formatUsage({ input: 10, output: 2344, cacheRead: 12000, cacheWrite: 500, cost: 0.05, contextTokens: 0, turns: 1 }),
		"↑10 ↓2.3k R12k W500 $0.0500",
	);
	assert.equal(
		formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }),
		"",
	);
});

test("toToolUsage puts ChildUsage.cost on Pi cost.total (the field the footer sums)", () => {
	const usage = toToolUsage({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.92, contextTokens: 80, turns: 3 });
	assert.equal(usage.input, 10);
	assert.equal(usage.output, 4);
	assert.equal(usage.cacheRead, 2);
	assert.equal(usage.cacheWrite, 1);
	assert.equal(usage.totalTokens, 17);
	assert.equal(usage.cost.total, 0.92);
	assert.equal(PERSONA_COST_STATUS_KEY, "persona-cost");
});

test("toolUsageField omits usage when the child billed nothing", () => {
	assert.equal(hasBillableUsage(emptyUsage()), false);
	assert.deepEqual(toolUsageField(emptyUsage()), {});
	assert.ok("usage" in toolUsageField({ ...emptyUsage(), cost: 0.001 }));
});

test("formatPersonaCostStatus matches the 1337 frame's $0.423 / $2.50 convention", () => {
	assert.equal(formatPersonaCostStatus(emptyUsage()), undefined);
	assert.equal(formatPersonaCostStatus({ ...emptyUsage(), cost: 0.999 }), "$0.999");
	assert.equal(formatPersonaCostStatus({ ...emptyUsage(), cost: 1.92 }), "$1.92");
});

test("ChildUsageLedger pending is engine-added spend not yet on a tool result", () => {
	const ledger = new ChildUsageLedger();
	ledger.add({ ...emptyUsage(), cost: 0.25, input: 100 });
	ledger.add({ ...emptyUsage(), cost: 0.5, input: 50 });
	assert.equal(ledger.pending().cost, 0.75);
	ledger.account({ ...emptyUsage(), cost: 0.25, input: 100 });
	assert.equal(ledger.pending().cost, 0.5);
	assert.equal(ledger.pending().input, 50);
});

test("ChildUsageLedger account with a key is idempotent so wait+result cannot double-bill", () => {
	const ledger = new ChildUsageLedger();
	const u = { ...emptyUsage(), cost: 0.3 };
	ledger.add(u);
	assert.equal(ledger.account(u, "run-1"), true);
	assert.equal(ledger.account(u, "run-1"), false);
	assert.equal(ledger.pending().cost, 0);
	const fresh = ledger.accountMany([
		{ key: "run-1", usage: u },
		{ key: "run-2", usage: { ...emptyUsage(), cost: 0.2 } },
	]);
	assert.equal(fresh.cost, 0.2);
});

test("ChildUsageLedger reset clears a session's child spend", () => {
	const ledger = new ChildUsageLedger();
	ledger.add({ ...emptyUsage(), cost: 1 });
	ledger.account({ ...emptyUsage(), cost: 1 }, "run-1");
	ledger.reset();
	assert.deepEqual(ledger.pending(), emptyUsage());
	assert.equal(ledger.account({ ...emptyUsage(), cost: 1 }, "run-1"), true);
});

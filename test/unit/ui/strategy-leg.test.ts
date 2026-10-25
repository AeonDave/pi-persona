import assert from "node:assert/strict";
import { test } from "node:test";
import { participantKey } from "../../../src/persona/model-participants.ts";
import { snapshotStrategyModels, strategyLegMetadata } from "../../../src/ui/strategy-leg.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";

test("live metadata uses exact roles, inline occurrences and immutable model assignments", () => {
	const assigned = { [participantKey("reviewer", "HEAD")]: "saved/head", reviewer: "saved/bare" };
	const agents = [{ name: "reviewer", model: "agent/default" }];
	const selection = snapshotStrategyModels({ assigned, agents, sessionModel: "session/default" });
	assigned[participantKey("reviewer", "HEAD")] = "changed/later";
	agents[0]!.model = "changed/agent";
	assert.equal(strategyLegMetadata({ agent: "reviewer", role: "HEAD" }, selection).model, "saved/head");
	assert.equal(strategyLegMetadata({ agent: "reviewer", role: "OTHER" }, selection).model, "saved/bare");
	assert.equal(strategyLegMetadata({ agent: "reviewer", role: "HEAD", model: "inline/second", thinking: "xhigh" }, selection).model, "inline/second");
	assert.equal(strategyLegMetadata({ agent: "reviewer", role: "HEAD", model: "inline/second", thinking: "xhigh" }, selection).thinking, "xhigh");
	assert.equal(strategyLegMetadata({ agent: "reviewer", role: "HEAD" }, selection).thinking, undefined, "undeclared effort is never invented");
});

test("terminal metadata prefers observations and never attaches a stale provider to a different bare model", () => {
	const selection = snapshotStrategyModels({ agents: [], sessionModel: "provider/requested" });
	const identity = { agent: "reviewer", model: "main/requested", thinking: "xhigh" as const };
	const result = { agent: "reviewer", output: "", usage: emptyUsage(), ok: true, thinkingRequested: "xhigh" as const, thinkingEffective: "high" as const };
	assert.deepEqual(strategyLegMetadata(identity, selection, { ...result, modelUsed: "observed/final" }), { agent: "reviewer", model: "observed/final", thinking: "xhigh", thinkingEffective: "high" });
	assert.equal(strategyLegMetadata(identity, selection, { ...result, modelUsed: "requested" }).model, "main/requested");
	assert.equal(strategyLegMetadata(identity, selection, { ...result, modelUsed: "different" }).model, "different");
	assert.equal(strategyLegMetadata(identity, selection, result).model, "main/requested");
	assert.equal(strategyLegMetadata(identity, selection).thinkingEffective, undefined, "a running retry carries no earlier attempt's observation");
});

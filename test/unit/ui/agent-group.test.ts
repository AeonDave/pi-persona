import assert from "node:assert/strict";
import { test } from "node:test";
import { cumulativeUsageLine, groupLegBrief, groupLegMetadata, projectAgentGroup } from "../../../src/ui/agent-group.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type AgentNode, AgentTree } from "../../../src/ui/agent-tree.ts";
import { emptyUsage } from "../../../src/engine/stream.ts";
import { formatUsage } from "../../../src/ui/usage.ts";

function node(id: string, patch: Partial<AgentNode> = {}): AgentNode {
	return { id, label: id, parentId: undefined, status: "running", detail: undefined, ...patch };
}

test("group projection excludes empty phases, nested containers and non-agent work from totals", () => {
	const nodes = [
		node("root", { kind: "flow" }), node("phase", { parentId: "root", kind: "phase" }),
		node("empty", { parentId: "root", kind: "phase" }), node("a", { parentId: "phase", kind: "subagent" }),
		node("b", { parentId: "root", kind: "subagent", status: "failed" }),
		node("watch", { parentId: "root", kind: "monitor" }), node("memory", { parentId: "root", kind: "activity" }),
	];
	const group = projectAgentGroup(nodes, "root")!;
	assert.deepEqual(group.legs.map((leg) => leg.id), ["a", "b"]);
	assert.match(group.summary, /^2 legs · 1 failed · 1 running$/);
	assert.equal(projectAgentGroup(nodes, "missing"), undefined);
});

test("queued legs are counted separately from running workers", () => {
	const group = projectAgentGroup([
		node("root", { kind: "council" }), node("a", { parentId: "root", detail: "queued" }),
		node("b", { parentId: "root" }), node("c", { parentId: "root", status: "done" }),
	], "root")!;
	assert.equal(group.summary, "3 legs · 1 running · 1 queued · 1 done");
});

test("group summaries separate actual supervisor waits from active and queued work", () => {
	const group = projectAgentGroup([
		node("root", { kind: "delegate" }), node("a", { parentId: "root" }),
		node("b", { parentId: "root" }), node("c", { parentId: "root", detail: "queued" }),
	], "root", new Set(["root", "b"]))!;
	assert.equal(group.summary, "3 legs · 1 waiting · 1 running · 1 queued");
});

test("group metadata reserves the effort tag when a long model must shorten", () => {
	const worker = node("a", { model: "provider/a-very-long-model-name", thinking: "xhigh", thinkingEffective: "high" });
	const text = groupLegMetadata(worker, 36);
	assert.ok(visibleWidth(text) <= 36);
	assert.match(text, /xh→h$/);
	assert.match(text, /^model:/);
});

test("briefs show report findings before a trailing archive hint, failures prefer the failure cause", () => {
	const output = "Finding: checks passed\nEvidence: validated\n\nFull archive: intercom result { to: run-1 }";
	assert.match(groupLegBrief(node("a", { status: "done", output })), /Finding: checks passed/);
	assert.doesNotMatch(groupLegBrief(node("a", { status: "done", output })), /Full archive/);
	assert.match(groupLegBrief(node("a", { status: "failed", output, detail: "provider rejected request" })), /provider rejected request/);
});

test("cumulative usage does not appear again as activity or substitute for a missing report", () => {
	const usage = { ...emptyUsage(), input: 123, output: 45 };
	const detail = formatUsage(usage);
	const worker = node("a", { usage, detail });
	assert.equal(cumulativeUsageLine(worker), "cumulative usage: ↑123 ↓45");
	assert.doesNotMatch(groupLegBrief(worker), /↑123/);
	assert.doesNotMatch(groupLegBrief({ ...worker, status: "done" }), /↑123/);
	assert.equal(cumulativeUsageLine(node("unknown")), undefined);
});

test("group projection never adds parent usage to the worker snapshots", () => {
	const tree = new AgentTree(() => 0);
	tree.add({ id: "root", label: "Council", kind: "council", usage: { ...emptyUsage(), input: 9999 } });
	tree.add({ id: "a", label: "Worker", parentId: "root", kind: "subagent", usage: { ...emptyUsage(), input: 123 } });
	const group = projectAgentGroup(tree.snapshot(), "root")!;
	assert.equal(group.legs.length, 1);
	assert.deepEqual(group.legs.map(cumulativeUsageLine), ["cumulative usage: ↑123"]);
});

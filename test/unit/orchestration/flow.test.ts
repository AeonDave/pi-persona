import { test } from "node:test";
import assert from "node:assert/strict";

import { flowHash, parseFlow, topoOrder } from "../../../src/orchestration/flow.ts";
import { parseJournal } from "../../../src/orchestration/flow-journal.ts";
import { runFlow } from "../../../src/orchestration/flow-run.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const flow = (phases: unknown[], name = "f"): string => JSON.stringify({ name, phases });
const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const ok = (agent: string, output: string): AgentResult => ({ agent, output, usage: usage(), ok: true });

test("parseFlow accepts a valid JSON DAG over strategies", () => {
	const r = parseFlow(
		flow([
			{ id: "gather", strategy: "fanout", roster: "review" },
			{ id: "decide", strategy: "magi", needs: ["gather"], params: { aggregate: "majority" } },
		]),
	);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.flow.name, "f");
		assert.equal(r.flow.phases.length, 2);
		assert.deepEqual(r.flow.phases[1]?.needs, ["gather"]);
		assert.equal(r.flow.phases[0]?.roster, "review");
	}
});

test("parseFlow rejects malformed JSON, empty/duplicate/dangling phases", () => {
	assert.equal(parseFlow("not json").ok, false);
	assert.match(parseFlow("not json").ok ? "" : (parseFlow("not json") as { error: string }).error, /JSON/);
	assert.equal(parseFlow(flow([])).ok, false, "empty phases");
	assert.equal(parseFlow(flow([{ id: "a", strategy: "s" }, { id: "a", strategy: "t" }])).ok, false, "duplicate id");
	assert.equal(parseFlow(flow([{ id: "a", strategy: "s", needs: ["ghost"] }])).ok, false, "dangling need");
	assert.equal(parseFlow(flow([{ id: "a" }])).ok, false, "missing strategy");
	assert.equal(parseFlow(JSON.stringify({ phases: [{ id: "a", strategy: "s" }] })).ok, false, "missing name");
});

test("parseFlow rejects a cyclic DAG", () => {
	const r = parseFlow(
		flow([
			{ id: "a", strategy: "s", needs: ["b"] },
			{ id: "b", strategy: "s", needs: ["a"] },
		]),
	);
	assert.equal(r.ok, false);
	assert.match(r.ok ? "" : r.error, /cycle/i);
});

test("topoOrder returns a dependency-respecting order", () => {
	const r = topoOrder([
		{ id: "d", strategy: "s", needs: ["b", "c"] },
		{ id: "b", strategy: "s", needs: ["a"] },
		{ id: "c", strategy: "s", needs: ["a"] },
		{ id: "a", strategy: "s" },
	]);
	assert.equal(r.ok, true);
	if (r.ok) {
		const pos = (id: string) => r.order.indexOf(id);
		assert.ok(pos("a") < pos("b") && pos("a") < pos("c"), "a before b,c");
		assert.ok(pos("b") < pos("d") && pos("c") < pos("d"), "b,c before d");
	}
});

test("topoOrder flags a cycle", () => {
	const r = topoOrder([
		{ id: "a", strategy: "s", needs: ["b"] },
		{ id: "b", strategy: "s", needs: ["a"] },
	]);
	assert.equal(r.ok, false);
});

test("runFlow executes the DAG in dependency order, passing upstream outputs to dependents", async () => {
	const r = parseFlow(
		flow([
			{ id: "a", strategy: "s" },
			{ id: "b", strategy: "s", needs: ["a"] },
			{ id: "c", strategy: "s", needs: ["a"] },
			{ id: "d", strategy: "s", needs: ["b", "c"] },
		]),
	);
	assert.ok(r.ok);
	const ran: string[] = [];
	const outcome = await runFlow(r.flow, "do it", {
		hash: "h",
		runPhase: async ({ phase, upstream }) => {
			ran.push(phase.id);
			return ok(phase.id, `out:${phase.id}(${Object.keys(upstream).sort().join(",")})`);
		},
	});
	assert.equal(outcome.ok, true);
	assert.ok(ran.indexOf("a") < ran.indexOf("b") && ran.indexOf("a") < ran.indexOf("c"), "a before b,c");
	assert.equal(ran.indexOf("d"), ran.length - 1, "d runs last");
	assert.match(outcome.results.d?.output ?? "", /out:d\(b,c\)/, "d sees both upstream outputs");
	assert.match(outcome.output, /out:d/, "d (the sink) is the flow output");
});

test("runFlow journals each completed phase and resumes by skipping journaled ones", async () => {
	const r = parseFlow(flow([{ id: "a", strategy: "s" }, { id: "b", strategy: "s", needs: ["a"] }]));
	assert.ok(r.ok);
	const journal: Array<{ phase: string }> = [];
	const ran: string[] = [];
	await runFlow(r.flow, "t", {
		hash: "h",
		resume: { a: ok("a", "resumed-a") },
		runPhase: async ({ phase }) => {
			ran.push(phase.id);
			return ok(phase.id, `out:${phase.id}`);
		},
		journal: (e) => journal.push(e),
	});
	assert.deepEqual(ran, ["b"], "a was resumed from the journal, only b ran");
	assert.equal(journal.length, 1);
	assert.equal(journal[0]?.phase, "b");
});

test("runFlow blocks dependents when an upstream phase fails", async () => {
	const r = parseFlow(flow([{ id: "a", strategy: "s" }, { id: "b", strategy: "s", needs: ["a"] }]));
	assert.ok(r.ok);
	const outcome = await runFlow(r.flow, "t", {
		hash: "h",
		runPhase: async ({ phase }) =>
			phase.id === "a"
				? { agent: "a", output: "", usage: usage(), ok: false, error: "boom" }
				: ok(phase.id, "out"),
	});
	assert.equal(outcome.ok, false);
	assert.equal(outcome.results.b?.ok, false);
	assert.match(outcome.results.b?.error ?? "", /blocked/);
});

test("runFlow treats a throwing runPhase as a failed phase (not a crashed DAG)", async () => {
	const r = parseFlow(flow([{ id: "a", strategy: "s" }, { id: "b", strategy: "s", needs: ["a"] }]));
	assert.ok(r.ok);
	const outcome = await runFlow(r.flow, "t", {
		hash: "h",
		runPhase: async ({ phase }) => {
			if (phase.id === "a") throw new Error('unknown strategy "nope"');
			return ok(phase.id, "out");
		},
	});
	assert.equal(outcome.ok, false, "the flow is not ok");
	assert.equal(outcome.results.a?.ok, false, "the throwing phase is marked failed");
	assert.match(outcome.results.a?.error ?? "", /unknown strategy "nope"/, "the throw message is preserved");
	assert.match(outcome.results.b?.error ?? "", /blocked/, "its dependent is blocked, not run");
});

test("flowHash is stable across key order and changes with content", () => {
	const a = parseFlow(flow([{ id: "a", strategy: "s", params: { x: 1, y: 2 } }]));
	const b = parseFlow(flow([{ id: "a", strategy: "s", params: { y: 2, x: 1 } }]));
	const c = parseFlow(flow([{ id: "a", strategy: "t" }]));
	assert.ok(a.ok && b.ok && c.ok);
	if (a.ok && b.ok && c.ok) {
		assert.equal(flowHash(a.flow), flowHash(b.flow), "key order doesn't change the hash");
		assert.notEqual(flowHash(a.flow), flowHash(c.flow), "different content → different hash");
	}
});

test("parseJournal folds JSONL into a resume map, honouring hash and re-running failures", () => {
	const lines = [
		JSON.stringify({ phase: "a", hash: "H", ok: true, output: "out-a" }),
		JSON.stringify({ phase: "b", hash: "H", ok: false, output: "" }),
		JSON.stringify({ phase: "c", hash: "OTHER", ok: true, output: "wrong-hash" }),
	].join("\n");
	const resume = parseJournal(lines, "H");
	assert.equal(resume.a?.output, "out-a", "a is resumed");
	assert.equal(resume.b, undefined, "b failed → not resumed (re-runs)");
	assert.equal(resume.c, undefined, "c is for a different flow hash → ignored");
});

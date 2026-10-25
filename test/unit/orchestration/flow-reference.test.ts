/** Flow reference-mode handoff (frozen contract): spec parsing, preview-only task building,
 *  ref-only journaling, archive-backed resume, honest blocking on unavailable refs, and
 *  per-phase direct-ref grants. RED-first coverage for the vertical slice. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { flowRunHash, parseFlow, type FlowSpec } from "../../../src/orchestration/flow.ts";
import { parseJournal } from "../../../src/orchestration/flow-journal.ts";
import { runFlow, type FlowJournalEntry, type FlowPhaseRun } from "../../../src/orchestration/flow-run.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { TerminalResultArchive } from "../../../src/results/archive.ts";
import { readArchivedBody } from "../../../src/results/retrieval.ts";
import type { TerminalResultInput } from "../../../src/results/types.ts";

const usage = () => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
const okWithRef = (agent: string, output: string, ref?: string): AgentResult => ({
	agent, output, usage: usage(), ok: true,
	...(ref ? { resultReceipt: { ref } } : {}),
});
const REF_A = "result:00000000-0000-4000-8000-00000000000a";
const REF_B = "result:00000000-0000-4000-8000-00000000000b";

const referenceFlow = (): FlowSpec =>
	({
		name: "f", handoff: "reference",
		phases: [
			{ id: "one", strategy: "fanout" },
			{ id: "two", strategy: "fanout", needs: ["one"] },
		],
	});

/** A real persistent archive fixture: saves land as session-entry entries. */
function realArchive() {
	const entries: unknown[] = [];
	const archive = new TerminalResultArchive({
		entries: () => entries,
		persistent: true,
		append: (_type, data) => { entries.push({ type: "custom", customType: _type, data: structuredClone(data) }); },
	});
	const save = (originKey: string, body: string): string => {
		const input: TerminalResultInput = {
			originKey, status: "done", agent: "reviewer", body, provenance: "result-output",
		};
		const outcome = archive.save(input);
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		if (!outcome.ok) throw new Error("fixture save failed");
		assert.equal(outcome.storage, "session-entry");
		return outcome.ref;
	};
	return { archive, save };
}

// ── contract 1: FlowSpec.handoff parsing ──────────────────────────────────────

test("parseFlow accepts handoff inline/reference and defaults to inline on omission", () => {
	const base = { phases: [{ id: "one", strategy: "fanout" }] };
	const inline = parseFlow(JSON.stringify({ name: "f", handoff: "inline", ...base }));
	assert.ok(inline.ok);
	if (inline.ok) assert.equal(inline.flow.handoff, "inline");

	const reference = parseFlow(JSON.stringify({ name: "f", handoff: "reference", ...base }));
	assert.ok(reference.ok);
	if (reference.ok) assert.equal(reference.flow.handoff, "reference");

	const omitted = parseFlow(JSON.stringify({ name: "f", ...base }));
	assert.ok(omitted.ok);
	if (omitted.ok) assert.equal(omitted.flow.handoff, undefined);
});

test("parseFlow rejects an invalid handoff value", () => {
	const bad = parseFlow(JSON.stringify({ name: "f", handoff: "by-carrier-pigeon", phases: [{ id: "one", strategy: "fanout" }] }));
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.error, /handoff/);
});

test("handoff participates in run identity: reference and inline are different runs", () => {
	const inline: FlowSpec = { name: "f", phases: [{ id: "one", strategy: "fanout" }] };
	const reference: FlowSpec = { ...inline, handoff: "reference" };
	assert.notEqual(flowRunHash(inline, "t", "/c"), flowRunHash(reference, "t", "/c"));
});

// ── contract 2: preview-only phase task + direct refs ─────────────────────────

test("reference mode builds a preview task: ref + status + read-more hint, never the full body", async () => {
	const longBody = `${"y".repeat(2000)}SECRET-TAIL-${"x".repeat(3000)}`;
	const calls: FlowPhaseRun[] = [];
	await runFlow(referenceFlow(), "base task", {
		hash: "h",
		runPhase: async (run) => {
			calls.push(run);
			return okWithRef(run.phase.id, run.phase.id === "one" ? longBody : "two output", run.phase.id === "one" ? REF_A : REF_B);
		},
	});
	assert.equal(calls.length, 2);
	const downstream = calls.find((c) => c.phase.id === "two")!;
	assert.match(downstream.task, new RegExp(REF_A));
	assert.match(downstream.task, /read_result/);
	assert.match(downstream.task, /"offset"/);
	assert.match(downstream.task, /status: done/);
	assert.doesNotMatch(downstream.task, /SECRET-TAIL/, "the full upstream body must not be embedded");
	assert.match(downstream.task, /yyyy/, "a bounded preview IS embedded");
	assert.deepEqual([...downstream.resultRefs], [REF_A], "the dependent phase is granted exactly its direct upstream ref");
});

test("inline mode stays first-class: the full fenced body is still embedded", async () => {
	const spec: FlowSpec = { name: "f", phases: [{ id: "one", strategy: "fanout" }, { id: "two", strategy: "fanout", needs: ["one"] }] };
	let downstreamTask = "";
	await runFlow(spec, "base task", {
		hash: "h",
		runPhase: async (run) => {
			if (run.phase.id === "two") downstreamTask = run.task;
			return okWithRef(run.phase.id, `${run.phase.id} FULL-BODY output`, REF_A);
		},
	});
	assert.match(downstreamTask, /FULL-BODY/);
});

test("a later phase is granted only its DIRECT needs' refs, never transitive ones", async () => {
	const spec: FlowSpec = {
		name: "f", handoff: "reference",
		phases: [
			{ id: "a", strategy: "fanout" },
			{ id: "b", strategy: "fanout", needs: ["a"] },
			{ id: "c", strategy: "fanout", needs: ["b"] },
		],
	};
	const grants = new Map<string, readonly string[]>();
	await runFlow(spec, "t", {
		hash: "h",
		runPhase: async (run) => {
			grants.set(run.phase.id, run.resultRefs);
			return okWithRef(run.phase.id, `${run.phase.id} out`, `result:00000000-0000-4000-8000-0000000000${run.phase.id}`);
		},
	});
	assert.deepEqual([...(grants.get("b") ?? [])], ["result:00000000-0000-4000-8000-0000000000a"]);
	assert.deepEqual([...(grants.get("c") ?? [])], ["result:00000000-0000-4000-8000-0000000000b"], "c gets b's ref only — a's is transitive");
	assert.deepEqual([...(grants.get("a") ?? [])], []);
});

// ── contract 2: journal stores the ref, not the body ──────────────────────────

test("reference mode journals the ref (+version marker) with an empty body", async () => {
	const lines: FlowJournalEntry[] = [];
	await runFlow(referenceFlow(), "t", {
		hash: "h",
		journal: (e) => lines.push(e),
		runPhase: async (run) => okWithRef(run.phase.id, "FULL REPORT BODY", REF_A),
	});
	const one = lines.find((e) => e.phase === "one");
	assert.ok(one);
	assert.equal(one.resultRef, REF_A);
	assert.equal(one.resultVersion, 1);
	assert.equal(one.output, "", "the body never lands in the journal");
});

// ── contract 2: resume reads via the archive ──────────────────────────────────

test("resume restores a done phase's body from the real archive and grants its ref downstream", async () => {
	const { archive, save } = realArchive();
	const ref = save("origin:one", "ARCHIVED BODY OF PHASE ONE");
	const spec = referenceFlow();
	const hash = flowRunHash(spec, "same task", "/c");
	const journalText = JSON.stringify({ phase: "one", hash, ok: true, output: "", resultRef: ref, resultVersion: 1 }) + "\n";
	const calls: FlowPhaseRun[] = [];
	const outcome = await runFlow(spec, "same task", {
		hash,
		resume: parseJournal(journalText, hash),
		readArchivedResult: (r) => readArchivedBody(archive, r),
		runPhase: async (run) => {
			calls.push(run);
			return okWithRef(run.phase.id, "fresh", REF_B);
		},
	});
	assert.equal(outcome.ok, true);
	assert.equal(calls.length, 1, "the done phase is not re-run");
	assert.equal(calls[0]!.phase.id, "two");
	assert.deepEqual([...calls[0]!.resultRefs], [ref], "the resumed phase's ref is granted to the dependent");
	assert.match(calls[0]!.task, /ARCHIVED BODY OF PHASE ONE/, "the preview comes from the archived body");
});

test("a missing/unreadable historical ref blocks the dependent phase honestly — no respawn, no inline fallback, no re-run", async () => {
	const spec = referenceFlow();
	const hash = flowRunHash(spec, "same task", "/c");
	const ghost = "result:00000000-0000-4000-8000-00000000dead";
	const journalText = JSON.stringify({ phase: "one", hash, ok: true, output: "", resultRef: ghost, resultVersion: 1 }) + "\n";
	const calls: FlowPhaseRun[] = [];
	const outcome = await runFlow(spec, "same task", {
		hash,
		resume: parseJournal(journalText, hash),
		readArchivedResult: (r) => readArchivedBody(realArchive().archive, r),
		runPhase: async (run) => {
			calls.push(run);
			return okWithRef(run.phase.id, "out", REF_B);
		},
	});
	assert.equal(outcome.ok, false);
	assert.equal(calls.length, 0, "neither the done phase nor the blocked dependent runs");
	const blocked = outcome.results["two"];
	assert.ok(blocked);
	assert.equal(blocked.ok, false);
	assert.match(blocked.error ?? "", /reference is unavailable/);
});

test("a phase that completes without an archived ref blocks its dependents with a clear error", async () => {
	const calls: FlowPhaseRun[] = [];
	const outcome = await runFlow(referenceFlow(), "t", {
		hash: "h",
		runPhase: async (run) => {
			calls.push(run);
			// phase one completes ok but its capture produced NO ref (archive save failed)
			return okWithRef(run.phase.id, "body without a ref", run.phase.id === "one" ? undefined : REF_B);
		},
	});
	assert.equal(outcome.ok, false);
	assert.equal(calls.length, 1, "only phase one ran; the dependent was blocked before spawn");
	const blocked = outcome.results["two"];
	assert.ok(blocked);
	assert.equal(blocked.ok, false);
	assert.match(blocked.error ?? "", /without an archived result reference/);
});

test("unknown or missing reference journal versions block resume without reads or respawns", async () => {
	for (const resultVersion of [undefined, 2, "1"]) {
		let reads = 0;
		let runs = 0;
		const spec: FlowSpec = { name: "single", handoff: "reference", phases: [{ id: "one", strategy: "fanout" }] };
		const outcome = await runFlow(spec, "t", {
			hash: "h",
			resume: parseJournal(JSON.stringify({ phase: "one", hash: "h", ok: true, output: "", resultRef: REF_A, resultVersion }), "h"),
			readArchivedResult: () => { reads++; return { ok: true, body: "unverified", status: "done" }; },
			runPhase: async () => { runs++; return okWithRef("one", "unexpected", REF_B); },
		});
		assert.equal(outcome.ok, false, `version ${String(resultVersion)} cannot resume successfully`);
		assert.equal(runs, 0, "completed work must never be paid for again on invalid metadata");
		assert.equal(reads, 0, "unsupported journal formats do not authorize archive reads");
		assert.match(outcome.error ?? "", /version/i);
	}
});

test("a reference to failed or stopped archived work cannot resume as a successful phase", async () => {
	for (const status of ["failed", "stopped"] as const) {
		let runs = 0;
		const outcome = await runFlow(referenceFlow(), "t", {
			hash: "h",
			resume: parseJournal(JSON.stringify({ phase: "one", hash: "h", ok: true, output: "", resultRef: REF_A, resultVersion: 1 }), "h"),
			readArchivedResult: () => ({ ok: true, body: "partial", status }),
			runPhase: async () => { runs++; return okWithRef("two", "unexpected", REF_B); },
		});
		assert.equal(outcome.ok, false);
		assert.equal(runs, 0);
		assert.match(outcome.error ?? "", new RegExp(status));
	}
});

test("invalid reference evidence cannot respawn an unapproved saved checkpoint", async () => {
	for (const version of [1, 2]) {
		let runs = 0;
		const spec: FlowSpec = { name: "gated", handoff: "reference", phases: [{ id: "one", strategy: "fanout", gate: true }] };
		const outcome = await runFlow(spec, "t", {
			hash: "h",
			resume: parseJournal(JSON.stringify({ phase: "one", hash: "h", ok: true, output: "", resultRef: REF_A, resultVersion: version }), "h"),
			readArchivedResult: () => ({ ok: false, error: "missing archive" }),
			runPhase: async () => { runs++; return okWithRef("one", "unexpected", REF_B); },
		});
		assert.equal(runs, 0);
		assert.equal(outcome.ok, false);
	}
});

test("resumed archive truncation stays visible in downstream previews and terminal reports", async () => {
	const resume = parseJournal(JSON.stringify({ phase: "one", hash: "h", ok: true, output: "", resultRef: REF_A, resultVersion: 1 }), "h");
	const calls: FlowPhaseRun[] = [];
	const deps = {
		hash: "h", resume,
		readArchivedResult: () => ({ ok: true as const, body: "stored partial", status: "done" as const, truncated: true }),
		runPhase: async (run: FlowPhaseRun) => { calls.push(run); return okWithRef(run.phase.id, "fresh", REF_B); },
	};
	await runFlow(referenceFlow(), "t", deps);
	assert.match(calls[0]!.task, /retention truncated.*partial/s);
	const sink = await runFlow({ ...referenceFlow(), phases: [referenceFlow().phases[0]!] }, "t", deps);
	assert.equal(sink.results.one?.resultReceipt?.truncated, true);
	assert.match(sink.output, /Archive retention truncated.*partial/);
});

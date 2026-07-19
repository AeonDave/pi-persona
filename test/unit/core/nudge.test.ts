import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_NUDGE_THRESHOLDS, DelegationNudge, PersistenceNudge } from "../../../src/core/nudge.ts";

// Small explicit thresholds keep these tests independent of the tunable defaults:
// a run of 4 substantive commands = a sweep; a command under 10 chars is glue.
const mk = () => new DelegationNudge({ singleHeavyChars: 100, runLength: 4, minStepChars: 10 });

test("stays quiet while the run of hands-on commands is below the sweep threshold", () => {
	const n = mk();
	assert.equal(n.observe("bash", 50), undefined); // run 1
	assert.equal(n.observe("read", 50), undefined); // run 2
	assert.equal(n.observe("grep", 50), undefined); // run 3 (< 4)
});

test("fires on a RUN of substantive hands-on commands (a by-hand sweep)", () => {
	const n = mk();
	n.observe("bash", 50); // run 1
	n.observe("grep", 50); // run 2
	n.observe("curl", 50); // run 3
	const nudge = n.observe("bash", 50); // run 4 ≥ 4 → fires
	assert.ok(nudge, "a run of substantive commands is a sweep");
	assert.match(nudge ?? "", /delegate/i);
	assert.match(nudge ?? "", /in a row/i);
});

test("one big read is NOT a sweep — volume alone never fires (grep-first, not delegate)", () => {
	const n = new DelegationNudge({ singleHeavyChars: 100_000, runLength: 4, minStepChars: 10 });
	// A single huge result: high volume, run of 1. The old volume trigger fired here; repetition doesn't.
	assert.equal(n.observe("read", 50_000), undefined, "a lone big read is reading-budget, not delegation");
});

test("trivial commands (orchestration glue) don't advance the run", () => {
	const n = mk();
	for (let i = 0; i < 12; i++) assert.equal(n.observe("bash", 5), undefined); // size 5 < minStepChars 10
});

test("a glue command mid-sweep doesn't reset the run", () => {
	const n = mk();
	n.observe("bash", 50); // run 1
	n.observe("bash", 5); // glue, run stays 1
	n.observe("grep", 50); // run 2
	n.observe("curl", 50); // run 3
	assert.ok(n.observe("bash", 50), "run reaches 4 despite the glue step"); // run 4
});

test("fires on a single very heavy result (a fat one-shot dump like linpeas/ffuf)", () => {
	const n = new DelegationNudge({ singleHeavyChars: 100, runLength: 99, minStepChars: 10 });
	const nudge = n.observe("bash", 120); // >= singleHeavyChars → fires on its own despite run of 1
	assert.ok(nudge, "a single huge result nudges immediately");
	assert.match(nudge ?? "", /in one result/i);
	assert.match(nudge ?? "", /delegate/i);
});

test("a delegate resets the run — grinding after a hand-off starts fresh", () => {
	const n = mk();
	n.observe("bash", 50); // run 1
	n.observe("bash", 50); // run 2
	n.observe("bash", 50); // run 3 (one short of the sweep)
	assert.equal(n.observe("delegate", 9999), undefined, "the hand-off itself never nudges");
	// Without the reset the next command would be run 4 and fire; after it, the run is 1.
	assert.equal(n.observe("bash", 50), undefined, "run counts from the hand-off");
});

test("council is also a hand-off and resets the run", () => {
	const n = mk();
	n.observe("bash", 50);
	n.observe("bash", 50);
	n.observe("bash", 50);
	assert.equal(n.observe("council", 9999), undefined);
	assert.equal(n.observe("bash", 50), undefined);
});

test("backoff: each un-actioned nudge widens the next run window (early reminder, then de-escalates)", () => {
	const n = mk(); // runLength 4
	for (let i = 0; i < 3; i++) assert.equal(n.observe("bash", 50), undefined); // run 1..3
	assert.ok(n.observe("bash", 50), "first nudge at run 4"); // run 4, fire#1, lastNudgeRun 4, nudges 1
	// The 2nd window is now 2×4 = 8: it needs run 12. The old fixed cadence would have re-fired at run 8.
	for (let i = 0; i < 3; i++) assert.equal(n.observe("bash", 50), undefined); // run 5..7
	assert.equal(n.observe("bash", 50), undefined, "no re-fire at the OLD cadence (run 8)"); // run 8, 8-4=4 < 8
	for (let i = 0; i < 3; i++) assert.equal(n.observe("bash", 50), undefined); // run 9..11
	assert.ok(n.observe("bash", 50), "re-fires only after the WIDENED window"); // run 12, 12-4=8 ≥ 8
});

test("a sweep nudge names the run, not a single dump, and acknowledges non-delegable work", () => {
	const n = new DelegationNudge({ singleHeavyChars: 100_000, runLength: 4, minStepChars: 10 });
	let note: string | undefined;
	for (let i = 0; i < 4 && !note; i++) note = n.observe("bash", 1_000); // 4 substantive, none single-heavy
	assert.ok(note, "a run of substantive commands nudges");
	assert.doesNotMatch(note ?? "", /in one result/, "not framed as a single fat dump");
	assert.match(note ?? "", /in a row/i);
	assert.match(note ?? "", /interactive session a sub-agent can't inherit/i, "acknowledges non-delegable work");
});

test("the single-dump nudge names the burn in tokens and points at delegate", () => {
	const n = new DelegationNudge({ singleHeavyChars: 40_000, runLength: 99, minStepChars: 200 });
	const nudge = n.observe("bash", 48_000); // ~12k tokens single dump
	assert.ok(nudge);
	assert.match(nudge ?? "", /~12k tokens/);
	assert.match(nudge ?? "", /delegate/i);
	assert.match(nudge ?? "", /burns context or budget/i);
});

test("reset() clears the run (new session / persona switch)", () => {
	const n = mk();
	n.observe("bash", 50);
	n.observe("bash", 50);
	n.observe("bash", 50); // run 3, one short of the sweep
	n.reset();
	assert.equal(n.observe("bash", 50), undefined, "run counts from zero after reset");
});

test("default thresholds: a sweep is 8 substantive commands; glue is under 200 chars", () => {
	assert.equal(DEFAULT_NUDGE_THRESHOLDS.singleHeavyChars, 40_000);
	assert.equal(DEFAULT_NUDGE_THRESHOLDS.runLength, 8);
	assert.equal(DEFAULT_NUDGE_THRESHOLDS.minStepChars, 200);
});

// --- PersistenceNudge: the premature-surrender counterweight -----------------------------------

test("PersistenceNudge fires when a delegated leg reports a blocked marker", () => {
	const n = new PersistenceNudge();
	const note = n.observe("delegate", "tried A, B, C. [BLOCKED: need domain creds]");
	assert.ok(note, "an explicit BLOCKED in a leg report nudges the supervisor");
	assert.match(note ?? "", /recovery pass/i);
});

test("PersistenceNudge fires on a CTF give-up (FLAG: UNKNOWN), case/spacing tolerant", () => {
	const n = new PersistenceNudge();
	assert.ok(n.observe("council", "PROOF: none\nFLAG: UNKNOWN"));
	assert.ok(n.observe("delegate", "flag:   unknown"));
	assert.ok(n.observe("delegate", "[blocked: dead end]"));
});

test("PersistenceNudge stays quiet on a clean, successful leg report", () => {
	const n = new PersistenceNudge();
	assert.equal(n.observe("delegate", "done — foothold obtained, PROOF: id → uid=0(root)"), undefined);
});

test("PersistenceNudge ignores the supervisor's own tools — only delegate/council reports", () => {
	const n = new PersistenceNudge();
	// A bash/read result that happens to contain the marker is the supervisor's OWN work, not a leg.
	assert.equal(n.observe("bash", "[BLOCKED: need X]"), undefined);
	assert.equal(n.observe("read", "FLAG: UNKNOWN"), undefined);
});

test("PersistenceNudge.scan is tool-agnostic — the async-completion path (delegate reports arrive as a follow-up, not a delegate tool_result)", () => {
	const n = new PersistenceNudge();
	// Background runs (now the interactive default) deliver their reports via the completion
	// notifier, NOT a delegate/council tool_result — so the surrender check must be reachable
	// without a tool name.
	assert.ok(n.scan("tried A, B, C. [BLOCKED: need domain creds]"), "a blocked async report trips the scan");
	assert.match(n.scan("FLAG: UNKNOWN") ?? "", /recovery pass/i);
	assert.equal(n.scan("done — foothold obtained, PROOF: id → uid=0(root)"), undefined, "a clean report is quiet");
});

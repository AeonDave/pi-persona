import { test } from "node:test";
import assert from "node:assert/strict";

import { DelegationNudge, PersistenceNudge } from "../../../src/core/nudge.ts";

// Small explicit thresholds keep these tests independent of the tunable defaults.
const mk = () => new DelegationNudge({ singleHeavyChars: 100, cumulativeChars: 200 });

test("stays quiet while direct work is below both thresholds", () => {
	const n = mk();
	assert.equal(n.observe("bash", 50), undefined);
	assert.equal(n.observe("read", 50), undefined); // burn 100, still < cumulative 200
	assert.equal(n.observe("grep", 40), undefined); // burn 140
});

test("fires on a single very heavy result (a fat dump like linpeas/ffuf)", () => {
	const n = mk();
	const nudge = n.observe("bash", 120); // >= singleHeavyChars → fires on its own
	assert.ok(nudge, "a single huge result nudges immediately");
	assert.match(nudge ?? "", /delegate/i);
});

test("fires on cumulative burn from several moderate results (iterative grinding)", () => {
	const n = mk();
	assert.equal(n.observe("bash", 80), undefined); // burn 80
	assert.equal(n.observe("bash", 80), undefined); // burn 160
	const nudge = n.observe("bash", 80); // burn 240 ≥ 200 → fires
	assert.ok(nudge, "accumulated hand-grinding crosses the cumulative window");
});

test("a delegate resets the streak — grinding after a hand-off starts fresh", () => {
	const n = mk();
	// Sub-single commands (< 100) so only the cumulative window is in play.
	n.observe("bash", 80); // burn 80
	n.observe("bash", 80); // burn 160 (near the 200 window, no nudge yet)
	assert.equal(n.observe("delegate", 9999), undefined, "the hand-off itself never nudges");
	// Had it not reset, 160 + 80 = 240 ≥ 200 would fire; after the reset it's just 80.
	assert.equal(n.observe("bash", 80), undefined, "streak reset: burn counts from the hand-off");
});

test("council is also a hand-off and resets the streak", () => {
	const n = mk();
	n.observe("bash", 80);
	n.observe("bash", 80);
	assert.equal(n.observe("council", 9999), undefined);
	assert.equal(n.observe("bash", 80), undefined);
});

test("re-arms after another cumulative window (not once-per-session, not once-per-command)", () => {
	const n = mk();
	// Sub-single commands so the SINGLE threshold never fires — only the cumulative window does.
	assert.equal(n.observe("bash", 80), undefined); // burn 80
	assert.equal(n.observe("bash", 80), undefined); // burn 160
	assert.ok(n.observe("bash", 80), "first nudge when the window is crossed"); // burn 240 ≥ 200, lastNudgeAt 240
	assert.equal(n.observe("bash", 80), undefined, "quiet just after firing"); // 320, 320-240=80 < 200
	assert.equal(n.observe("bash", 80), undefined); // 400, 400-240=160 < 200
	assert.ok(n.observe("bash", 80), "fires again once another window is burned"); // 480, 480-240=240 ≥ 200
});

test("the nudge names the burn in tokens and points at delegate", () => {
	const n = new DelegationNudge({ singleHeavyChars: 40_000, cumulativeChars: 60_000 });
	const nudge = n.observe("bash", 48_000); // ~12k tokens single dump
	assert.ok(nudge);
	assert.match(nudge ?? "", /~12k tokens/);
	assert.match(nudge ?? "", /delegate/i);
	assert.match(nudge ?? "", /burns context or budget/i);
});

test("reset() clears the streak (new session / persona switch)", () => {
	const n = mk();
	n.observe("bash", 80);
	n.observe("bash", 80); // burn 160, near the window
	n.reset();
	assert.equal(n.observe("bash", 80), undefined, "burn counts from zero after reset");
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

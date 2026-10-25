import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLedgerEvent, commitLedgerEvent, emptyLedger, loadLedger, parseLedger, pendingAsksTo, pruneLedger, type LedgerState } from "../../../src/exocom/ledger.ts";
import { collaborationStatus, offerStatus } from "../../../src/exocom/collaboration.ts";
import { frameSigningPayload, isSemanticFrame, type ExocomSemanticFrame } from "../../../src/exocom/envelope.ts";

const ts = "2026-10-25T00:00:00.000Z";
const base = { from_session: "a", from_name: "invented", ts, task_id: "create" };
const create = { ...base, kind: "task_create", work_key: "inventory", description: "Inspect inventory", write_set: ["src/inventory.ts"], msg_id: "create" } as const;
function apply(state: LedgerState, raw: unknown): LedgerState {
	const result = applyLedgerEvent(state, raw as ExocomSemanticFrame);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}
const take = (from_session = "b", msg_id = "take") => ({ ...base, from_session, kind: "task_take", work_key: "inventory", msg_id });

test("voluntary pickup reserves task and write claim atomically; second pickup and overlaps fail", () => {
	const opened = apply(emptyLedger(), create);
	assert.deepEqual(pendingAsksTo(opened, "b"), []);
	const taken = apply(opened, take());
	assert.equal(taken.claims[0]?.from_session, "b");
	assert.equal(collaborationStatus(taken.collaboration!.tasks[0]!), "taken");
	assert.equal(applyLedgerEvent(taken, take("c", "second") as ExocomSemanticFrame).ok, false);
	const claimed = apply(opened, { ...base, kind: "claim", work_key: "other", write_set: ["src"], slice: "other", msg_id: "claim" });
	assert.equal(applyLedgerEvent(claimed, take() as ExocomSemanticFrame).ok, false);
	assert.equal(claimed.collaboration!.tasks[0]!.taken, undefined);
});

test("readonly task completion and release need no write claim; release never reopens a task", () => {
	const opened = apply(emptyLedger(), { ...create, write_set: [] });
	const taken = apply(opened, take());
	assert.equal(taken.claims.length, 0);
	const released = apply(taken, { ...base, from_session: "b", kind: "release", work_key: "inventory", msg_id: "release" });
	assert.equal(collaborationStatus(released.collaboration!.tasks[0]!), "stale");
	assert.equal(applyLedgerEvent(released, take("c", "takeover") as ExocomSemanticFrame).ok, false);
});

test("an existing same-session claim is preserved when task pickup fails", () => {
	const opened = apply(emptyLedger(), create);
	const claimed = apply(opened, { ...base, from_session: "b", kind: "claim", work_key: "inventory", write_set: ["other.ts"], slice: "independent", msg_id: "prior" });
	assert.equal(applyLedgerEvent(claimed, take() as ExocomSemanticFrame).ok, false);
	assert.equal(claimed.claims[0]?.msg_id, "prior");
	assert.equal(claimed.collaboration!.tasks[0]?.taken, undefined);
});

test("task creation, offer lifetime and bounded evidence retention reject invalid input", () => {
	assert.equal(applyLedgerEvent(emptyLedger(), { ...create, write_set: ["../escape"] } as unknown as ExocomSemanticFrame).ok, false);
	const state = apply(emptyLedger(), create);
	assert.equal(isSemanticFrame({ ...base, kind: "offer", offer_id: "late", work_key: "inventory", expires_at: "2026-10-27T00:00:00.000Z", msg_id: "late" }), false);
	let bounded = state;
	let refused = false;
	for (let i = 0; i < 65; i++) {
		const result = applyLedgerEvent(bounded, { ...base, kind: "publish", work_key: "inventory", title: "Evidence", excerpt: "E".repeat(4096), msg_id: `evidence-${i}` });
		if (!result.ok) { assert.match(result.error, /budget/); refused = true; break; }
		bounded = result.state;
	}
	assert.equal(refused, true);
	assert.ok(bounded.collaboration!.evidence.length > 0);
});

test("a corrupt collaboration snapshot fails closed rather than dropping task ownership", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-collaboration-corrupt-"));
	const file = join(dir, "ledger.jsonl");
	try {
		for (const event of [create, take()]) assert.equal(commitLedgerEvent(file, event as ExocomSemanticFrame, { compactAtBytes: 1 }).ok, true);
		const snapshot = JSON.parse(readFileSync(file, "utf8")) as { collaboration: { tasks: Array<{ taken: { from_session: string } }> } };
		snapshot.collaboration.tasks[0]!.taken.from_session = "forged";
		assert.throws(() => parseLedger(JSON.stringify(snapshot)), /malformed ledger snapshot/);
		writeFileSync(file, JSON.stringify(snapshot));
		assert.equal(commitLedgerEvent(file, { ...base, kind: "publish", work_key: "inventory", title: "Evidence", excerpt: "A finding", msg_id: "publish" }).ok, false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offers expire without asking or gating and task progress belongs to the taker", () => {
	let state = apply(emptyLedger(), create);
	state = apply(state, { ...base, kind: "offer", offer_id: "o1", work_key: "inventory", to_session: "b", expires_at: "2026-10-25T00:01:00.000Z", msg_id: "offer" });
	assert.equal(offerStatus(state.collaboration!.offers[0]!, Date.parse(ts) + 60_000), "expired");
	assert.equal(state.asks.length, 0);
	state = apply(state, take());
	const progress = { ...base, from_session: "b", kind: "progress", work_key: "inventory", note: "Verified inputs", msg_id: "progress" };
	state = apply(state, progress);
	assert.equal(state.collaboration!.tasks[0]!.progress?.note, "Verified inputs");
	assert.equal(applyLedgerEvent(state, { ...progress, from_session: "c", msg_id: "spoof" } as ExocomSemanticFrame).ok, false);
});

test("a vanished participant makes pickup visibly stale without silent takeover", () => {
	const taken = apply(apply(emptyLedger(), create), take());
	const pruned = pruneLedger(taken, { now: Date.parse(ts), ttlMs: 1000, liveSessions: new Set(["a", "c"]) });
	assert.equal(collaborationStatus(pruned.collaboration!.tasks[0]!), "stale");
	assert.equal(pruned.claims.length, 0);
	assert.equal(applyLedgerEvent(pruned, take("c", "takeover") as ExocomSemanticFrame).ok, false);
});

test("retention keeps first stale time, expires terminal facts and frees bounded slots without reopening", () => {
	const now = Date.parse(ts);
	let state = apply(apply(emptyLedger(), create), take());
	state = apply(state, { ...base, kind: "publish", work_key: "inventory", title: "Evidence", excerpt: "A finding", msg_id: "publish" });
	state = pruneLedger(state, { now, ttlMs: 1000, liveSessions: new Set(["a"]) });
	assert.equal(state.collaboration!.tasks[0]?.staleAt, now);
	state = pruneLedger(state, { now: now + 999, ttlMs: 1000, liveSessions: new Set(["a"]) });
	assert.equal(state.collaboration!.tasks[0]?.staleAt, now);
	assert.equal(state.collaboration!.tasks.length, 1);
	state = pruneLedger(state, { now: now + 1001, ttlMs: 1000, liveSessions: new Set(["a"]) });
	assert.equal(state.collaboration!.tasks.length, 0);
	assert.equal(state.collaboration!.evidence.length, 0);
	assert.equal(applyLedgerEvent(state, { ...create, msg_id: "new-task" } as unknown as ExocomSemanticFrame).ok, true);
});

test("offer retention follows expiry while a live open task remains available", () => {
	let state = apply(emptyLedger(), { ...create, write_set: [] });
	state = apply(state, { ...base, kind: "offer", offer_id: "o1", work_key: "inventory", expires_at: "2026-10-25T00:01:00.000Z", msg_id: "offer" });
	const now = Date.parse(ts) + 60_000;
	state = pruneLedger(state, { now, ttlMs: 1000, liveSessions: new Set(["a"]) });
	assert.equal(offerStatus(state.collaboration!.offers[0]!, now), "expired");
	state = pruneLedger(state, { now: now + 1001, ttlMs: 1000, liveSessions: new Set(["a"]) });
	assert.equal(state.collaboration!.offers.length, 0);
	assert.equal(collaborationStatus(state.collaboration!.tasks[0]!), "open");
});

test("persisted staleAt survives later read clocks and completed task expiry removes related offers", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-collaboration-retention-"));
	const file = join(dir, "ledger.jsonl");
	const now = Date.parse(ts);
	try {
		for (const event of [create, take()]) assert.equal(commitLedgerEvent(file, event as ExocomSemanticFrame).ok, true);
		const pulse: ExocomSemanticFrame = { from_session: "a", from_name: "invented", ts, kind: "progress", work_key: "unrelated", note: "pulse", msg_id: "pulse" };
		assert.equal(commitLedgerEvent(file, pulse, { prune: { now, ttlMs: 1000, liveSessions: new Set(["a"]) } }).ok, true);
		const saved = loadLedger(file);
		assert.equal(saved.collaboration!.tasks[0]?.staleAt, now);
		assert.equal(pruneLedger(saved, { now: now + 500, ttlMs: 1000, liveSessions: new Set(["a"]) }).collaboration!.tasks[0]?.staleAt, now);
		let done = apply(emptyLedger(), { ...create, write_set: [] });
		done = apply(done, { ...base, kind: "offer", offer_id: "o1", work_key: "inventory", expires_at: "2026-10-25T00:01:00.000Z", msg_id: "offer" });
		done = apply(done, take());
		done = apply(done, { ...base, from_session: "b", kind: "task_finish", work_key: "inventory", outcome: "done", note: "Complete", msg_id: "done" });
		const expired = pruneLedger(done, { now: now + 1001, ttlMs: 1000, liveSessions: new Set(["a", "b"]) });
		assert.equal(expired.collaboration!.tasks.length, 0);
		assert.equal(expired.collaboration!.offers.length, 0, "orphan offers never poison the next snapshot");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transaction admission checks write authority against the actual locked task definition", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-collaboration-admission-"));
	const file = join(dir, "ledger.jsonl");
	try {
		assert.equal(commitLedgerEvent(file, create as unknown as ExocomSemanticFrame).ok, true);
		const refused = commitLedgerEvent(file, take() as ExocomSemanticFrame, { canClaim: false });
		assert.equal(refused.ok, false);
		assert.equal(loadLedger(file).claims.length, 0);
		assert.equal(loadLedger(file).collaboration!.tasks[0]?.taken, undefined);
		const readonly = { ...create, work_key: "readonly", write_set: [], msg_id: "readonly" };
		assert.equal(commitLedgerEvent(file, readonly as ExocomSemanticFrame, { canClaim: false }).ok, true);
		assert.equal(commitLedgerEvent(file, { ...take(), work_key: "readonly", task_id: "readonly", msg_id: "readonly-take" } as ExocomSemanticFrame, { canClaim: false }).ok, true);
		const beforeReplacement = loadLedger(file).collaboration!.tasks.find((task) => task.created.work_key === "readonly")!;
		assert.equal(beforeReplacement.created.write_set.length, 0, "an earlier preflight permits advisory pickup");
		assert.equal(commitLedgerEvent(file, { ...base, from_session: "b", kind: "task_finish", work_key: "readonly", task_id: "readonly", outcome: "done", note: "Done", msg_id: "readonly-finished" }).ok, true);
		const replacement = { ...create, work_key: "readonly", msg_id: "replacement", write_set: ["replacement.ts"] };
		assert.equal(commitLedgerEvent(file, replacement as ExocomSemanticFrame, {
			prune: { now: Date.parse(ts) + 2000, ttlMs: 1000, liveSessions: new Set(["a", "b"]) },
		}).ok, true);
		assert.equal(commitLedgerEvent(file, { ...take(), work_key: "readonly", msg_id: "stale-preflight-take" } as ExocomSemanticFrame, { canClaim: false }).ok, false,
			"a task replaced after preflight cannot acquire write authority");
		assert.equal(loadLedger(file).collaboration!.tasks.find((task) => task.created.work_key === "readonly")?.taken, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle growth is reserved so a full task ledger remains reloadable after stale reconciliation", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-collaboration-growth-"));
	const file = join(dir, "ledger.jsonl");
	try {
		for (let i = 0; i < 64; i++) {
			const result = commitLedgerEvent(file, { ...base, kind: "task_create", work_key: `task-${i}`, description: "x".repeat(1900), write_set: [], msg_id: `create-${i}` });
			if (!result.ok) break;
		}
		const result = commitLedgerEvent(file, { kind: "progress", work_key: "pulse", from_session: "a", from_name: "invented", ts, note: "pulse", msg_id: "growth-prune" },
			{ prune: { now: Date.parse(ts), ttlMs: 1000, liveSessions: new Set() }, compactAtBytes: 1 });
		assert.equal(result.ok, true);
		assert.doesNotThrow(() => loadLedger(file));
		assert.ok(loadLedger(file).collaboration!.tasks.every((task) => task.stale));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retained evidence ids stay idempotent and reject conflicts after rolling dedup history expires", () => {
	let state = apply(emptyLedger(), { ...create, write_set: [] });
	const published = { ...base, kind: "publish", work_key: "inventory", title: "Evidence", excerpt: "original", msg_id: "published" };
	state = apply(state, published);
	for (let i = 0; i < 4097; i++) state = apply(state, { kind: "progress", work_key: "other", from_session: "a", from_name: "invented", ts, note: "pulse", msg_id: `pulse-${i}` });
	state = apply(state, published);
	assert.equal(state.collaboration!.evidence.length, 1);
	assert.equal(applyLedgerEvent(state, { ...published, excerpt: "conflicting" } as ExocomSemanticFrame).ok, false);
});

test("saturated optional evidence cannot prevent minimal completion or release", () => {
	let state = apply(apply(emptyLedger(), create), take());
	for (let i = 0; i < 64; i++) {
		const result = applyLedgerEvent(state, { ...base, kind: "publish", work_key: "inventory", title: "evidence", excerpt: "x".repeat(4096), msg_id: `full-${i}` });
		if (!result.ok) break;
		state = result.state;
	}
	const finished = apply(state, { ...base, from_session: "b", kind: "task_finish", work_key: "inventory", outcome: "done", note: "x", msg_id: "minimal-done" });
	assert.equal(collaborationStatus(finished.collaboration!.tasks[0]!), "done");
	assert.equal(finished.claims.length, 0);
	assert.equal(apply(state, { ...base, from_session: "b", kind: "release", work_key: "inventory", msg_id: "release-at-cap" }).claims.length, 0);
});

test("task progress is generation-bound and cannot regress an already observed timestamp", () => {
	let state = apply(apply(emptyLedger(), create), take());
	const first = { ...base, from_session: "b", kind: "progress", work_key: "inventory", ts: "2026-10-25T00:01:00.000Z", note: "latest", msg_id: "latest" };
	state = apply(state, first);
	assert.equal(applyLedgerEvent(state, { ...first, ts, note: "old", msg_id: "old" } as ExocomSemanticFrame).ok, false);
	assert.equal(applyLedgerEvent(state, { ...first, task_id: "prior-generation", msg_id: "prior" } as ExocomSemanticFrame).ok, false);
	state = apply(state, { kind: "progress", work_key: "inventory", from_session: "a", from_name: "invented", ts, note: "general journal", msg_id: "legacy" });
	assert.equal(state.collaboration!.tasks[0]?.progress?.note, "latest", "legacy general notes never mutate task progress");
});

test("unknown authoritative snapshot versions fail closed instead of erasing ownership", () => {
	assert.throws(() => parseLedger(JSON.stringify({ kind: "ledger_snapshot_v2", claims: [] })), /unsupported ledger snapshot version/);
});

test("snapshot replay does not reserve lifecycle headroom for all historically completed tasks at once", () => {
	let state = emptyLedger();
	for (let i = 0; i < 64; i++) {
		const work_key = `finished-${i}`;
		const task_id = `created-${i}`;
		state = apply(state, { ...base, kind: "task_create", work_key, description: "x", write_set: [], msg_id: task_id });
		state = apply(state, { ...base, kind: "task_take", work_key, task_id, msg_id: `take-${i}` });
		state = apply(state, { ...base, kind: "task_finish", work_key, task_id, outcome: "done", note: "x", msg_id: `finish-${i}` });
	}
	const snapshot = { kind: "ledger_snapshot_v1", claims: state.claims, asks: state.asks, answers: state.answers, ask_ids: state.askIds, seen: state.seen, collaboration: state.collaboration };
	assert.equal(parseLedger(JSON.stringify(snapshot)).collaboration!.tasks.length, 64);
});

test("delayed task frames cannot bind a reused work key from another generation", () => {
	let state = apply(emptyLedger(), { ...create, write_set: [] });
	state = apply(state, take());
	state = apply(state, { ...base, from_session: "b", kind: "task_finish", work_key: "inventory", outcome: "done", note: "done", msg_id: "done" });
	state = pruneLedger(state, { now: Date.parse(ts) + 1001, ttlMs: 1000, liveSessions: new Set(["a", "b"]) });
	state = apply(state, { ...create, write_set: [], msg_id: "new-generation" });
	for (const old of [take("c", "delayed-take"), { ...base, kind: "publish", work_key: "inventory", title: "old", excerpt: "old", msg_id: "old-publish" },
		{ ...base, kind: "offer", offer_id: "old-offer", work_key: "inventory", expires_at: "2026-10-25T00:01:00.000Z", msg_id: "old-offer" }]) {
		assert.equal(applyLedgerEvent(state, old as ExocomSemanticFrame).ok, false);
	}
	assert.equal(state.collaboration!.tasks[0]?.taken, undefined);
});

test("published excerpts are bounded and signed in full; finishing releases only the task claim", () => {
	let state = apply(apply(emptyLedger(), create), take());
	const evidence = { ...base, kind: "publish", work_key: "inventory", title: "Test evidence", excerpt: "verified input", msg_id: "publish" };
	assert.equal(isSemanticFrame({ ...evidence, excerpt: "😀".repeat(3000) }), false);
	assert.notEqual(frameSigningPayload(evidence as ExocomSemanticFrame), frameSigningPayload({ ...evidence, excerpt: "tampered" } as ExocomSemanticFrame));
	state = apply(state, evidence);
	state = apply(state, { ...base, from_session: "b", kind: "task_finish", work_key: "inventory", outcome: "done", note: "Checks passed", msg_id: "finish" });
	assert.equal(collaborationStatus(state.collaboration!.tasks[0]!), "done");
	assert.equal(state.claims.length, 0);
	assert.equal(state.collaboration!.evidence[0]?.excerpt, "verified input");
});

test("compaction and duplicate replay preserve task provenance and bounded evidence", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-collaboration-"));
	const file = join(dir, "ledger.jsonl");
	try {
		for (const event of [create, take(), { ...base, kind: "publish", work_key: "inventory", title: "Evidence", excerpt: "A finding", msg_id: "publish" }]) {
			assert.equal(commitLedgerEvent(file, event as ExocomSemanticFrame, { compactAtBytes: 1 }).ok, true);
		}
		const state = loadLedger(file);
		assert.equal(state.collaboration!.tasks[0]?.taken?.from_session, "b");
		assert.equal(state.collaboration!.evidence[0]?.excerpt, "A finding");
		const duplicate = commitLedgerEvent(file, take() as ExocomSemanticFrame);
		assert.equal(duplicate.ok && duplicate.duplicate, true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

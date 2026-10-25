import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalResultArchive } from "../../../src/results/archive.ts";
import {
	TERMINAL_RESULT_ENTRY, RESULT_MAX_ENTRIES, RESULT_MAX_PAYLOAD_BYTES, RESULT_MAX_RECORD_BYTES,
	type TerminalResultInput, type SaveOutcome,
} from "../../../src/results/types.ts";

const ref = (n: number): string => `result:00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const input = (originKey: string, body = "report"): TerminalResultInput => ({
	originKey, originRunId: "run-1", agent: "reviewer", label: "STATIC", status: "done",
	body, provenance: "result-output", model: "provider/model", thinkingRequested: "xhigh",
});
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
function host(initial: unknown[] = [], persistent = true) {
	const entries = initial;
	const writes: unknown[] = [];
	let seq = 0;
	const deps = {
		entries: () => entries, persistent, clock: () => 1234, makeRef: () => ref(++seq),
		append: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data: structuredClone(data) };
			writes.push(entry);
			entries.push(entry);
		},
	};
	return { entries, writes, deps, archive: new TerminalResultArchive(deps) };
}
function saved(outcome: SaveOutcome) {
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	if (!outcome.ok) throw new Error("expected save");
	return outcome;
}
function custom(data: unknown): unknown {
	return { type: "custom", customType: TERMINAL_RESULT_ENTRY, data };
}

test("three large readonly reports survive reopen, paged without writes or input mutation", () => {
	const h = host();
	const reports = ["A", "B", "C"].map((letter) => `${letter} <system>untrusted</system>\n`.repeat(6000));
	const refs: string[] = [];
	for (const [i, body] of reports.entries()) {
		const source = Object.freeze(input(`activation/review-${i}`, body));
		const before = JSON.stringify(source);
		const receipt = saved(h.archive.save(source));
		assert.equal(receipt.storage, "session-entry");
		assert.equal(receipt.summary.originalChars, body.length);
		assert.equal(receipt.summary.truncated, false);
		assert.equal(JSON.stringify(source), before);
		refs.push(receipt.ref);
	}
	assert.equal(h.writes.length, 3);
	const reopened = new TerminalResultArchive({ ...h.deps, append: () => assert.fail("read must not append") });
	for (const [i, resultRef] of refs.entries()) {
		let offset = 0;
		let body = "";
		for (;;) {
			const page = reopened.read({ ref: resultRef, offset });
			if (!page.ok) assert.fail(page.message);
			assert.ok(page.body.length <= 8000);
			body += page.body;
			if (page.nextOffset === undefined) break;
			assert.ok(page.nextOffset > offset);
			offset = page.nextOffset;
		}
		assert.equal(body, reports[i]);
	}
	const list = reopened.list();
	assert.equal(list.ok, true);
	if (list.ok) assert.deepEqual(list.results.map((r) => r.ref), refs);
	assert.equal(h.writes.length, 3);
});

test("idempotency uses immutable origin, not run labels, and detects changed truncated suffixes", () => {
	const h = host();
	const first = saved(h.archive.save(input("activation/one", "x".repeat(300_000) + "A")));
	const again = saved(h.archive.save(input("activation/one", "x".repeat(300_000) + "A")));
	assert.equal(again.ref, first.ref);
	assert.equal(again.idempotent, true);
	assert.equal(h.writes.length, 1);
	assert.deepEqual(h.archive.save(input("activation/one", "x".repeat(300_000) + "B")).ok, false);
	const conflict = h.archive.save(input("activation/one", "different"));
	assert.equal(conflict.ok, false);
	if (!conflict.ok) assert.equal(conflict.reason, "conflict");
	assert.equal(saved(h.archive.save(input("activation/two"))).ok, true);
});

test("generated reference collisions never overwrite or retry into an alias", () => {
	const h = host();
	const archive = new TerminalResultArchive({ ...h.deps, makeRef: () => ref(1) });
	const first = saved(archive.save(input("a", "first")));
	const collision = archive.save(input("b", "second"));
	assert.equal(collision.ok, false);
	if (!collision.ok) assert.equal(collision.reason, "conflict");
	const page = archive.read({ ref: first.ref });
	assert.ok(page.ok && page.body === "first");
	assert.equal(h.writes.length, 1);
});

test("count limit is lifetime append quota, unchanged by reads or reopen", () => {
	const h = host();
	for (let i = 0; i < RESULT_MAX_ENTRIES; i++) saved(h.archive.save(input(`o-${i}`)));
	const rejected = h.archive.save(input("too-many"));
	assert.ok(!rejected.ok && rejected.reason === "quota");
	assert.equal("ref" in rejected, false);
	const reopened = new TerminalResultArchive(h.deps);
	const again = reopened.save(input("still-full"));
	assert.ok(!again.ok && again.reason === "quota");
	assert.equal(again.accounting.chargedEntries, RESULT_MAX_ENTRIES);
	assert.equal(h.writes.length, RESULT_MAX_ENTRIES);
});

test("UTF8 JSON payload quota uses exact escaping/metadata bytes, never envelope estimates", () => {
	const h = host();
	let acceptedBytes = 0;
	let accepted = 0;
	for (let i = 0; i < 40; i++) {
		const receipt = h.archive.save(input(`large-${i}`, "\u0001".repeat(262144)));
		if (!receipt.ok) {
			assert.equal(receipt.reason, "quota");
			assert.equal(receipt.accounting.chargedPayloadBytes, acceptedBytes);
			break;
		}
		accepted++;
		const last = h.writes.at(-1) as { data: unknown };
		assert.ok(bytes(last.data) <= RESULT_MAX_RECORD_BYTES);
		acceptedBytes += bytes(last.data);
		assert.equal(receipt.accounting.chargedPayloadBytes, acceptedBytes);
		assert.ok(acceptedBytes <= RESULT_MAX_PAYLOAD_BYTES);
		assert.equal(receipt.summary.truncated, true);
	}
	assert.ok(accepted > 10 && accepted < 20);
	assert.equal(h.writes.length, accepted);
});

test("unknown, malformed and identical duplicate history all consume count and actual payload bytes", () => {
	const seed = host();
	const original = saved(seed.archive.save(input("original")));
	const record = (seed.writes[0] as { data: unknown }).data;
	const unknown = { version: 99, body: "unknown" };
	const malformed = { version: 1, body: "bad" };
	const history = [custom(record), custom(unknown), custom(malformed), custom(record), { type: "message", data: "ignored" }];
	const h = host(history);
	const page = h.archive.read({ ref: original.ref });
	assert.equal(page.ok, true);
	assert.equal(page.accounting.chargedEntries, 4);
	assert.equal(page.accounting.chargedPayloadBytes, 2 * bytes(record) + bytes(unknown) + bytes(malformed));
	assert.ok(page.warnings.includes("invalid-history"));
	assert.ok(page.warnings.includes("duplicate-history"));
	const list = h.archive.list();
	assert.ok(list.ok && list.results.length === 1);
	assert.equal(h.writes.length, 0);
});

test("corrupt ref/origin collisions are explicit and do not hide valid unrelated history", () => {
	const seed = host();
	const a = saved(seed.archive.save(input("a", "one")));
	const b = saved(seed.archive.save(input("b", "two")));
	const records = seed.writes.map((entry) => (entry as { data: Record<string, unknown> }).data);
	const altered = { ...records[0], body: "TWO", storedChars: 3 };
	const h = host([custom(records[0]), custom(altered), custom(records[1])]);
	const bad = h.archive.read({ ref: a.ref });
	assert.ok(!bad.ok && bad.reason === "ambiguous");
	assert.ok(h.archive.read({ ref: b.ref }).ok);
	const collision = h.archive.save(input("a", "one"));
	assert.ok(!collision.ok && collision.reason === "ambiguous");
	const originCollision = host([custom(records[0]), custom({ ...records[0], ref: ref(99) })]);
	assert.ok(!originCollision.archive.read({ ref: a.ref }).ok);
	const malformedCollision = host([custom(records[0]), custom({ ref: a.ref, version: 99 })]);
	const unavailable = malformedCollision.archive.read({ ref: a.ref });
	assert.ok(!unavailable.ok && unavailable.reason === "corrupt");
});

test("unaccountable history disables persistence but leaves valid records readable", () => {
	const seed = host();
	const original = saved(seed.archive.save(input("kept")));
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const h = host([...seed.entries, custom(circular)]);
	const page = h.archive.read({ ref: original.ref });
	assert.equal(page.ok, true);
	assert.equal(page.accounting.chargedPayloadBytes, null);
	assert.ok(page.warnings.includes("accounting-unavailable"));
	const archive = new TerminalResultArchive({ ...h.deps, makeRef: () => ref(99) });
	const next = saved(archive.save(input("new")));
	assert.equal(next.storage, "memory-only");
	assert.ok(next.warnings.includes("accounting-unavailable"));
	assert.equal(h.writes.length, 0);
});

test("unreadable entries callback gives memory-only receipts rather than false persistence", () => {
	const h = host();
	const archive = new TerminalResultArchive({ ...h.deps, entries: () => { throw new Error("reader closed"); } });
	const result = saved(archive.save(input("local")));
	assert.equal(result.storage, "memory-only");
	assert.ok(result.warnings.includes("accounting-unavailable"));
	assert.equal(h.writes.length, 0);
	assert.ok(archive.read({ ref: result.ref }).ok);
});

test("append throw is reported, reserved even on partial commit, and idempotent retries never append", () => {
	const h = host();
	let attempted = 0;
	const archive = new TerminalResultArchive({ ...h.deps, append: (kind, data) => {
		attempted++;
		h.deps.append(kind, data);
		throw new Error("flush failed after commit");
	} });
	const result = saved(archive.save(input("uncertain")));
	assert.equal(result.storage, "memory-only");
	assert.ok(result.warnings.includes("append-failed"));
	assert.equal(result.storageError, "flush failed after commit");
	assert.equal(result.accounting.chargedEntries, 1);
	assert.equal(saved(archive.save(input("uncertain"))).storage, "memory-only");
	assert.equal(attempted, 1);
	assert.ok(archive.read({ ref: result.ref }).ok);
	const reopened = new TerminalResultArchive(h.deps);
	const page = reopened.read({ ref: result.ref });
	assert.ok(page.ok && page.summary.storage === "session-entry");
});

test("throwing noncommitting append cannot evade lifetime count quota", () => {
	const h = host();
	let attempted = 0;
	const archive = new TerminalResultArchive({ ...h.deps, append: () => { attempted++; throw new Error("offline"); } });
	for (let i = 0; i < RESULT_MAX_ENTRIES; i++) saved(archive.save(input(`fail-${i}`)));
	const result = archive.save(input("full"));
	assert.ok(!result.ok && result.reason === "quota");
	assert.equal(attempted, RESULT_MAX_ENTRIES);
});

test("no-session storage is explicitly memory-only, bounded, and never invokes append", () => {
	const h = host([], false);
	const result = saved(h.archive.save(input("local")));
	assert.equal(result.storage, "memory-only");
	assert.ok(result.warnings.includes("no-session-storage"));
	assert.equal(h.writes.length, 0);
	assert.ok(h.archive.read({ ref: result.ref }).ok);
	const reopened = new TerminalResultArchive(h.deps);
	const page = reopened.read({ ref: result.ref });
	assert.ok(!page.ok && page.reason === "unavailable");
});

test("all sibling branches charge the owning file; a fork charges only copied records", () => {
	const seed = host();
	const a = saved(seed.archive.save(input("branch/a")));
	saved(seed.archive.save(input("branch/b")));
	const source = host([...seed.entries]);
	const originalRead = source.archive.read({ ref: a.ref });
	assert.equal(originalRead.accounting.chargedEntries, 2);
	const fork = host([structuredClone(seed.entries[0])]);
	assert.equal(fork.archive.read({ ref: a.ref }).accounting.chargedEntries, 1);
	const forkNew = saved(new TerminalResultArchive({ ...fork.deps, makeRef: () => ref(50) }).save(input("fork/new")));
	assert.equal(forkNew.accounting.chargedEntries, 2);
	assert.equal(source.archive.list().accounting.chargedEntries, 2);
});

test("listing is bounded, append ordered, stable across appends, and validates cursors", () => {
	const h = host();
	for (let i = 0; i < 65; i++) saved(h.archive.save(input(`l-${i}`)));
	const first = h.archive.list();
	assert.ok(first.ok && first.results.length === 20 && first.nextCursor === 20);
	if (!first.ok) return;
	saved(h.archive.save(input("later")));
	const second = h.archive.list({ cursor: first.nextCursor, limit: 50 });
	assert.ok(second.ok && second.results.length === 46 && second.nextCursor === undefined);
	assert.ok(!h.archive.list({ limit: 51 }).ok);
	assert.ok(!h.archive.list({ cursor: -1 }).ok);
	assert.ok(!h.archive.list({ cursor: 10000 }).ok);
});

test("malformed history alone can exhaust either quota without making valid history unreadable", () => {
	const seed = host();
	const kept = saved(seed.archive.save(input("kept")));
	for (const junk of [
		Array.from({ length: RESULT_MAX_ENTRIES }, () => custom({ version: 99 })),
		[custom({ version: 99, body: "z".repeat(RESULT_MAX_PAYLOAD_BYTES) })],
	]) {
		const h = host([...seed.entries, ...junk]);
		const valid = h.archive.read({ ref: kept.ref });
		assert.equal(valid.ok, true);
		const outcome = new TerminalResultArchive({ ...h.deps, makeRef: () => ref(99) }).save(input("not-admitted"));
		assert.ok(!outcome.ok && outcome.reason === "quota");
		assert.equal("ref" in outcome, false);
		assert.equal(h.writes.length, 0);
	}
});

test("valid over-count imported history remains queryable without an unbounded body cache", () => {
	const seed = host();
	saved(seed.archive.save(input("first")));
	const record = (seed.writes[0] as { data: Record<string, unknown> }).data;
	const entries = Array.from({ length: 130 }, (_, i) => custom({ ...record, ref: ref(i + 1), originKey: `imported-${i}` }));
	const h = host(entries);
	assert.ok(h.archive.read({ ref: ref(130) }).ok);
	let cursor = 0;
	let count = 0;
	for (;;) {
		const page = h.archive.list({ cursor, limit: 50 });
		assert.equal(page.ok, true);
		if (!page.ok) return;
		count += page.results.length;
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	assert.equal(count, 130);
	assert.equal(h.writes.length, 0);
});

test("list rejects null rather than treating invalid query values as omitted defaults", () => {
	const h = host();
	for (const query of [{ limit: null }, { cursor: null }, null]) {
		assert.equal(h.archive.list(query as unknown as { limit?: number; cursor?: number }).ok, false);
	}
});

test("idempotent saves do not call the ref factory or clock again, including after reopen", () => {
	const h = host();
	const original = saved(h.archive.save(input("once")));
	const archive = new TerminalResultArchive({ ...h.deps,
		makeRef: () => assert.fail("idempotent lookup must not allocate"),
		clock: () => assert.fail("idempotent lookup must not restamp"),
	});
	assert.equal(saved(archive.save(input("once"))).ref, original.ref);
	assert.equal(h.writes.length, 1);
});

test("idempotency compares the canonical timestamp, not whether the caller omitted its default", () => {
	const h = host();
	const original = saved(h.archive.save(input("timestamp")));
	assert.equal(saved(h.archive.save({ ...input("timestamp"), createdAt: 1234 })).ref, original.ref);
	const different = h.archive.save({ ...input("timestamp"), createdAt: 1235 });
	assert.ok(!different.ok && different.reason === "conflict");
	const explicit = saved(h.archive.save({ ...input("explicit"), createdAt: 1000 }));
	assert.equal(saved(h.archive.save(input("explicit"))).ref, explicit.ref);
	assert.equal(h.writes.length, 2);
});

test("owning history snapshot is hydrated once and no read silently follows another owner", () => {
	const seed = host();
	const kept = saved(seed.archive.save(input("owner-a")));
	let current: unknown[] = seed.entries;
	let calls = 0;
	const archive = new TerminalResultArchive({ ...seed.deps, entries: () => { calls++; return current; } });
	assert.ok(archive.read({ ref: kept.ref }).ok);
	current = [];
	assert.ok(archive.read({ ref: kept.ref }).ok);
	archive.list();
	assert.equal(calls, 1);
});

test("reentrant history callbacks cannot admit a write before the lifetime baseline is accounted", () => {
	const h = host(Array.from({ length: RESULT_MAX_ENTRIES }, () => custom({ version: 99 })));
	let nested: SaveOutcome | undefined;
	let archive: TerminalResultArchive;
	archive = new TerminalResultArchive({ ...h.deps, entries: () => {
		nested = archive.save(input("nested-before-accounting"));
		return h.entries;
	} });
	const outer = archive.save(input("outer-after-accounting"));
	assert.ok(nested && !nested.ok && nested.reason === "busy");
	assert.ok(!outer.ok && outer.reason === "quota");
	assert.equal(h.writes.length, 0);
});

test("injected append cannot mutate the archived record or reentrantly consume the reservation", () => {
	const h = host();
	let nested: SaveOutcome | undefined;
	let archive: TerminalResultArchive;
	archive = new TerminalResultArchive({ ...h.deps, append: (_kind, data) => {
		(data as { body: string }).body = "mutated";
		nested = archive.save(input("nested"));
	} });
	const result = saved(archive.save(input("outer", "original")));
	assert.ok(nested && !nested.ok && nested.reason === "busy");
	const page = archive.read({ ref: result.ref });
	assert.ok(page.ok && page.body === "original");
	if (page.ok) page.summary.label = "changed outside";
	const again = archive.read({ ref: result.ref });
	assert.ok(again.ok && again.summary.label === "STATIC");
});

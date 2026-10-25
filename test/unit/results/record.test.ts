import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalResultArchive } from "../../../src/results/archive.ts";
import { parseTerminalResultRecord } from "../../../src/results/record.ts";
import { RESULT_MAX_BODY_CHARS, RESULT_MAX_RECORD_BYTES, type TerminalResultInput } from "../../../src/results/types.ts";

const REF = "result:12345678-1234-4123-8123-123456789abc";
function fixture(body = "body") {
	const input: TerminalResultInput = { originKey: "activation/run-1", agent: "review", status: "done", body, provenance: "result-output" };
	const writes: unknown[] = [];
	const archive = new TerminalResultArchive({
		entries: () => [], append: (_kind, data) => { writes.push(data); }, persistent: true,
		clock: () => 1234, makeRef: () => REF,
	});
	return { input, writes, archive };
}

test("UTF16 ceiling preserves the report prefix and never cuts a surrogate pair", () => {
	const h = fixture("a".repeat(RESULT_MAX_BODY_CHARS - 1) + "😀last");
	const result = h.archive.save(h.input);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.summary.storedChars, RESULT_MAX_BODY_CHARS - 1);
	assert.equal(result.summary.originalChars, h.input.body.length);
	assert.equal(result.summary.truncated, true);
	const record = parseTerminalResultRecord(h.writes[0]);
	assert.equal(record?.body, "a".repeat(RESULT_MAX_BODY_CHARS - 1));
});

test("serialized byte cap includes escaping, multibyte text, and bounded metadata", () => {
	for (const body of ["\0".repeat(262144), "漢".repeat(262144), "😀".repeat(131072), "\\\"\n".repeat(90000)]) {
		const h = fixture(body);
		const result = h.archive.save({ ...h.input, label: "\\".repeat(256), error: "\0".repeat(2048) });
		assert.equal(result.ok, true);
		if (!result.ok) continue;
		const record = parseTerminalResultRecord(h.writes[0]);
		assert.ok(record);
		assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= RESULT_MAX_RECORD_BYTES);
		assert.equal(body.startsWith(record.body), true);
		assert.equal(record.storedChars, record.body.length);
		assert.equal(record.truncated, record.originalChars > record.storedChars);
	}
});

test("pagination uses stored UTF16 offsets, makes progress, and rejects split pairs", () => {
	const h = fixture("A😀B😀C");
	assert.equal(h.archive.save(h.input).ok, true);
	const first = h.archive.read({ ref: REF, limit: 2 });
	assert.ok(first.ok && first.body === "A" && first.nextOffset === 1 && !first.endOfStoredBody);
	const astral = h.archive.read({ ref: REF, offset: 1, limit: 2 });
	assert.ok(astral.ok && astral.body === "😀" && astral.nextOffset === 3);
	const split = h.archive.read({ ref: REF, offset: 2 });
	assert.ok(!split.ok && split.reason === "invalid");
	const end = h.archive.read({ ref: REF, offset: h.input.body.length });
	assert.ok(end.ok && end.body === "" && end.nextOffset === undefined && end.endOfStoredBody);
	for (const request of [
		{ ref: REF, offset: -1 }, { ref: REF, offset: 1.1 }, { ref: REF, offset: 99 },
		{ ref: REF, limit: 1 }, { ref: REF, limit: 16001 }, { ref: REF, limit: NaN }, { ref: "run-1" },
	]) assert.equal(h.archive.read(request).ok, false);
	const unknown = h.archive.read({ ref: "result:ffffffff-ffff-4fff-8fff-ffffffffffff" });
	assert.ok(!unknown.ok && unknown.reason === "unavailable");
});

test("malformed input rejects cleanly, never infers status or serializes arbitrary result fields", () => {
	const h = fixture();
	const invalid = [
		{ ...h.input, status: "running" }, { ...h.input, provenance: "reasoning" },
		{ ...h.input, agent: "a".repeat(129) }, { ...h.input, label: "x".repeat(257) },
		{ ...h.input, error: "x".repeat(2049) }, { ...h.input, model: "x".repeat(513) },
		{ ...h.input, originKey: "" }, { ...h.input, body: {} },
		{ ...h.input, thinkingEffective: "automatic" }, { ...h.input, usage: { input: Infinity, output: 0 } },
		{ ...h.input, usage: { input: -1, output: 0 } }, { ...h.input, usage: { input: 1.5, output: 0 } },
		{ ...h.input, structured: { arbitrary: "not archived" } }, { ...h.input, tasks: ["no"] },
		{ ...h.input, createdAt: NaN },
		Object.defineProperty({ ...h.input }, "body", { value: "hidden body", enumerable: false }), null,
	];
	for (const value of invalid) {
		const outcome = h.archive.save(value as TerminalResultInput);
		assert.ok(!outcome.ok && outcome.reason === "invalid", JSON.stringify(value));
	}
	assert.equal(h.writes.length, 0);
	const valid = h.archive.save({ ...h.input, status: "failed", body: "I claim success", provenance: "partial-output",
		thinkingRequested: "max", thinkingEffective: "high", usage: { input: 10, output: 20, cost: 0.2 } });
	assert.equal(valid.ok, true);
	const record = parseTerminalResultRecord(h.writes[0]);
	assert.equal(record?.status, "failed");
	assert.equal(record?.thinkingRequested, "max");
	assert.equal(record?.thinkingEffective, "high");
});

test("native record validation rejects unknown fields/versions, false lengths, unsafe timestamps and oversized records", () => {
	const h = fixture();
	h.archive.save(h.input);
	const record = h.writes[0] as Record<string, unknown>;
	for (const bad of [
		{ ...record, version: 2 }, { ...record, tasks: [] }, { ...record, originalChars: 1 },
		{ ...record, storedChars: 1 }, { ...record, truncated: true }, { ...record, createdAt: Infinity },
		{ ...record, ref: "result:run-1" }, { ...record, payloadHash: "not-a-digest" },
		Object.defineProperty({ ...record }, "body", { value: "body", enumerable: false }),
		{ ...record, body: "\0".repeat(262144), originalChars: 262144, storedChars: 262144 },
	]) assert.equal(parseTerminalResultRecord(bad), undefined);
	const parsed = parseTerminalResultRecord(record);
	assert.ok(parsed);
	parsed.agent = "changed";
	assert.equal(record.agent, "review");
});

test("malformed query objects reject without executing accessors", () => {
	const h = fixture();
	const result = h.archive.save(h.input);
	assert.equal(result.ok, true);
	for (const query of [null, [], 1, "query", { limit: 2, task: "not part of the query" },
		Object.defineProperty({}, "limit", { enumerable: true, get: () => assert.fail("must not execute getter") })]) {
		assert.equal(h.archive.list(query as never).ok, false);
	}
	const read = Object.defineProperty({ ref: REF }, "offset", {
		enumerable: true, get: () => assert.fail("must not execute getter"),
	});
	assert.equal(h.archive.read(read).ok, false);
});

test("invalid callback return values cannot silently select fallback identities or clocks", () => {
	const h = fixture();
	for (const callback of [null, undefined]) {
		const common = { entries: () => [], persistent: true, append: () => assert.fail("invalid injection must not append") };
		const badRef = new TerminalResultArchive({ ...common, makeRef: () => callback as never });
		const badClock = new TerminalResultArchive({ ...common, makeRef: () => REF, clock: () => callback as never });
		assert.equal(badRef.save(h.input).ok, false);
		assert.equal(badClock.save(h.input).ok, false);
	}
});

test("distinct lone-surrogate suffixes remain conflicting even beyond the retained prefix", () => {
	const h = fixture("a".repeat(300000) + "\ud800");
	assert.ok(h.archive.save(h.input).ok);
	const conflict = h.archive.save({ ...h.input, body: "a".repeat(300000) + "\ud801" });
	assert.ok(!conflict.ok && conflict.reason === "conflict");
});

test("invalid injected refs/clocks are rejected without append and errors are bounded", () => {
	const h = fixture();
	for (const [makeRef, clock] of [[() => "run-1", () => 1], [() => REF, () => NaN]] as const) {
		const archive = new TerminalResultArchive({ entries: () => [], persistent: true, append: () => assert.fail("no append"), makeRef, clock });
		assert.equal(archive.save(h.input).ok, false);
	}
	const archive = new TerminalResultArchive({ entries: () => [], persistent: true, makeRef: () => REF,
		append: () => { throw new Error("x".repeat(10000)); } });
	const outcome = archive.save(h.input);
	assert.ok(outcome.ok && outcome.storage === "memory-only" && (outcome.storageError?.length ?? 0) <= 2048);
});

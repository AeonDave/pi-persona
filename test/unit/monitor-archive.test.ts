import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonitorEntry, MonitorEvent } from "../../src/core/monitor.ts";
import {
	MONITOR_LOG_ENTRY, MONITOR_LOG_MAX_BYTES, MONITOR_LOG_MAX_RECORDS,
	MONITOR_LOG_MAX_STREAM_CHARS, MONITOR_LOG_MAX_TEXT_CHARS,
	MonitorArchive, parseMonitorLogRecord, type MonitorLogRecord,
} from "../../src/monitor/archive.ts";

function entry(id = "watch-1"): MonitorEntry {
	return { id, label: "build", command: "node", args: ["build.mjs"], cwd: ".", mode: "exit", startedAtEpochMs: 100, expiresAtEpochMs: 1100, maxEvents: 1 };
}
function event(id = "watch-1", kind: MonitorEvent["kind"] = "exit", terminal = true): MonitorEvent {
	return { id, label: "build", kind, terminal, atEpochMs: 200, text: "finished" };
}
function record(id = "watch-1"): MonitorLogRecord {
	return { version: 1, entry: entry(id), outcome: "exit", text: "finished", stdout: "saved stdout", stderr: "saved stderr", truncated: false };
}
function custom(data: unknown, customType = MONITOR_LOG_ENTRY) { return { type: "custom", customType, data }; }
function harness(initial: unknown[] = []) {
	const entries = [...initial];
	const writes: { customType: string; data: unknown }[] = [];
	const archive = new MonitorArchive({ entries: () => entries, append: (customType, data) => {
		writes.push({ customType, data }); entries.push(custom(data, customType));
	} });
	return { archive, entries, writes };
}

test("unreadable own historical formats still consume the append-only archive budget", () => {
	for (const history of [
		Array.from({ length: MONITOR_LOG_MAX_RECORDS }, () => custom({ version: 2 })),
		[custom({ version: 2, stdout: "x".repeat(MONITOR_LOG_MAX_BYTES) })],
	]) {
		const h = harness(history);
		assert.deepEqual(h.archive.list(), [], "unknown formats are not usable results");
		h.archive.armed(entry()); h.archive.event(event());
		assert.equal(h.writes.length, 0, "ignoring a historical format cannot reset the storage quota");
		assert.match(h.archive.result("watch-1")?.storageWarning ?? "", /budget/);
	}
});

test("live raw capture and nonterminal semantic events do not append", () => {
	const h = harness(); h.archive.armed(entry());
	h.archive.output({ id: "watch-1", stream: "stdout", text: "\u001b[31mRAW\r50%\n<untrusted>" });
	h.archive.output({ id: "watch-1", stream: "stderr", text: "warning\n" });
	h.archive.event(event("watch-1", "output", false));
	assert.equal(h.writes.length, 0);
	assert.equal(h.archive.result("watch-1")?.outcome, "running");
	assert.equal(h.archive.result("watch-1")?.stdout, "\u001b[31mRAW\r50%\n<untrusted>");
	assert.equal(h.archive.result("watch-1")?.stderr, "warning\n");
	assert.equal(h.archive.result("absent"), undefined);
	assert.equal(h.archive.list().length, 1);
});

test("stream tails and terminal text have fixed independent bounds without modifying raw suffixes", () => {
	const h = harness(); h.archive.armed(entry());
	const stdout = "prefix" + "x".repeat(MONITOR_LOG_MAX_STREAM_CHARS - 2) + "\r\n";
	const stderr = "bad".repeat(MONITOR_LOG_MAX_STREAM_CHARS);
	h.archive.output({ id: "watch-1", stream: "stdout", text: stdout.slice(0, 30) });
	h.archive.output({ id: "watch-1", stream: "stdout", text: stdout.slice(30) });
	h.archive.output({ id: "watch-1", stream: "stderr", text: stderr });
	h.archive.event({ ...event(), text: "t".repeat(MONITOR_LOG_MAX_TEXT_CHARS + 1) });
	const result = h.archive.result("watch-1")!;
	assert.equal(result.stdout, stdout.slice(-MONITOR_LOG_MAX_STREAM_CHARS));
	assert.equal(result.stderr, stderr.slice(-MONITOR_LOG_MAX_STREAM_CHARS));
	assert.equal(result.text.length, MONITOR_LOG_MAX_TEXT_CHARS);
	assert.equal(result.truncated, true);
	assert.equal(h.writes.length, 1);
});

test("each terminal outcome and cancellation persists exactly once; late callbacks are ignored", () => {
	for (const kind of ["exit", "error", "timeout", "output"] as const) {
		const h = harness(); h.archive.armed(entry());
		h.archive.output({ id: "watch-1", stream: "stdout", text: "before" });
		h.archive.event(event("watch-1", kind));
		const expected = h.archive.result("watch-1");
		h.archive.output({ id: "watch-1", stream: "stdout", text: "late" });
		h.archive.event(event()); h.archive.removed(entry()); h.archive.armed(entry());
		assert.equal(h.writes.length, 1);
		assert.equal(h.writes[0]?.customType, "pi-persona-monitor-log");
		assert.equal(expected?.outcome, kind === "output" ? "ended" : kind);
		assert.deepEqual(h.archive.result("watch-1"), expected);
	}
	const h = harness(); h.archive.armed(entry()); h.archive.removed(entry());
	h.archive.removed(entry()); h.archive.event(event());
	assert.equal(h.archive.result("watch-1")?.outcome, "cancelled");
	assert.equal(h.writes.length, 1);
	h.archive.output({ id: "unknown", stream: "stdout", text: "ignored" });
	h.archive.event(event("unknown")); h.archive.removed(entry("unknown"));
	assert.equal(h.archive.list().length, 1);
});

test("a resumed instance restores completed logs, never a process or mutable session entry", () => {
	const h = harness(); h.archive.armed(entry());
	h.archive.output({ id: "watch-1", stream: "stdout", text: "captured" });
	h.archive.event(event());
	let writes = 0;
	const resumed = new MonitorArchive({ entries: () => h.entries, append: () => { writes++; } });
	assert.deepEqual(resumed.result("watch-1"), h.archive.result("watch-1"));
	resumed.output({ id: "watch-1", stream: "stdout", text: "late" });
	resumed.event(event()); resumed.removed(entry());
	assert.equal(writes, 0);
	assert.equal(resumed.result("watch-1")?.stdout, "captured");
});

test("foreign, malformed, oversized and running persisted entries are ignored fail-soft", () => {
	const bad: unknown[] = [null, 1, {}, custom(record(), "foreign"), { type: "message", customType: MONITOR_LOG_ENTRY, data: record() }];
	for (const patch of [
		{ version: 2 }, { outcome: "success" }, { outcome: "running" }, { stdout: 1 }, { stderr: null },
		{ text: {} }, { truncated: "false" }, { storageWarning: 3 },
		{ stdout: "x".repeat(MONITOR_LOG_MAX_STREAM_CHARS + 1) },
		{ text: "x".repeat(MONITOR_LOG_MAX_TEXT_CHARS + 1) },
	]) bad.push(custom({ ...record(), ...patch }));
	for (const patch of [
		{ args: [1] }, { mode: "bogus" }, { id: "" }, { label: null }, { command: "" }, { cwd: "" },
		{ startedAtEpochMs: NaN }, { expiresAtEpochMs: 1 }, { maxEvents: 0 }, { maxEvents: 21 },
		{ args: Array<string>(1) },
	]) bad.push(custom({ ...record(), entry: { ...entry(), ...patch } }));
	bad.push(Object.defineProperty({}, "type", { get() { throw new Error("bad entry"); } }));
	bad.push(custom(record("valid")));
	const h = harness(bad);
	assert.deepEqual(h.archive.list(), [record("valid")]);
	h.archive.armed(entry("new")); h.archive.event(event("new"));
	assert.equal(h.writes.length, 0, "unaccountable history disables persistence without preventing valid retrieval");
	assert.match(h.archive.result("new")?.storageWarning ?? "", /history unavailable/);
});

test("foreign custom entries do not consume the monitor archive quota", () => {
	const h = harness(Array.from({ length: MONITOR_LOG_MAX_RECORDS + 1 }, () => custom(record(), "foreign")));
	h.archive.armed(entry("new")); h.archive.event(event("new"));
	assert.equal(h.writes.length, 1);
});

test("public historical parser is fail-soft, bounded, and returns isolated data", () => {
	const saved = record();
	const parsed = parseMonitorLogRecord(saved)!;
	assert.deepEqual(parsed, saved);
	parsed.entry.args.length = 0;
	assert.deepEqual(saved.entry.args, ["build.mjs"]);
	assert.equal(parseMonitorLogRecord({ ...saved, text: "x".repeat(MONITOR_LOG_MAX_TEXT_CHARS + 1) }), undefined);
	assert.equal(parseMonitorLogRecord({ ...saved, extra: "unexpected metadata" }), undefined);
	assert.equal(parseMonitorLogRecord({ ...saved, entry: { ...saved.entry, extra: "unexpected metadata" } }), undefined);
	assert.equal(parseMonitorLogRecord(Object.defineProperty({}, "version", { get() { throw new Error("hostile getter"); } })), undefined);
});

test("serialized metadata consumes the byte budget, not only stream content", () => {
	const h = harness();
	for (let i = 0; i < MONITOR_LOG_MAX_RECORDS; i++) {
		const id = `metadata-${i}`;
		h.archive.armed({ ...entry(id), args: Array.from({ length: 3 }, () => "\u0001".repeat(8000)) });
		h.archive.event(event(id));
	}
	assert.ok(h.writes.length > 0 && h.writes.length < MONITOR_LOG_MAX_RECORDS);
	assert.ok(h.writes.reduce((sum, write) => sum + Buffer.byteLength(JSON.stringify(write.data)), 0) <= MONITOR_LOG_MAX_BYTES);
	assert.match(h.archive.result(`metadata-${MONITOR_LOG_MAX_RECORDS - 1}`)?.storageWarning ?? "", /budget/i);
});

test("record-count quota includes existing entries and caps recent runtime history", () => {
	const initial = Array.from({ length: MONITOR_LOG_MAX_RECORDS }, (_, i) => custom(record(`old-${i}`)));
	const h = harness(initial);
	for (let i = 0; i < MONITOR_LOG_MAX_RECORDS + 5; i++) {
		const id = `new-${i}`; h.archive.armed(entry(id)); h.archive.event(event(id));
		assert.match(h.archive.result(id)?.storageWarning ?? "", /budget|quota|limit/i);
	}
	assert.equal(h.writes.length, 0);
	assert.equal(h.archive.list().length, MONITOR_LOG_MAX_RECORDS);
	assert.equal(h.archive.result("new-0"), undefined);
	assert.equal(h.archive.result("old-0"), undefined);
});

test("byte quota bounds cumulative serialized records across archive instances", () => {
	const h = harness();
	let archive = h.archive;
	let budgetExhausted = false;
	for (let i = 0; i < MONITOR_LOG_MAX_RECORDS; i++) {
		const id = `byte-${i}`; archive.armed(entry(id));
		for (const stream of ["stdout", "stderr"] as const) {
			archive.output({ id, stream, text: "\u0000".repeat(MONITOR_LOG_MAX_STREAM_CHARS) });
		}
		archive.event({ ...event(id), text: "\u0000".repeat(MONITOR_LOG_MAX_TEXT_CHARS) });
		if (archive.result(id)?.storageWarning) budgetExhausted = true;
		archive = new MonitorArchive({ entries: () => h.entries, append: (type, data) => {
			h.writes.push({ customType: type, data }); h.entries.push(custom(data, type));
		} });
	}
	assert.equal(budgetExhausted, true);
	assert.ok(h.writes.length > 0 && h.writes.length < MONITOR_LOG_MAX_RECORDS);
	const persistedBytes = h.writes.reduce((sum, write) => sum + Buffer.byteLength(JSON.stringify(write.data)), 0);
	assert.ok(persistedBytes <= MONITOR_LOG_MAX_BYTES, `${persistedBytes} <= ${MONITOR_LOG_MAX_BYTES}`);
});

test("duplicate persisted IDs still consume append-only storage quota", () => {
	const h = harness(Array.from({ length: MONITOR_LOG_MAX_RECORDS }, () => custom(record())));
	h.archive.armed(entry("new")); h.archive.event(event("new"));
	assert.equal(h.writes.length, 0);
	assert.match(h.archive.result("new")?.storageWarning ?? "", /budget|quota|limit/i);
});

test("append failure is nonfatal, explicit, bounded and never retried for a settled monitor", () => {
	let calls = 0;
	const archive = new MonitorArchive({ entries: () => [], append: () => { calls++; throw new Error("disk unavailable"); } });
	for (let i = 0; i < MONITOR_LOG_MAX_RECORDS + 3; i++) {
		const id = `fail-${i}`; archive.armed(entry(id));
		archive.output({ id, stream: "stderr", text: "kept locally" });
		assert.doesNotThrow(() => archive.event(event(id)));
		archive.event(event(id)); archive.removed(entry(id));
		assert.match(archive.result(id)?.storageWarning ?? "", /unavailable|budget|quota|limit|persist/i);
		assert.equal(archive.result(id)?.stderr, "kept locally");
	}
	assert.equal(calls, MONITOR_LOG_MAX_RECORDS);
});

test("unreadable owning-session history disables persistence safely but keeps live capture", () => {
	let calls = 0;
	const archive = new MonitorArchive({ entries: () => { throw new Error("session unavailable"); }, append: () => { calls++; } });
	archive.armed(entry()); archive.output({ id: "watch-1", stream: "stdout", text: "live" });
	assert.match(archive.result("watch-1")?.storageWarning ?? "", /unavailable/i);
	archive.event(event());
	assert.equal(archive.result("watch-1")?.stdout, "live");
	assert.equal(calls, 0);
});

test("inputs, results, lists, hydrated records and appended snapshots share no mutable references", () => {
	const saved = record("saved"); const h = harness([custom(saved)]);
	const original = entry(); h.archive.armed(original);
	original.args.push("changed"); original.label = "changed";
	assert.equal(h.archive.result("watch-1")?.entry.label, "build");
	assert.deepEqual(h.archive.result("watch-1")?.entry.args, ["build.mjs"]);
	const fromList = h.archive.list(); fromList[0]!.entry.args.push("list mutation"); fromList.length = 0;
	const result = h.archive.result("watch-1")!; result.entry.args.length = 0; result.stdout = "mutation";
	h.archive.event(event());
	const appended = h.writes[0]!.data as MonitorLogRecord;
	appended.entry.args.length = 0; appended.stdout = "append mutation";
	saved.entry.args.length = 0; saved.stdout = "source mutation";
	assert.deepEqual(h.archive.result("watch-1")?.entry.args, ["build.mjs"]);
	assert.equal(h.archive.result("watch-1")?.stdout, "");
	assert.deepEqual(h.archive.result("saved"), record("saved"));
});

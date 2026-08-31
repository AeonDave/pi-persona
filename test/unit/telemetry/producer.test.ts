import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { tempDir } from "../../setup/temp-dir.ts";
import { TelemetryProducer } from "../../../src/telemetry/producer.ts";
import { parseTelemetryEvent, TELEMETRY_VERSION } from "../../../src/telemetry/contract.ts";

/** Derived, never pinned: a release bumps package.json and src/telemetry/contract.ts, and nothing
 *  else should have to move with them. */
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const instance = {
  displayName: "orion",
  persona: "dev",
  model: "provider/model",
  status: "active" as const,
  pid: 42,
  contextPercent: 12,
  exocomEnabled: true,
};

test("producer emits v2 bus events and persists the same JSONL envelope", async () => {
  const root = tempDir("pi-persona-telemetry-");
  const live: unknown[] = [];
  const p = new TelemetryProducer({
    agentDir: root,
    cwd: "D:/work",
    sessionId: "session-1",
    emit: (event) => live.push(event),
    now: () => 1_700_000_000_000,
    heartbeatMs: 0,
  });

  p.start(instance);
  p.publishAgentAdded({
    id: "run-1",
    label: "orion-recon",
    kind: "subagent",
    status: "running",
    detail: "reading",
  });
  await p.flush();

  const persisted: any[] = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(live.length, 2);
  assert.deepEqual(persisted, live);
  const first = persisted[0] as any;
  const second = persisted[1] as any;
  assert.equal(first.version, TELEMETRY_VERSION);
  assert.equal(first.producerId, "pi-persona");
  assert.equal(first.producerVersion, PACKAGE_VERSION, "the wire must carry the released version");
  assert.match(p.filePath, /telemetry[\\/]v2[\\/]/);
  assert.equal(first.type, "instance.started");
  assert.equal(second.seq, 2);
  assert.ok(parseTelemetryEvent(second));
});

test("producer resumes sequence from an existing session log", async () => {
  const root = tempDir("pi-persona-telemetry-resume-");
  const first = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "s1", emit: () => {}, heartbeatMs: 0 });
  mkdirSync(dirname(first.filePath), { recursive: true });
  writeFileSync(first.filePath, `${JSON.stringify({
    version: TELEMETRY_VERSION,
    id: "s1:7",
    seq: 7,
    ts: 1,
    sessionId: "s1",
    workspaceId: first.workspaceId,
    type: "instance.heartbeat",
    payload: {},
  })}\n`);

  const live: any[] = [];
  const resumed = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "s1", emit: (event) => live.push(event), heartbeatMs: 0 });
  resumed.start(instance);
  await resumed.flush();
  assert.equal(live[0].seq, 8);
  assert.equal(live[0].id, "pi-persona:s1:8");
});

test("producer bounds unsafe display strings and never persists agent output", async () => {
  const root = tempDir("pi-persona-telemetry-bounds-");
  const live: any[] = [];
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "s2", emit: (event) => live.push(event), heartbeatMs: 0 });
  p.start({ ...instance, displayName: `bad\n<name>${"x".repeat(200)}` });
  p.publishAgentAdded({
    id: "a",
    label: "agent",
    kind: "subagent",
    status: "running",
    detail: "d".repeat(1_000),
    output: "SECRET MODEL OUTPUT",
  });
  await p.flush();

  const encoded = JSON.stringify(live);
  assert.doesNotMatch(encoded, /SECRET MODEL OUTPUT/);
  assert.doesNotMatch(encoded, /d{20,}/);
  assert.doesNotMatch(live[0].payload.displayName, /[<>\n]/);
  assert.equal(live[1].payload.detail, undefined);
});

test("producer never persists task or tool-activity details", async () => {
  const root = tempDir("pi-persona-telemetry-safe-");
  const live: any[] = [];
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "safe", emit: (event) => live.push(event), heartbeatMs: 0 });
  p.start(instance);
  p.publishAgentAdded({ id: "a", label: "agent", kind: "subagent", status: "running", task: "raw prompt SECRET", detail: "run --token SECRET /private/path" });
  await p.flush();
  const encoded = readFileSync(p.filePath, "utf8");
  assert.doesNotMatch(encoded, /raw prompt|SECRET|private\/path/);
  assert.equal(live[1]?.payload.task, undefined);
  assert.equal(live[1]?.payload.detail, undefined);
});

test("agent updates preserve partial-patch semantics", async () => {
  const root = tempDir("pi-persona-telemetry-patch-");
  const live: any[] = [];
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "patch", emit: (event) => live.push(event), heartbeatMs: 0 });
  p.start(instance);
  p.publishAgentUpdated("a", { status: "done" });
  await p.flush();
  assert.deepEqual(live.at(-1)?.payload, { id: "a", patch: { status: "done" } });
});

test("stop appends a terminal instance event, flushes, and rejects late writes", async () => {
  const root = tempDir("pi-persona-telemetry-stop-");
  const live: any[] = [];
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "s3", emit: (event) => live.push(event), heartbeatMs: 0 });
  p.start(instance);
  await p.stop("quit");
  p.publish("agent.removed", { id: "late" });
  await p.flush();
  assert.equal(live.at(-1).type, "instance.stopped");
  assert.equal(live.at(-1).payload.reason, "quit");
  assert.equal(readFileSync(p.filePath, "utf8").trim().split("\n").length, 2);
});

test("producer bounds the per-session JSONL retention", async () => {
  const root = tempDir("pi-persona-telemetry-retention-");
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "bounded", emit: () => {}, heartbeatMs: 0, maxFileBytes: 1024 });
  p.start(instance);
  for (let i = 0; i < 20; i += 1) p.publish("instance.heartbeat", { contextPercent: i });
  await p.flush();
  const lines = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(readFileSync(p.filePath).length <= 1024);
  assert.equal(lines[0].type, "instance.started", "compaction must preserve the stream identity anchor");
  assert.equal(lines.at(-1).seq, 21);
});

test("compaction preserves the replay seed for a still-running agent", async () => {
  const root = tempDir("pi-persona-telemetry-live-retention-");
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "live-bounded", emit: () => {}, heartbeatMs: 0, maxFileBytes: 1024 });
  p.start(instance);
  p.publishAgentAdded({ id: "long-run", label: "Long run", kind: "subagent", status: "running" });
  for (let i = 0; i < 30; i += 1) p.publish("instance.heartbeat", { contextPercent: i });
  await p.flush();
  const lines = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.some((event) => event.type === "agent.added" && event.payload.id === "long-run"));
  assert.equal(lines.at(-1).seq, 32);
});

/** The replay seed set scales with LIVE WORK, not with the cap — one line per live agent, per
 *  updated agent field and per unfinished tool. Seeded into compaction unbounded it outgrows maxBytes
 *  on its own: the file never comes back under the cap, and from then on EVERY append pays a full
 *  read + rewrite + rename while the tail loop can retain nothing but the newest record. */
test("compaction bounds the replay seed set so the cap holds and rewrites stay amortized", async () => {
  const root = tempDir("pi-persona-telemetry-seed-bound-");
  const maxFileBytes = 8192;
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "seed-bound", emit: () => {}, heartbeatMs: 0, maxFileBytes });
  p.start(instance);
  await p.flush();

  // Compaction runs exactly when the raw append pushes the file past the cap, so the size left by the
  // previous append plus this record's bytes decides it — counted from outside, with no seam added.
  let compactions = 0;
  let size = statSync(p.filePath).size;
  let peak = size;
  let appends = 0;
  for (let i = 0; i < 150; i += 1) {
    for (const event of [
      p.publishAgentAdded({ id: `run-${i}`, label: `agent ${i}`, kind: "subagent", status: "running" }),
      p.publish("instance.heartbeat", { contextPercent: i % 100 }),
    ]) {
      if (size + Buffer.byteLength(JSON.stringify(event)) + 1 > maxFileBytes) compactions += 1;
      await p.flush();
      size = statSync(p.filePath).size;
      peak = Math.max(peak, size);
      appends += 1;
    }
  }

  assert.ok(peak <= maxFileBytes, `the log reached ${peak} bytes under a ${maxFileBytes}-byte cap`);
  assert.ok(compactions * 4 <= appends, `compaction ran ${compactions} times over ${appends} appends`);
  const lines = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(lines[0].type, "instance.started", "compaction must preserve the stream identity anchor");
  assert.equal(lines.at(-1).seq, 301, "the newest complete record always survives");
  const seeded = lines.filter((event) => event.type === "agent.added").map((event) => event.payload.id);
  // The stalest replay seed is what gets shed, never the newest: a consumer keeps the live work it is
  // most likely to still be watching.
  assert.ok(seeded.includes("run-149"), "the newest live agent lost its replay seed");
  assert.ok(!seeded.includes("run-0"), "the seed set is still unbounded — nothing was shed");
});

/** A live agent's seed group is its `agent.added` plus the records that patched it, and `fields`
 *  is keyed by FIELD NAME — so one `agent.updated` carrying N fields appears N times in the group.
 *  Sized once per appearance, the budget over-estimates a multi-field patch by up to 6x and sheds
 *  live agents whose seeds actually fit. */
test("compaction sizes a multi-field agent patch once, so a live agent that fits is not shed", async () => {
  const root = tempDir("pi-persona-telemetry-seed-dedupe-");
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "seed-dedupe", emit: () => {}, heartbeatMs: 0, maxFileBytes: 2048 });
  p.start(instance);
  p.publishAgentAdded({ id: "first", label: "first", kind: "subagent", status: "running" });
  p.publishAgentAdded({ id: "second", label: "second", kind: "subagent", status: "running" });
  // ONE record, three patched fields: three map entries pointing at the same line.
  p.publishAgentUpdated("first", { label: "first (busy)", persona: "dev", model: "provider/model" });
  for (let i = 0; i < 12; i += 1) p.publish("instance.heartbeat", { contextPercent: i });
  await p.flush();

  const lines = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as any);
  const seeded = lines.filter((event) => event.type === "agent.added").map((event) => event.payload.id);
  assert.ok(seeded.includes("second"), "the newest live agent lost its replay seed");
  assert.ok(seeded.includes("first"), "the patched agent was shed although its seeds fit the budget");
});

/** The `pinned` snapshot taken before the live seeds join `keep` is load-bearing: a log with no
 *  instance.started falls back to line 0 as the stream anchor, and that line can BE a live agent's
 *  `added`. Shedding its group would take the anchor with it. */
test("compaction keeps the fallback anchor when line 0 is itself a live agent's seed", async () => {
  const root = tempDir("pi-persona-telemetry-seed-anchor-");
  const p = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "seed-anchor", emit: () => {}, heartbeatMs: 0, maxFileBytes: 1024 });
  // No start(): the first record of this log is the oldest live agent — the first seed to be shed.
  for (let i = 0; i < 40; i += 1) p.publishAgentAdded({ id: `run-${i}`, label: `agent ${i}`, kind: "subagent", status: "running" });
  await p.flush();

  const lines = readFileSync(p.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(lines[0].payload.id, "run-0", "the anchor line was shed with the live seed that shares it");
  assert.equal(lines.at(-1).seq, 40, "the newest complete record always survives");
});

test("producer recovers a log left in the compaction backup", async () => {
  const root = tempDir("pi-persona-telemetry-recovery-");
  const first = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "recover", emit: () => {}, heartbeatMs: 0 });
  first.publish("instance.heartbeat", { contextPercent: 1 });
  await first.flush();
  const backup = `${first.filePath}.previous`;
  writeFileSync(backup, readFileSync(first.filePath));
  rmSync(first.filePath);
  const recoveredEvents: any[] = [];
  const recovered = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "recover", emit: (event) => recoveredEvents.push(event), heartbeatMs: 0 });
  recovered.publish("instance.heartbeat", { contextPercent: 2 });
  await recovered.flush();
  assert.equal(recoveredEvents[0]?.seq, 2);
});

test("a torn final line is repaired so the first event after a crash survives", async () => {
  const root = tempDir("pi-persona-telemetry-torn-");
  const first = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "torn", emit: () => {}, heartbeatMs: 0 });
  first.start(instance);
  first.publish("tool.started", { callId: "c1", agentId: "a1", name: "read", status: "running" });
  await first.flush();
  // A crash mid-append leaves a partial record with no trailing newline.
  appendFileSync(first.filePath, `{"version":2,"producerId":"pi-persona","producerVer`);

  const resumed = new TelemetryProducer({ agentDir: root, cwd: "/work", sessionId: "torn", emit: () => {}, heartbeatMs: 0 });
  resumed.publish("tool.finished", { callId: "c1", agentId: "a1", name: "read", status: "done", durationMs: 5 });
  resumed.publishAgentAdded({ id: "a1", label: "agent", kind: "subagent", status: "running" });
  await resumed.flush();

  const parsed = readFileSync(resumed.filePath, "utf8").split("\n").filter((line) => line.length > 0)
    .flatMap((line) => { try { return [JSON.parse(line) as any]; } catch { return []; } });
  assert.ok(parsed.some((event) => event.type === "tool.finished" && event.seq === 3), "the record written after the tear is not swallowed by it");
  assert.ok(parsed.some((event) => event.type === "agent.added" && event.seq === 4));
});

/** `mode` is honoured only by the write that CREATES the file, so a call that omits it is a hole
 *  exactly where it matters: a first activation, or a repair racing the compaction swap, which
 *  leaves the log momentarily unlinked. Checked against the source because the effective mode is
 *  unobservable on Windows, where the runners live. */
test("every write in the producer pins owner-only permissions", () => {
  const source = readFileSync(new URL("../../../src/telemetry/producer.ts", import.meta.url), "utf8");
  const writes = source.split("\n").flatMap((line, index) =>
    /\b(appendFile|appendFileSync|writeFile|writeFileSync)\(/.test(line) ? [{ at: index + 1, text: line.trim() }] : []);
  assert.ok(writes.length >= 3, "the producer's write sites moved or changed shape");
  for (const write of writes) {
    assert.match(write.text, /mode: 0o600/, `producer.ts:${write.at} persists without owner-only permissions: ${write.text}`);
  }
});

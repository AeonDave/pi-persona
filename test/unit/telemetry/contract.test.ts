import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTelemetryEvent, TELEMETRY_VERSION, type TelemetryEvent } from "../../../src/telemetry/contract.ts";

test("v2 accepts a namespaced event from a future producer", () => {
  const event = {
    version: TELEMETRY_VERSION,
    producerId: "other.plugin",
    producerVersion: "2.3.0",
    id: "other.plugin:session:1",
    seq: 1,
    ts: 1,
    sessionId: "session",
    workspaceId: "0123456789abcdef01234567",
    type: "other.plugin.status.changed",
    payload: { state: "ready" },
  };
	assert.deepEqual(parseTelemetryEvent(event), { ...event, payload: {} });
});

test("common instance lifecycle does not require pi-persona metadata", () => {
	const event = {
		version: TELEMETRY_VERSION,
		producerId: "future.plugin",
		producerVersion: "1.0.0",
		id: "future.plugin:session:1",
		seq: 1,
		ts: 1,
		sessionId: "session",
		workspaceId: "0123456789abcdef01234567",
		type: "instance.started",
		payload: { displayName: "future worker", status: "active" },
	};
	assert.ok(parseTelemetryEvent(event), "persona, model, process metrics and exocom are optional adapter metadata");
});

test("legacy v1 is readable and sensitive projection fields are removed", () => {
  const legacy = {
    version: 1,
    id: "session:1",
    seq: 1,
    ts: 1,
    sessionId: "session",
    workspaceId: "0123456789abcdef01234567",
    type: "agent.added",
    payload: { id: "a", label: "agent", kind: "subagent", status: "running", task: "secret prompt", detail: "cat /secret" },
  };
  const parsed = parseTelemetryEvent(legacy) as TelemetryEvent;
  assert.equal(parsed.producerId, "pi-persona");
  assert.equal((parsed.payload as Record<string, unknown>).task, undefined);
  assert.equal((parsed.payload as Record<string, unknown>).detail, undefined);
});

test("known event payloads require their semantic fields", () => {

  const malformed = { version: TELEMETRY_VERSION, producerId: "pi-persona", producerVersion: "1.10.5", id: "p:s:1", seq: 1, ts: 1, sessionId: "s", workspaceId: "0123456789abcdef01234567", type: "tool.started", payload: {} };
  assert.equal(parseTelemetryEvent(malformed), undefined);
});

test("incremental instance validation matches consumer numeric bounds and extra-field projection", () => {
  const base = {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: "p:s:1",
    seq: 1,
    ts: 1,
    sessionId: "s",
    workspaceId: "0123456789abcdef01234567",
  };
  for (const payload of [
    { pid: 1.5 },
    { pid: -1 },
    { contextPercent: -0.01 },
    { contextPercent: 100.01 },
  ]) {
    assert.equal(parseTelemetryEvent({ ...base, type: "instance.heartbeat", payload }), undefined);
    assert.equal(parseTelemetryEvent({ ...base, type: "instance.updated", payload }), undefined);
  }

  const projected = parseTelemetryEvent({
    ...base,
    type: "instance.heartbeat",
    payload: { contextPercent: 50, producerPrivate: "discard me" },
  });
  assert.deepEqual(projected?.payload, { contextPercent: 50 });
});

test("known common payload validation enforces lifecycle phases and numeric bounds", () => {
  const base = {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: "p:s:1",
    seq: 1,
    ts: 1,
    sessionId: "s",
    workspaceId: "0123456789abcdef01234567",
  };
  assert.equal(parseTelemetryEvent({ ...base, type: "tool.finished", payload: { callId: "tc", agentId: "a", name: "x", status: "running" } }), undefined);
  assert.equal(parseTelemetryEvent({ ...base, type: "instance.heartbeat", payload: { contextPercent: Number.NaN } }), undefined);
  assert.equal(parseTelemetryEvent({ ...base, type: "peers.snapshot", payload: { peers: [{ sessionId: "p", displayName: "p", contextPercent: -1, status: "online", sent: -1, received: 0 }] } }), undefined);
});

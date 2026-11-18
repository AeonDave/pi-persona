import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";

import { EXOCOM_RELOAD_ENTRY, createReloadSnapshot, findReloadSnapshot, unconsumedReloadIds } from "../../../src/exocom/reload.ts";

const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
const target = `peer@${createHash("sha256").update("peer-session").digest("hex").slice(0, 24)}`;
const notice = (id: string) => ({
	text: `[peer] fenced ${id}`,
	message: { from: "peer", text: `body ${id}`, id, kind: "message" },
	receipt: { sender: "peer-session", id },
	context: { msg_id: id, hops: 2, replyTarget: target, entry: { session_id: "peer-session", name: "peer", persona: "", purpose: "", color: "", model: "", pid: 1, endpoint: "endpoint", cwd: "cwd", context_pct: 0, inbox: 0, heartbeat_at: "2026-01-01T00:00:00.000Z", public_key: publicKey } },
});
const entry = (data: unknown) => ({ type: "custom", customType: EXOCOM_RELOAD_ENTRY, data });

test("reload snapshot keeps FIFO text and receipt identity, and consumes once across branches", () => {
	const snapshot = createReloadSnapshot("snapshot-1", "session-1", "scope-1", "agent-dir", 1000, [notice("1"), notice("2")]);
	assert.ok(snapshot);
	const found = findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-1", "scope-1", "agent-dir", 1100);
	assert.deepEqual(found?.items, [notice("1"), notice("2")]);
	const consumed = entry({ kind: "consumed", id: snapshot.id, sessionId: "session-1" });
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot), consumed], "session-1", "scope-1", "agent-dir", 1100), undefined);
});

test("reload snapshot fails closed for wrong session, scope, branch, expiry, and malformed state", () => {
	const snapshot = createReloadSnapshot("snapshot-1", "session-1", "scope-1", "agent-dir", 1000, [notice("1")]);
	assert.ok(snapshot);
	assert.equal(findReloadSnapshot([], [entry(snapshot)], "session-1", "scope-1", "agent-dir", 1100), undefined);
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-2", "scope-1", "agent-dir", 1100), undefined);
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-1", "scope-2", "agent-dir", 1100), undefined);
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-1", "scope-1", "other-dir", 1100), undefined);
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-1", "scope-1", "agent-dir", 302000), undefined);
	assert.equal(findReloadSnapshot([entry(snapshot)], [entry(snapshot)], "session-1", "scope-1", "agent-dir", 999), undefined);
	const malformed = entry({ ...snapshot, items: [{ text: "bad" }] });
	assert.equal(findReloadSnapshot([malformed], [malformed], "session-1", "scope-1", "agent-dir", 1100), undefined);
});

test("reload snapshots reject oversized or duplicate input rather than silently dropping it", () => {
	assert.equal(createReloadSnapshot("s", "session", "scope", "dir", 1000, [notice("1"), notice("1")]), undefined);
	assert.equal(createReloadSnapshot("s", "session", "scope", "dir", 1000, [{ ...notice("1"), text: "x".repeat(200_000) }]), undefined);
	assert.equal(createReloadSnapshot("s", "session", "scope", "dir", 1000, Array.from({ length: 61 }, (_, index) => notice(String(index)))), undefined);
	assert.equal(createReloadSnapshot("s", "session", "scope", "dir", 1000, []), undefined);
});

test("reload rejects forged or corrupt authenticated reply metadata", () => {
	const original = notice("1");
	for (const context of [
		{ ...original.context, hops: -1 },
		{ ...original.context, hops: 7 },
		{ ...original.context, replyTarget: "peer@000000000000000000000000" },
		{ ...original.context, entry: { ...original.context.entry, public_key: "invalid" } },
	]) {
		const corrupt = entry({ kind: "snapshot", id: "s", sessionId: "session", scope: "scope", agentDir: "dir", createdAt: 1000, items: [{ ...original, context }] });
		assert.equal(findReloadSnapshot([corrupt], [corrupt], "session", "scope", "dir", 1100), undefined);
	}
});

test("startup invalidates every outstanding snapshot for this session, including another branch", () => {
	const first = createReloadSnapshot("one", "session", "scope", "dir", 1000, [notice("1")]);
	const other = createReloadSnapshot("two", "session", "scope", "dir", 1001, [notice("2")]);
	const foreign = createReloadSnapshot("three", "foreign", "scope", "dir", 1001, [notice("3")]);
	assert.deepEqual(unconsumedReloadIds([entry(first), entry(other), entry(foreign)], "session"), ["one", "two"]);
	const markers = ["one", "two"].map((id) => entry({ kind: "consumed", id, sessionId: "session" }));
	assert.deepEqual(unconsumedReloadIds([entry(first), entry(other), entry(foreign), ...markers], "session"), []);
	assert.equal(findReloadSnapshot([entry(other)], [entry(first), entry(other), ...markers], "session", "scope", "dir", 1100), undefined);
});

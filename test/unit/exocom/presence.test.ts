import { test } from "node:test";
import assert from "node:assert/strict";

import {
	ExocomPeerPresenceStore,
	projectExocomPeerPresence,
	type ExocomPeerPresenceInput,
} from "../../../src/exocom/presence.ts";

const NOW = 1_700_000_000_000;
const HEARTBEAT = new Date(NOW - 1_000).toISOString();

function peer(overrides: Partial<ExocomPeerPresenceInput> = {}): ExocomPeerPresenceInput {
	return {
		sessionId: "session-quartz",
		name: "Quartz",
		persona: "reviewer",
		model: "provider/model",
		contextPercent: 42,
		heartbeatAt: HEARTBEAT,
		...overrides,
	};
}

function withoutKey<T extends { key: string }>(row: T): Omit<T, "key"> {
	const { key, ...copy } = row;
	void key;
	return copy;
}

test("peer presence projects heartbeat freshness without routing or workload authority", () => {
	const presence = projectExocomPeerPresence([
		peer({ name: "Quartz" }),
		peer({ name: "Stale", sessionId: "session-stale", heartbeatAt: new Date(NOW - 60_000).toISOString() }),
		peer({ name: "Unknown", sessionId: "session-unknown", heartbeatAt: "invalid", contextPercent: Number.NaN, persona: "", model: "" }),
	], NOW, 10_000);

	assert.deepEqual(presence.map(withoutKey), [
		{ name: "Quartz", persona: "reviewer", model: "provider/model", contextPercent: 42, status: "online" },
		{ name: "Stale", persona: "reviewer", model: "provider/model", contextPercent: 42, status: "idle" },
		{ name: "Unknown", status: "idle" },
	]);
	assert.ok(presence.every((row) => /^peer:[a-f0-9]{16}$/.test(row.key)));
	assert.ok(presence.every((row) => !("sessionId" in row) && !("target" in row) && !("endpoint" in row)));
	assert.ok(presence.every((row) => !("busy" in row) && !("active" in row) && !("statusText" in row)));
});

test("peer presence bounds context and treats an invalid clock as stale", () => {
	const presence = projectExocomPeerPresence([
		peer({ sessionId: "high", name: "High", contextPercent: 148 }),
		peer({ sessionId: "low", name: "Low", contextPercent: -8 }),
	], Number.NaN, 10_000);
	assert.deepEqual(presence.map(withoutKey), [
		{ name: "High", persona: "reviewer", model: "provider/model", contextPercent: 100, status: "idle" },
		{ name: "Low", persona: "reviewer", model: "provider/model", contextPercent: 0, status: "idle" },
	]);
});

test("opaque peer keys distinguish sanitized display-name collisions without exposing routing ids", () => {
	const rows = projectExocomPeerPresence([
		peer({ sessionId: "first", name: "Peer-1" }),
		peer({ sessionId: "second", name: "Peer-1" }),
	], NOW, 10_000);
	assert.notEqual(rows[0]?.key, rows[1]?.key);
	assert.ok(rows.every((row) => !row.key.includes("first") && !row.key.includes("second")));
	assert.equal(
		projectExocomPeerPresence([peer({ sessionId: "first", name: "Renamed" })], NOW, 10_000)[0]?.key,
		rows[0]?.key,
		"display-name changes preserve the local row identity",
	);
});

test("presence store returns isolated sorted snapshots and notifies only on real changes", () => {
	const store = new ExocomPeerPresenceStore();
	let changes = 0;
	const unsubscribe = store.onChange(() => changes++);
	const peers = projectExocomPeerPresence([peer({ sessionId: "zulu", name: "Zulu" }), peer({ sessionId: "alpha", name: "Alpha" })], NOW, 10_000);
	store.publish(peers);
	assert.equal(changes, 1);
	assert.deepEqual(store.snapshot().map((item) => item.name), ["Alpha", "Zulu"]);

	const view = store.snapshot();
	view[0]!.name = "mutated by a consumer";
	assert.equal(store.snapshot()[0]?.name, "Alpha");
	store.publish([...peers].reverse());
	assert.equal(changes, 1, "directory iteration order does not trigger a repaint");
	store.publish(projectExocomPeerPresence([peer({ sessionId: "zulu", name: "Zulu" }), peer({ sessionId: "alpha", name: "Alpha", contextPercent: 43 })], NOW, 10_000));
	assert.equal(changes, 2);
	store.publish([]);
	assert.equal(changes, 3);
	assert.deepEqual(store.snapshot(), []);
	unsubscribe();
	store.publish(peers);
	assert.equal(changes, 3, "disposed observers stop receiving updates");
});

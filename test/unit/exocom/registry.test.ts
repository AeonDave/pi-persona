import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { prune, readAll, registryEntryFixture, removeEntry, writeEntry } from "../../../src/exocom/registry.ts";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "exo-reg-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const H = "hash1";
const entry = (over = {}) => registryEntryFixture({ session_id: "s1", name: "elite", pid: process.pid, ...over });

test("write then read round-trips an entry", () => {
	writeEntry(dir, H, entry());
	const all = readAll(dir, H);
	assert.equal(all.length, 1);
	assert.equal(all[0]?.name, "elite");
});

test("prune drops a dead pid AND a stale heartbeat, keeps the live one", () => {
	writeEntry(dir, H, entry({ session_id: "live", name: "live", pid: process.pid, heartbeat_at: new Date(1_000_000).toISOString() }));
	writeEntry(dir, H, entry({ session_id: "dead", name: "dead", pid: 999_999, heartbeat_at: new Date(1_000_000).toISOString() }));
	writeEntry(dir, H, entry({ session_id: "stale", name: "stale", pid: process.pid, heartbeat_at: new Date(0).toISOString() }));
	const live = prune(dir, H, { now: 1_000_000 + 30_000, staleMs: 120_000, isAlive: (p) => p === process.pid });
	const names = live.map((e) => e.name).sort();
	assert.deepEqual(names, ["live"], "dead pid + stale heartbeat both evicted");
	assert.deepEqual(readAll(dir, H).map((e) => e.name).sort(), ["live"], "files removed too");
});

// The registry FILE is keyed by session_id (hashed), not by name — two instances launched
// under the SAME persona name can never collide on a file, so there is nothing left to
// atomically claim/suffix (the deleted claimEntry existed only to make the NAME collision-safe
// as a file key).
test("writeEntry: same name, different session_id, persist as TWO separate files", () => {
	writeEntry(dir, H, entry({ session_id: "twin-a", name: "twin" }));
	writeEntry(dir, H, entry({ session_id: "twin-b", name: "twin" }));
	const all = readAll(dir, H).filter((e) => e.name === "twin");
	assert.equal(all.length, 2, "keyed by session_id, so the second write never clobbers the first");
	assert.deepEqual(all.map((e) => e.session_id).sort(), ["twin-a", "twin-b"]);
});

test("removeEntry takes a session_id and deletes the right file", () => {
	writeEntry(dir, H, entry({ session_id: "gone-sess", name: "gone" }));
	writeEntry(dir, H, entry({ session_id: "stays-sess", name: "gone" })); // same name, different file
	removeEntry(dir, H, "gone-sess");
	const remaining = readAll(dir, H).filter((e) => e.name === "gone");
	assert.deepEqual(remaining.map((e) => e.session_id), ["stays-sess"], "only the targeted session_id's file is removed");
});

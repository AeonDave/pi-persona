import assert from "node:assert/strict";
import { closeSync, openSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { tempDir } from "../../setup/temp-dir.ts";
import { agentsDir, registryPath } from "../../../src/exocom/paths.ts";
import { MAX_REGISTRY_FILE_BYTES, prune, readAll, registryEntryFixture, removeEntry, removeEntryIfMatches, sessionKey, writeEntry } from "../../../src/exocom/registry.ts";

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

test("workspace identity round-trips as a safe label plus stable id/code", () => {
	writeEntry(dir, H, entry({
		session_id: "workspace-metadata",
		workspace_id: "0123456789abcdef01234567",
		workspace_code: "Ab0T",
		workspace_label: "docs <archive>",
	}));
	const stored = readAll(dir, H).find((candidate) => candidate.session_id === "workspace-metadata");
	assert.equal(stored?.workspace_id, "0123456789abcdef01234567");
	assert.equal(stored?.workspace_code, "Ab0T");
	assert.equal(stored?.workspace_label, "docs archive");
});

test("workspace identity is all-or-none and malformed metadata fails closed", () => {
	for (const [session_id, malformed] of [
		["missing-code", { workspace_id: "0123456789abcdef01234567", workspace_label: "docs" }],
		["bad-id", { workspace_id: "../outside", workspace_code: "Ab0T", workspace_label: "docs" }],
		["bad-code", { workspace_id: "0123456789abcdef01234567", workspace_code: "abc/", workspace_label: "docs" }],
	] as const) {
		assert.throws(() => writeEntry(dir, H, entry({ session_id, ...malformed })), /invalid entry/);
	}
	writeEntry(dir, H, entry({ session_id: "legacy-no-workspace-metadata" }));
	assert.ok(readAll(dir, H).some((candidate) => candidate.session_id === "legacy-no-workspace-metadata"));
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

test("removeEntryIfMatches preserves a replacement with the same session_id", () => {
	const original = entry({ session_id: "owned-original", endpoint: "/old-endpoint", public_key: Buffer.from("old-key").toString("base64") });
	const replacement = entry({ session_id: "owned-original", endpoint: "/new-endpoint", public_key: Buffer.from("new-key").toString("base64") });
	writeEntry(dir, H, original);
	assert.equal(removeEntryIfMatches(dir, H, replacement), false, "a different endpoint/key is not ours to remove");
	assert.equal(readAll(dir, H).find((e) => e.session_id === original.session_id)?.endpoint, original.endpoint);
	assert.equal(removeEntryIfMatches(dir, H, original), true, "the exact owner can remove its entry");
	assert.equal(readAll(dir, H).some((e) => e.session_id === original.session_id), false);
});

test("removeEntryIfMatches keeps a replacement installed after comparison", () => {
	const original = entry({ session_id: "owned-after-compare", endpoint: "/old-after-compare", public_key: Buffer.from("old-after").toString("base64") });
	const replacement = entry({ session_id: original.session_id, endpoint: "/new-after-compare", public_key: Buffer.from("new-after").toString("base64") });
	writeEntry(dir, H, original);
	assert.equal(removeEntryIfMatches(dir, H, original, {
		afterCompare: () => writeEntry(dir, H, replacement),
	}), true);
	const stored = readAll(dir, H).find((e) => e.session_id === original.session_id);
	assert.equal(stored?.endpoint, replacement.endpoint, "the post-compare replacement was not deleted");
	assert.equal(stored?.public_key, replacement.public_key);
});

test("prune does not delete a replacement installed after its initial registry read", () => {
	const stale = entry({ session_id: "prune-replaced", endpoint: "/before-prune", public_key: Buffer.from("before").toString("base64"), heartbeat_at: new Date(0).toISOString() });
	const replacement = entry({ session_id: stale.session_id, endpoint: "/after-prune", public_key: Buffer.from("after").toString("base64"), heartbeat_at: new Date(1_000_000).toISOString() });
	writeEntry(dir, H, stale);
	const live = prune(dir, H, {
		now: 1_000_000 + 30_000,
		staleMs: 120_000,
		isAlive: () => {
			// Simulate another instance replacing the slot after prune() read it but
			// before the stale entry is removed.
			writeEntry(dir, H, replacement);
			return false;
		},
	});
	assert.deepEqual(live, [], "the original entry was stale");
	const stored = readAll(dir, H).find((e) => e.session_id === stale.session_id);
	assert.equal(stored?.endpoint, replacement.endpoint, "prune leaves the replacement intact");
	assert.equal(stored?.public_key, replacement.public_key);
});

// The preserve-from-disk step below only covers the file-STILL-EXISTS case. An entry can be
// evicted while its instance is very much alive (a peer's transient send error calls removeEntry,
// or a >STALE_AFTER_MS stall lets every peer prune it), and the next heartbeat RE-CREATES the
// file from scratch — with nothing on disk to preserve from. The key exists nowhere but the
// writing process, so writeEntry remembers the keys IT registered; otherwise a live instance
// becomes permanently unverifiable (every frame it signs fails verifyFrameOrigin) for the rest of
// the session, no matter which caller does the heartbeat.
test("a heartbeat that re-creates a DELETED entry still carries the key this process registered", () => {
	const publicKey = Buffer.from("resurrect-ed25519-key").toString("base64");
	writeEntry(dir, H, entry({ session_id: "evicted-session", name: "before", public_key: publicKey }));
	removeEntry(dir, H, "evicted-session");
	writeEntry(dir, H, entry({ session_id: "evicted-session", name: "after" }));
	const stored = readAll(dir, H).find((e) => e.session_id === "evicted-session");
	assert.equal(stored?.name, "after", "the re-registration carries the fresh metadata");
	assert.equal(stored?.public_key, publicKey, "a re-CREATED entry stays authenticable");
});

test("the in-process key memo is per-session_id — it never lends one instance's key to another", () => {
	writeEntry(dir, H, entry({ session_id: "keyed-one", name: "keyed", public_key: Buffer.from("k1").toString("base64") }));
	writeEntry(dir, H, entry({ session_id: "keyless-two", name: "keyless" }));
	const stored = readAll(dir, H).find((e) => e.session_id === "keyless-two");
	assert.equal(stored?.public_key, undefined, "a session that never registered a key gets none");
});

test("a heartbeat falls back to an in-place write when the rename can never win (a contended entry)", () => {
	// Windows: renameSync throws EPERM while ANY other handle holds the target open (Defender, the
	// search indexer, a peer mid-read). Losing the heartbeat drops this instance out of every
	// peer's pool, so a write that lands beats one that is atomic.
	const own = tempDir("exo-reg-lock-");
	const waits: number[] = [];
	writeEntry(own, H, entry({ session_id: "locked-sess", name: "locked" }), {
		rename: () => {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		},
		sleep: (ms) => waits.push(ms),
	});
	assert.deepEqual(readAll(own, H).map((e) => e.name), ["locked"], "the heartbeat persisted anyway");
	assert.ok(waits.length > 0, "the contended rename was retried before giving up");
	const dirFiles = readdirSync(agentsDir(own, H));
	assert.deepEqual(dirFiles.filter((f) => !f.endsWith(".json")), [], "no scratch temp file is left behind");
});

test("a heartbeat retries a contended rename and keeps the atomic path when it wins", () => {
	const own = tempDir("exo-reg-retry-");
	let attempts = 0;
	writeEntry(own, H, entry({ session_id: "busy-sess", name: "busy" }), {
		rename: (from, to) => {
			attempts++;
			if (attempts === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
			renameSync(from, to);
		},
		sleep: () => {},
	});
	assert.equal(attempts, 2, "the second attempt renamed");
	assert.deepEqual(readAll(own, H).map((e) => e.name), ["busy"]);
});

test("a heartbeat lands while another process holds the entry open for reading", () => {
	// The routine Windows case the two tests above simulate, played for real: an open handle can
	// block the rename but never the write.
	const own = tempDir("exo-reg-open-");
	writeEntry(own, H, entry({ session_id: "held-sess", name: "before" }));
	const held = openSync(registryPath(own, H, sessionKey("held-sess")), "r");
	try {
		writeEntry(own, H, entry({ session_id: "held-sess", name: "after" }));
	} finally {
		closeSync(held);
	}
	assert.deepEqual(readAll(own, H).map((e) => e.name), ["after"], "the heartbeat landed despite the open handle");
});

test("heartbeat rewrite preserves the existing public_key for the same session_id", () => {
	const publicKey = Buffer.from("test-ed25519-public-key").toString("base64");
	writeEntry(dir, H, entry({ session_id: "heartbeat-session", name: "before", public_key: publicKey }));
	writeEntry(dir, H, entry({ session_id: "heartbeat-session", name: "after" }));
	const stored = readAll(dir, H).find((e) => e.session_id === "heartbeat-session");
	assert.equal(stored?.name, "after", "heartbeat metadata is refreshed");
	assert.equal(stored?.public_key, publicKey, "heartbeat cannot erase the plane-owned authentication key");
});

test("readAll skips a registry file larger than the size cap", () => {
	const key = sessionKey("huge-session");
	const path = registryPath(dir, H, key);
	writeEntry(dir, H, entry({ session_id: "huge-session", name: "huge" }));
	writeFileSync(path, `${"x".repeat(MAX_REGISTRY_FILE_BYTES + 8)}`);
	assert.equal(readAll(dir, H).some((e) => e.session_id === "huge-session"), false);
});

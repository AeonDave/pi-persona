import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../../setup/temp-dir.ts";
import {
	personaModels,
	readPersonaConfigs,
	withPersonaModels,
	writePersonaConfigs,
} from "../../../src/persona/config-store.ts";

test("config is indexed by persona name — same strategy, two personas, two configs", () => {
	let store = withPersonaModels({}, "magi", { melchior: "prov/a", balthasar: "prov/b" });
	store = withPersonaModels(store, "tribunal", { melchior: "prov/x" }); // different persona, same role name
	assert.deepEqual(personaModels(store, "magi"), { melchior: "prov/a", balthasar: "prov/b" });
	assert.deepEqual(personaModels(store, "tribunal"), { melchior: "prov/x" });
	assert.deepEqual(personaModels(store, "unknown"), {});
});

test("withPersonaModels merges into the existing persona config without dropping other agents", () => {
	const store = withPersonaModels(withPersonaModels({}, "magi", { melchior: "a" }), "magi", { casper: "c" });
	assert.deepEqual(personaModels(store, "magi"), { melchior: "a", casper: "c" });
});

test("read/write round-trips through a JSON file; missing/invalid file reads as empty", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	assert.deepEqual(readPersonaConfigs(file), {}, "missing file → empty store");
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }));
	assert.equal(personaModels(readPersonaConfigs(file), "magi").melchior, "prov/a");
});

test("a save keeps personas another pi instance wrote after this store was read", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }));
	const sessionA = readPersonaConfigs(file); // session A's snapshot, taken at session_start
	writePersonaConfigs(file, withPersonaModels(readPersonaConfigs(file), "tribunal", { arbiter: "prov/b" }));
	writePersonaConfigs(file, withPersonaModels(sessionA, "magi", { casper: "prov/c" }));
	const after = readPersonaConfigs(file);
	assert.equal(personaModels(after, "tribunal").arbiter, "prov/b", "session B's persona survives session A's save");
	assert.equal(personaModels(after, "magi").casper, "prov/c");
	assert.equal(personaModels(after, "magi").melchior, "prov/a");
});

test("a save keeps another instance's assignment for a different agent of the SAME persona", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	const sessionA = readPersonaConfigs(file); // both sessions start from an empty store
	writePersonaConfigs(file, withPersonaModels(readPersonaConfigs(file), "magi", { casper: "prov/b" }));
	writePersonaConfigs(file, withPersonaModels(sessionA, "magi", { melchior: "prov/a" }));
	const after = personaModels(readPersonaConfigs(file), "magi");
	assert.equal(after.casper, "prov/b", "session B's agent survives session A's save of the same persona");
	assert.equal(after.melchior, "prov/a");
});

test("a config that parses but isn't an object is kept as .bak before the next save replaces it", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writeFileSync(file, '["not", "a", "config"]', "utf8");
	assert.deepEqual(readPersonaConfigs(file), {});
	assert.match(readFileSync(`${file}.bak`, "utf8"), /not a config|"not"/);
});

test("a corrupt config is kept as config.json.bak instead of being silently overwritten", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writeFileSync(file, '{"magi": {"models": {"melchior": "prov/a"', "utf8"); // truncated by a crash
	assert.deepEqual(readPersonaConfigs(file), {});
	assert.match(readFileSync(`${file}.bak`, "utf8"), /melchior/);
});

test("the .bak keeps the FIRST corrupt copy — a second bad parse must not destroy the recoverable one", () => {
	// The fault that corrupts the file (a sync client, a failing disk) tends to recur, and the
	// second corruption is typically the emptier one. Overwriting would discard the only copy
	// that still held the user's assignments — the exact thing the backup exists to keep.
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writeFileSync(file, '{"magi": {"models": {"melchior": "prov/a"', "utf8");
	readPersonaConfigs(file);
	writeFileSync(file, "{", "utf8"); // corrupted again, this time with nothing left in it
	readPersonaConfigs(file);
	assert.match(readFileSync(`${file}.bak`, "utf8"), /melchior/, "the first backup survives");
});

test("a save falls back to an in-place write when the rename can never win (a locked target)", () => {
	// Windows: renameSync throws EPERM while ANY other handle holds the target open. Losing the
	// save would re-prompt the model picker every session, so a write that survives beats one
	// that is atomic.
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	const waits: number[] = [];
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }), {
		rename: () => {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		},
		sleep: (ms) => waits.push(ms),
	});
	assert.equal(personaModels(readPersonaConfigs(file), "magi").melchior, "prov/a", "the assignment persisted anyway");
	assert.ok(waits.length > 0, "the contended rename was retried before giving up");
	assert.deepEqual(readdirSync(dir), ["config.json"], "no scratch .tmp file is left behind");
});

test("a save retries a contended rename and keeps the atomic path when it wins", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	let attempts = 0;
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }), {
		rename: (from, to) => {
			attempts++;
			if (attempts === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
			renameSync(from, to);
		},
		sleep: () => {},
	});
	assert.equal(attempts, 2, "the second attempt renamed");
	assert.equal(personaModels(readPersonaConfigs(file), "magi").melchior, "prov/a");
});

test("a save succeeds while another process holds the config open for reading", () => {
	// The routine Windows case (Defender, a sync client, a second pi instance mid-read): an
	// open handle blocks the rename but not a write.
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }));
	const held = openSync(file, "r");
	try {
		writePersonaConfigs(file, withPersonaModels({}, "magi", { casper: "prov/c" }));
	} finally {
		closeSync(held);
	}
	const after = personaModels(readPersonaConfigs(file), "magi");
	assert.equal(after.casper, "prov/c", "the save landed despite the open handle");
	assert.equal(after.melchior, "prov/a");
	assert.ok(!existsSync(`${file}.bak`), "a successful save is not a corruption");
});

test("a save MERGES — an assignment left out of the store is preserved, not removed", () => {
	// Documented, load-bearing limitation: the merge exists so a concurrent instance's save
	// survives ours, and it cannot tell "the user cleared this" from "this store never saw it".
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a", casper: "prov/c" }));
	writePersonaConfigs(file, { magi: { models: { melchior: "prov/a" } } }); // casper dropped by the caller
	assert.equal(personaModels(readPersonaConfigs(file), "magi").casper, "prov/c", "removal is not expressible");
});

test("a save holds one lock across its read/merge/write transaction", () => {
	const dir = tempDir("pi-persona-cfg-");
	const file = join(dir, "config.json");
	let locked = false;
	let released = false;
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }), {
		acquireLock: () => {
			assert.equal(locked, false);
			locked = true;
			return () => {
				locked = false;
				released = true;
			};
		},
		rename: (from, to) => {
			assert.equal(locked, true, "the lock covers the read/merge/write critical section");
			renameSync(from, to);
		},
		sleep: () => {},
	});
	assert.equal(locked, false);
	assert.equal(released, true);
});

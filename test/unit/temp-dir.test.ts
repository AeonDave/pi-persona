import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registeredTempDirs, removeTempDirs, tempDir } from "../setup/temp-dir.ts";

test("tempDir hands back a fresh, usable directory inside the temp dir", () => {
	const dir = tempDir("pi-persona-selftest-");
	assert.ok(existsSync(dir), "the dir exists — callers write into it immediately");
	assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), `expected a temp dir, got ${dir}`);
	assert.ok(path.basename(dir).startsWith("pi-persona-selftest-"), "the caller's prefix survives, so a leak stays traceable to its fixture");
	assert.notEqual(tempDir("pi-persona-selftest-"), dir, "two calls are two directories");
});

test("a minted dir is registered for removal — that registration IS the fix", () => {
	// Minting without registering is exactly the tens-of-thousands-of-directories bug this module
	// exists to end, and it is invisible until the process exits. Assert the registration here,
	// where it is cheap; the probe in test/integration/temp-dir.test.ts assures the drain.
	const dir = tempDir("pi-persona-selftest-");
	assert.ok(registeredTempDirs().includes(dir), `${dir} was minted and nothing will ever remove it`);
});

test("minting N dirs installs ONE exit hook, not N", () => {
	// A full run mints hundreds of dirs. One `process.on("exit")` per dir trips Node's max-listeners
	// warning past ten and prints MaxListenersExceededWarning across a green suite — so the pending
	// dirs are a set drained by a single handler.
	tempDir("pi-persona-selftest-"); // whichever call installs the hook, it has already happened
	const before = process.listenerCount("exit");
	assert.ok(before >= 1, "the drain is hooked to process exit");
	for (let i = 0; i < 5; i++) tempDir("pi-persona-selftest-");
	assert.equal(process.listenerCount("exit"), before, "more dirs must not mean more listeners");
});

test("removeTempDirs takes away a directory that has contents in it", () => {
	const dir = tempDir("pi-persona-selftest-");
	mkdirSync(path.join(dir, "nested"));
	writeFileSync(path.join(dir, "nested", "file.txt"), "x"); // a fixture dir is never empty
	removeTempDirs([dir]);
	assert.equal(existsSync(dir), false, "a populated fixture dir has to go too, or nothing is cleaned");
});

test("a dir that refuses to be removed does not stop the rest, and never throws", () => {
	// On Windows a fixture dir is transiently unremovable whenever Defender or the search indexer
	// holds a handle inside it. Cleanup runs at process exit, so a throw there turns a nuisance
	// (one leaked dir) into a defect: a crashed run reported after a green suite. The path below
	// stands in for that lock — a NUL byte makes rmSync reject it, on every platform, so the
	// failure path is covered off Windows too.
	const locked = path.join(os.tmpdir(), `pi-persona-selftest-${String.fromCharCode(0)}-locked`);
	const real = tempDir("pi-persona-selftest-");
	removeTempDirs([locked, real]);
	assert.equal(existsSync(real), false, "the dirs after the failing one are still removed");
});

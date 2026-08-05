/**
 * The suite's temp-directory hygiene, observed from outside a test process.
 *
 * Every fixture in this suite works in a `mkdtempSync` directory, and for a long time almost none
 * of them were removed: tens of thousands of `pi-persona-*` dirs, roughly five hundred per full
 * run, accumulated in the user's temp folder. The fix is a choke point (test/setup/temp-dir.ts)
 * that mints AND registers, so a future test author gets cleanup by using the helper rather than
 * by remembering — but a choke point that only cleans up when nothing went wrong is the same leak
 * in a new costume.
 *
 * So these tests spawn a probe that mints dirs on all four paths a real test process takes —
 * module scope, a passing test, a test that throws, an unhandled top-level crash — and then look
 * for those directories once the probe is gone. Nothing here can be satisfied by a cleanup that
 * runs in a `finally` inside a happy path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = path.join(REPO_ROOT, "test", "fixtures", "temp-dir-probe.mjs");

/** Runs the probe to completion and returns the KEY=value lines it printed. The probe fails a test
 *  (and, in `crash` mode, dies outright) on purpose, so a non-zero exit is the expected outcome and
 *  its stdout has to be recovered from the error. */
function probe(...args: string[]): Record<string, string> {
	let stdout: string;
	try {
		stdout = execFileSync(process.execPath, ["--import", "tsx", PROBE, ...args], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		stdout = (err as { stdout?: string }).stdout ?? "";
	}
	const seen: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) seen[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return seen;
}

test("a test process takes every dir it minted away with it, including the ones a failure left behind", () => {
	const seen = probe();
	for (const key of ["MODULE_DIR", "PASS_DIR", "THROW_DIR"]) {
		const dir = seen[key];
		assert.ok(dir, `the probe did not report ${key} — stdout was ${JSON.stringify(seen)}`);
		assert.equal(existsSync(dir ?? ""), false, `${key} outlived its process: ${dir}`);
	}
	// THROW_DIR is the one that matters most: it was minted by a test body that then threw, which is
	// how a fixture dir gets orphaned on a red run — precisely when nobody is looking at temp.
});

test("a dir minted before the crash is still removed when the process dies unhandled", () => {
	// The runner catches a throw inside a test. Nothing catches a top-level throw, and the suite
	// does crash: an unhandled rejection in a strategy, a fixture that cannot load. Cleanup keyed to
	// the runner's own lifecycle would quietly stop working exactly there.
	const seen = probe("crash");
	assert.ok(seen.CRASH_DIR, `the probe did not report CRASH_DIR — stdout was ${JSON.stringify(seen)}`);
	assert.equal(existsSync(seen.CRASH_DIR ?? ""), false, `a crash leaked ${seen.CRASH_DIR}`);
});

test("a fixture dir stays put for the whole process, so a later test can still inspect it", () => {
	// Tests in this suite read a dir after the body that created it has ended (seed.test.ts hands a
	// dir from one helper to another; extension.test.ts keeps its user dir for the whole file).
	// Draining per-test would be tidier and would break them, so the drain happens once, at exit.
	assert.equal(probe().LATE_INSPECT, "true", "a fixture must survive the test body that minted it");
});

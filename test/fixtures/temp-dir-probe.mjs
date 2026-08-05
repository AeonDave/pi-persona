// Reports what test/setup/temp-dir.ts actually leaves on disk once a test process is over.
// Cleanup that only runs when everything went well is the leak wearing a disguise, so this probe
// mints its dirs on the three paths that matter — module scope, a passing test, a test that throws
// — and prints each path so the parent can look for it after this process is gone. Run with
// `crash` to take the fourth path: an unhandled throw that the test runner never sees.

import { test } from "node:test";
import { existsSync } from "node:fs";

import { tempDir } from "../setup/temp-dir.ts";

const say = (key, value) => process.stdout.write(`${key}=${value}\n`);

say("MODULE_DIR", tempDir("pi-persona-probe-module-"));

if (process.argv.includes("crash")) {
	say("CRASH_DIR", tempDir("pi-persona-probe-crash-"));
	throw new Error("deliberate top-level crash — the probe's whole point");
}

let fromPassingTest = "";

test("mints a dir and returns normally", () => {
	fromPassingTest = tempDir("pi-persona-probe-pass-");
	say("PASS_DIR", fromPassingTest);
});

test("the dir an earlier test made is still there to be inspected", () => {
	// Some tests deliberately look at a fixture after the body that made it has ended. Cleanup that
	// fires per-test would break them, so the registry is drained once, at process exit.
	say("LATE_INSPECT", existsSync(fromPassingTest));
});

test("mints a dir and then throws", () => {
	say("THROW_DIR", tempDir("pi-persona-probe-throw-"));
	throw new Error("deliberate failure — the probe's whole point");
});

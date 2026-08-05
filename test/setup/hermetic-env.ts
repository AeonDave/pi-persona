/**
 * The test suite's environment choke point — loaded with `--import` (see package.json) so it
 * runs in the runner AND in every per-file child process before a single test module is
 * evaluated.
 *
 * pi-persona is configured entirely through PI_PERSONA_* variables, and the real activation
 * reads them straight off `process.env` (`resolveConfig(process.env)` in src/extension.ts). So a
 * developer who exports `PI_PERSONA_DEFAULT=dev` in their shell profile — exactly what the README
 * teaches — or a CI job that exports one for a live-drive, used to reconfigure the extension
 * under the tests and watch a correct suite go red. Neutralising the whole namespace once, here,
 * beats asking every future test to remember to pass an env: the tests that DO exercise a
 * variable still set it for themselves, after this has run.
 */

import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";

import { tempDir } from "./temp-dir.ts";

/** Deletes every variable in pi-persona's namespace from `env`, returning the names removed
 *  (sorted, so a caller can log a stable line). Prefix-based on purpose: a knob added tomorrow is
 *  covered the day it is added, without anyone touching this file.
 *
 *  The prefix match is case-INSENSITIVE, and that is load-bearing rather than tidy. Windows env
 *  vars are case-insensitive: `set pi_persona_default=dev` stores a lowercase key, yet
 *  `process.env.PI_PERSONA_DEFAULT` still answers "dev" — which is precisely how
 *  `resolveConfig(process.env)` reads it. A case-sensitive filter walks past that key and hands the
 *  whole namespace back to the extension under test, on the platform this project is developed on.
 *  Names are reported and deleted as stored, never case-normalised. */
export function scrubPiPersonaEnv(env: Record<string, string | undefined>): string[] {
	const removed = Object.keys(env)
		.filter((key) => key.toUpperCase().startsWith("PI_PERSONA_"))
		.sort();
	for (const key of removed) delete env[key];
	return removed;
}

scrubPiPersonaEnv(process.env);

/** Marks the throwaway agent dir below, and lets a child process recognise the one it inherited
 *  instead of minting another. */
const SANDBOX_PREFIX = "pi-persona-test-agentdir-";

// PI_AGENT_DIR is not in the PI_PERSONA_ namespace but it steers the same thing: it is what
// `personaDataDir()` resolves, i.e. where an activation reads state/config from and — under
// `PI_PERSONA_SEED=on` — WRITES bundled personas to. Neither the developer's real ~/.pi/agent nor
// an exported override is an acceptable target for a test run, so pin a throwaway dir.
//
// Node's test runner does NOT give its per-file children the environment the runner mutated: each
// child re-runs this chain and mints its own sandbox. Good for isolation — a file cannot see what
// another file wrote — and it means the process that mints a dir is the only one that will ever
// use it, so it can and must remove it on the way out. Left alone this drops one directory per
// test FILE per run (~70 for `npm test`) into the temp dir forever.
function isInheritedSandbox(dir: string | undefined): boolean {
	if (!dir) return false;
	// Both halves matter. The name is what lets a child recognise the dir its parent minted instead
	// of minting another; being under the temp dir is what stops a merely sandbox-SHAPED path — an
	// exported `PI_AGENT_DIR=<repo>/pi-persona-test-agentdir-x` — from being honoured and seeded into.
	return basename(dir).startsWith(SANDBOX_PREFIX) && resolve(dir).startsWith(resolve(tmpdir()));
}

if (!isInheritedSandbox(process.env.PI_AGENT_DIR)) {
	// `tempDir` registers the path it minted, so a test file that later repoints PI_AGENT_DIR at its
	// own dir (extension.test.ts does) cannot redirect this cleanup onto a directory it owns.
	process.env.PI_AGENT_DIR = tempDir(SANDBOX_PREFIX);
}

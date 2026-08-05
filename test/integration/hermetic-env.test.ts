/**
 * The suite's hermeticity against the developer's own shell.
 *
 * pi-persona is configured entirely through PI_PERSONA_* variables, so a developer (or a CI job)
 * who exports one — the very thing this project's docs teach — used to get a red suite for no
 * reason: `resolveConfig(process.env)` runs inside the real activation, and every test that
 * asserts a default behaviour was silently reconfigured. The fix is a single choke point loaded
 * before any test module (test/setup/hermetic-env.ts, wired into the npm scripts with `--import`),
 * so nobody has to remember anything per test.
 *
 * These tests spawn the runner's OWN flag chain — parsed out of package.json rather than
 * duplicated here — with a deliberately poisoned environment, so they fail both if the choke
 * point stops scrubbing and if it is ever dropped from the scripts that invoke it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = path.join(REPO_ROOT, "test", "fixtures", "env-probe.mjs");

/** A shell that has pi-persona configured the way the README teaches — one of each shape:
 *  a plain flag, a value, and a path-or-switch. The agent dir is a decoy the choke point must
 *  overrule: this process already runs under a sandboxed one, and the spawned probe would
 *  inherit it and look protected no matter what its own flags did. */
const POISON = {
	PI_PERSONA_DEFAULT: "dev",
	PI_PERSONA_BROKER: "1",
	PI_PERSONA_ENGINE: "child",
	PI_PERSONA_SPINE: "on",
	PI_PERSONA_NUDGE: "off",
	PI_PERSONA_SEED: "on",
	PI_PERSONA_EXOCOM: "1",
	PI_AGENT_DIR: path.join(REPO_ROOT, "not-a-sandbox"),
};

/** The node flags an npm script passes before `--test` — i.e. the loader chain every test file
 *  in that script is born under. Read from package.json so removing the setup import from the
 *  scripts fails these tests instead of silently un-protecting the suite. */
function runnerFlags(script: "test" | "test:unit"): string[] {
	const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const words = (pkg.scripts[script] ?? "").split(/\s+/).filter((w) => w.length > 0);
	assert.equal(words[0], "node", `${script} is expected to be a plain node invocation`);
	const stop = words.indexOf("--test");
	assert.ok(stop > 0, `${script} is expected to run the node test runner`);
	return words.slice(1, stop);
}

/** The same configuration exported the way a Windows shell or the System Properties dialog will
 *  happily store it. `set pi_persona_default=dev` puts a lowercase KEY in the block, but
 *  `process.env.PI_PERSONA_DEFAULT` still answers "dev" — so resolveConfig() reads it and a
 *  case-sensitive scrub lets the entire namespace straight back in on this project's own dev
 *  platform. */
const POISON_MIXED_CASE = {
	pi_persona_default: "dev",
	Pi_Persona_Spine: "on",
	PI_persona_BROKER: "1",
};

function probe(
	script: "test" | "test:unit",
	poison: Record<string, string> = POISON,
): { leaked: string[]; agentDir: string | null } {
	const out = execFileSync(process.execPath, [...runnerFlags(script), PROBE], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...poison },
		encoding: "utf8",
	});
	return JSON.parse(out.trim().split("\n").pop() ?? "{}") as { leaked: string[]; agentDir: string | null };
}

for (const script of ["test", "test:unit"] as const) {
	test(`npm run ${script} starts every test file with the ambient PI_PERSONA_* stripped`, () => {
		assert.deepEqual(probe(script).leaked, [], `\`${script}\` must neutralise the developer's exported pi-persona config`);
	});

	test(`npm run ${script} strips the namespace whatever case the shell stored it in`, () => {
		assert.deepEqual(
			probe(script, POISON_MIXED_CASE).leaked,
			[],
			`\`${script}\` must neutralise pi-persona config exported as pi_persona_* too — on Windows that is the same variable`,
		);
	});

	test(`npm run ${script} pins PI_AGENT_DIR at a throwaway dir, never the developer's own`, () => {
		const agentDir = probe(script).agentDir;
		assert.ok(agentDir, "PI_AGENT_DIR is set by the choke point");
		assert.ok(
			agentDir?.startsWith(os.tmpdir()),
			`persona data must land in a sandbox, not ~/.pi/agent — got ${agentDir}`,
		);
	});

	test(`npm run ${script} takes its sandbox back out of the temp dir when the process ends`, () => {
		// Node's test runner does NOT hand its per-file children the env the runner mutated — each one
		// re-runs this chain and mints its own sandbox. That is fine for isolation and fatal for
		// hygiene: ~70 files means ~70 directories per run, none of which anything ever deletes. A
		// process that mints one owns it, so it has to take it away again.
		const agentDir = probe(script).agentDir;
		assert.ok(agentDir, "PI_AGENT_DIR is set by the choke point");
		assert.equal(existsSync(agentDir ?? ""), false, `the sandbox must not outlive its process — ${agentDir} is still on disk`);
	});

	test(`npm run ${script} does not accept an exported PI_AGENT_DIR that merely LOOKS like the sandbox`, () => {
		// The child recognises the dir it inherited by name, so it does not mint one per test file.
		// Recognition by name alone is spoofable: a directory called <sandbox prefix>-anything, sitting
		// anywhere on disk, would be honoured and a `PI_PERSONA_SEED=on` run would seed straight into
		// it. Being inside the temp dir has to be part of the recognition, not just the minting.
		const decoy = path.join(REPO_ROOT, "pi-persona-test-agentdir-decoy");
		const agentDir = probe(script, { ...POISON, PI_AGENT_DIR: decoy }).agentDir;
		assert.notEqual(agentDir, decoy, "a sandbox-shaped path outside the temp dir is still the developer's disk");
		assert.ok(agentDir?.startsWith(os.tmpdir()), `expected a real temp sandbox, got ${agentDir}`);
	});
}

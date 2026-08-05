import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import { scrubPiPersonaEnv } from "../setup/hermetic-env.ts";

test("scrubPiPersonaEnv removes exactly the PI_PERSONA_* keys and reports them", () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin",
		PI_AGENT_DIR: "/somewhere",
		PI_PERSONA_DEFAULT: "dev",
		PI_PERSONA_SPINE: "on",
		PI_PERSONAL_NOTE: "not ours", // shares a prefix by accident, not by namespace
	};
	const removed = scrubPiPersonaEnv(env);
	assert.deepEqual(removed, ["PI_PERSONA_DEFAULT", "PI_PERSONA_SPINE"]);
	assert.deepEqual(Object.keys(env).sort(), ["PATH", "PI_AGENT_DIR", "PI_PERSONAL_NOTE"]);
});

test("scrubPiPersonaEnv removes the namespace whatever case it was exported in", () => {
	// Windows env vars are case-insensitive: `set pi_persona_default=dev` stores the key lowercase,
	// but Node's process.env still answers `env.PI_PERSONA_DEFAULT` with it — which is exactly how
	// resolveConfig() reads it. A case-sensitive scrub therefore lets the whole namespace back in
	// on the platform this project is developed on. Nothing is case-normalised on the way out: the
	// key is deleted under the name it was actually stored as.
	const env: Record<string, string | undefined> = {
		pi_persona_default: "dev",
		Pi_Persona_Spine: "on",
		PI_PERSONA_BROKER: "1",
		pi_personal_note: "not ours",
		PI_AGENT_DIR: "/somewhere",
	};
	const removed = scrubPiPersonaEnv(env);
	assert.deepEqual(removed, ["PI_PERSONA_BROKER", "Pi_Persona_Spine", "pi_persona_default"].sort());
	assert.deepEqual(Object.keys(env).sort(), ["PI_AGENT_DIR", "pi_personal_note"]);
});

test("scrubPiPersonaEnv is a no-op on an already-clean env", () => {
	const env: Record<string, string | undefined> = { HOME: "/home/dev" };
	assert.deepEqual(scrubPiPersonaEnv(env), []);
	assert.deepEqual(Object.keys(env), ["HOME"]);
});

test("this very process runs against a sandboxed PI_AGENT_DIR", () => {
	// The choke point ran at `--import` time, before this file was loaded: whatever the developer
	// had exported, persona data for this run belongs in a throwaway dir.
	const agentDir = process.env.PI_AGENT_DIR;
	assert.ok(agentDir, "PI_AGENT_DIR is pinned by test/setup/hermetic-env.ts");
	assert.ok(agentDir?.startsWith(os.tmpdir()), `expected a temp sandbox, got ${agentDir}`);
});

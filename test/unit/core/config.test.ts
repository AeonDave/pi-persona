import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../../src/core/config.ts";

test("defaults apply when no env vars are set", () => {
	const c = resolveConfig({});
	assert.equal(c.disabled, false);
	assert.equal(c.keybinding, "f8");
	assert.equal(c.persist, true);
	assert.equal(c.delegateDefaultAllow, true);
	assert.equal(c.seed, true);
	assert.deepEqual(c.extraDirs, []);
	assert.equal(c.defaultPersona, undefined);
});

test("PI_PERSONA_DISABLE (any non-empty value) disables the extension", () => {
	assert.equal(resolveConfig({ PI_PERSONA_DISABLE: "1" }).disabled, true);
	assert.equal(resolveConfig({ PI_PERSONA_DISABLE: "" }).disabled, false);
});

test("PI_PERSONA_DIRS splits on ';' and ',' and trims", () => {
	assert.deepEqual(resolveConfig({ PI_PERSONA_DIRS: "/a;/b, /c " }).extraDirs, ["/a", "/b", "/c"]);
});

test("env flips keybinding, persist, delegate-default, seed, and default persona", () => {
	const c = resolveConfig({
		PI_PERSONA_KEY: "alt+p",
		PI_PERSONA_PERSIST: "off",
		PI_PERSONA_DELEGATE_DEFAULT: "deny",
		PI_PERSONA_SEED: "off",
		PI_PERSONA_DEFAULT: "magi",
		PI_PERSONA_STATE_FILE: "/custom/state.json",
	});
	assert.equal(c.keybinding, "alt+p");
	assert.equal(c.persist, false);
	assert.equal(c.delegateDefaultAllow, false);
	assert.equal(c.seed, false);
	assert.equal(c.defaultPersona, "magi");
	assert.equal(c.stateFile, "/custom/state.json");
});

test("stateFile is undefined by default (resolved to a global default by the extension)", () => {
	assert.equal(resolveConfig({}).stateFile, undefined);
});

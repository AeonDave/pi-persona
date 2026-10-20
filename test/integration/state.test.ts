import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "../setup/temp-dir.ts";
import { patchPersonaSettings, readPersonaSettings } from "../../src/persona/settings-store.ts";

test("remembered selection shares one settings file with preferences and models", () => {
	const file = join(tempDir("pi-persona-state-"), "persona", "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: false }, models: { magi: { melchior: "prov/a" } } });
	patchPersonaSettings(file, { lastPersona: "magi" });
	const saved = readPersonaSettings(file);
	assert.equal(saved.lastPersona, "magi");
	assert.equal(saved.preferences.nudge, false);
	assert.equal(saved.personas.magi?.models?.melchior, "prov/a");
	patchPersonaSettings(file, { lastPersona: null });
	assert.equal(readPersonaSettings(file).lastPersona, null);
	assert.equal(readPersonaSettings(file).personas.magi?.models?.melchior, "prov/a");
});

test("missing settings use no remembered selection; corrupt settings cannot be overwritten", () => {
	const file = join(tempDir("pi-persona-state-"), "settings.json");
	assert.equal(readPersonaSettings(file).lastPersona, null);
	writeFileSync(file, "{truncated", "utf8");
	assert.throws(() => readPersonaSettings(file), /invalid JSON/);
	assert.throws(() => patchPersonaSettings(file, { lastPersona: "magi" }), /invalid JSON/);
	assert.equal(readFileSync(file, "utf8"), "{truncated");
});

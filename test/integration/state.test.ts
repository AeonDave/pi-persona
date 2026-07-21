import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readLastPersona, writeLastPersona } from "../../src/persona/state.ts";

const tmpFile = (...parts: string[]) =>
	path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-state-")), ...parts);

test("writeLastPersona → readLastPersona round-trips a name (creating parent dirs)", () => {
	const f = tmpFile("persona-mind", "state.json");
	writeLastPersona(f, "magi");
	assert.equal(readLastPersona(f), "magi");
});

test("writeLastPersona(undefined) clears the remembered persona", () => {
	const f = tmpFile("state.json");
	writeLastPersona(f, "magi");
	writeLastPersona(f, undefined);
	assert.equal(readLastPersona(f), undefined);
});

test("readLastPersona returns undefined for a missing or corrupt file", () => {
	assert.equal(readLastPersona(path.join(os.tmpdir(), "pi-persona-nope-xyz", "state.json")), undefined);
});

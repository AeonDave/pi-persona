import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	const dir = mkdtempSync(join(tmpdir(), "pi-persona-cfg-"));
	const file = join(dir, "config.json");
	assert.deepEqual(readPersonaConfigs(file), {}, "missing file → empty store");
	writePersonaConfigs(file, withPersonaModels({}, "magi", { melchior: "prov/a" }));
	assert.equal(personaModels(readPersonaConfigs(file), "magi").melchior, "prov/a");
});

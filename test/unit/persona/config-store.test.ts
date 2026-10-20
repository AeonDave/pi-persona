import { test } from "node:test";
import assert from "node:assert/strict";
import { personaModels, withPersonaModels } from "../../../src/persona/config-store.ts";

test("same-strategy personas keep independent model assignments", () => {
	let store = withPersonaModels({}, "magi", { melchior: "prov/a", balthasar: "prov/b" });
	store = withPersonaModels(store, "tribunal", { melchior: "prov/x" });
	assert.deepEqual(personaModels(store, "magi"), { melchior: "prov/a", balthasar: "prov/b" });
	assert.deepEqual(personaModels(store, "tribunal"), { melchior: "prov/x" });
	assert.deepEqual(personaModels(store, "unknown"), {});
});

test("session model merges preserve other participants and never mutate the saved snapshot", () => {
	const original = withPersonaModels({}, "magi", { melchior: "prov/a" });
	const updated = withPersonaModels(original, "magi", { casper: "prov/c" });
	assert.deepEqual(personaModels(updated, "magi"), { melchior: "prov/a", casper: "prov/c" });
	assert.deepEqual(personaModels(original, "magi"), { melchior: "prov/a" });
});

test("prototype-like persona names are ordinary own keys, not inherited configuration", () => {
	assert.deepEqual(personaModels({}, "constructor"), {});
	const updated = withPersonaModels({}, "__proto__", { operator: "prov/a" });
	assert.equal(personaModels(updated, "__proto__").operator, "prov/a");
	assert.equal(Object.getPrototypeOf(updated), Object.prototype);
});

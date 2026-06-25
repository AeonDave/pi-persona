import { test } from "node:test";
import assert from "node:assert/strict";

import { isAllowed } from "../../../src/core/permissions.ts";

test("absent permission block falls back to defaultAllow", () => {
	assert.equal(isAllowed("anything", undefined), true);
	assert.equal(isAllowed("anything", undefined, true), true);
	assert.equal(isAllowed("anything", undefined, false), false);
	assert.equal(isAllowed("anything", {}), true);
	assert.equal(isAllowed("anything", {}, false), false);
});

test("allow present switches to allowlist mode — unlisted names are denied", () => {
	const perm = { allow: ["scout", "researcher"] };
	assert.equal(isAllowed("scout", perm), true);
	assert.equal(isAllowed("researcher", perm), true);
	assert.equal(isAllowed("planner", perm), false);
	// defaultAllow does not matter once an allow list is present
	assert.equal(isAllowed("planner", perm, true), false);
});

test("empty allow list is a lockdown (nothing allowed)", () => {
	assert.equal(isAllowed("scout", { allow: [] }), false);
	assert.equal(isAllowed("anything", { allow: [] }, true), false);
});

test("allow:['*'] allows everything", () => {
	assert.equal(isAllowed("whatever-name", { allow: ["*"] }), true);
	assert.equal(isAllowed("a/b:c", { allow: ["*"] }), true);
});

test("deny wins over allow", () => {
	const perm = { allow: ["*"], deny: ["experimental-*"] };
	assert.equal(isAllowed("scout", perm), true);
	assert.equal(isAllowed("experimental-x", perm), false);
});

test("deny-only mode allows everything except denied", () => {
	const perm = { deny: ["secret-*"] };
	assert.equal(isAllowed("secret-key", perm), false);
	assert.equal(isAllowed("public", perm), true);
});

test("glob '*' matches any run of characters; '?' matches exactly one", () => {
	assert.equal(isAllowed("code-review", { allow: ["code-*"] }), true);
	assert.equal(isAllowed("code-", { allow: ["code-*"] }), true);
	assert.equal(isAllowed("abc", { allow: ["a?c"] }), true);
	assert.equal(isAllowed("ac", { allow: ["a?c"] }), false);
	assert.equal(isAllowed("abbc", { allow: ["a?c"] }), false);
});

test("glob matching is full-string anchored, not a substring search", () => {
	assert.equal(isAllowed("xscout", { allow: ["scout"] }), false);
	assert.equal(isAllowed("scoutx", { allow: ["scout"] }), false);
	assert.equal(isAllowed("scout", { allow: ["scout"] }), true);
});

test("special regex characters in patterns are treated literally", () => {
	assert.equal(isAllowed("a.b", { allow: ["a.b"] }), true);
	assert.equal(isAllowed("axb", { allow: ["a.b"] }), false); // '.' is literal, not 'any char'
	assert.equal(isAllowed("pkg.name", { allow: ["pkg.*"] }), true);
});

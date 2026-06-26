import { test } from "node:test";
import assert from "node:assert/strict";

import {
	asBoolean,
	asPermission,
	asStringArray,
	parseYamlSubset,
	splitFrontmatter,
} from "../../../src/core/frontmatter.ts";

test("splitFrontmatter separates --- frontmatter --- from the body", () => {
	const { frontmatter, body } = splitFrontmatter("---\nname: scout\n---\nBody here");
	assert.equal(frontmatter, "name: scout");
	assert.equal(body, "Body here");
});

test("splitFrontmatter with no frontmatter returns all content as the body", () => {
	const { frontmatter, body } = splitFrontmatter("Just a body, no frontmatter");
	assert.equal(frontmatter, "");
	assert.equal(body, "Just a body, no frontmatter");
});

test("splitFrontmatter tolerates CRLF line endings and a leading BOM", () => {
	const { frontmatter, body } = splitFrontmatter("﻿---\r\nname: x\r\n---\r\nBody");
	assert.equal(frontmatter, "name: x");
	assert.equal(body, "Body");
});

test("parseYamlSubset reads scalar strings and quoted values", () => {
	assert.deepEqual(parseYamlSubset("name: scout"), { name: "scout" });
	assert.deepEqual(parseYamlSubset('label: "🔍 Reviewer"'), { label: "🔍 Reviewer" });
	assert.deepEqual(parseYamlSubset("label: 'single quoted'"), { label: "single quoted" });
});

test("parseYamlSubset reads booleans", () => {
	assert.deepEqual(parseYamlSubset("persona: true"), { persona: true });
	assert.deepEqual(parseYamlSubset("disabled: false"), { disabled: false });
});

test("parseYamlSubset coerces bare numbers but leaves quoted/mixed strings alone", () => {
	assert.deepEqual(parseYamlSubset("rounds: 3"), { rounds: 3 });
	assert.deepEqual(parseYamlSubset("ratio: 0.5"), { ratio: 0.5 });
	assert.deepEqual(parseYamlSubset('id: "3"'), { id: "3" });
	assert.deepEqual(parseYamlSubset("model: claude-4-8"), { model: "claude-4-8" });
});

test("parseYamlSubset reads two levels of nested maps (orchestration.params)", () => {
	const fm = parseYamlSubset("orchestration:\n  mode: strategy\n  params:\n    rounds: 3\n    aggregate: unanimity");
	assert.deepEqual(fm, {
		orchestration: { mode: "strategy", params: { rounds: 3, aggregate: "unanimity" } },
	});
});

test("parseYamlSubset reads inline lists, including quoted items and empty lists", () => {
	assert.deepEqual(parseYamlSubset("tools: [read, grep, bash]"), { tools: ["read", "grep", "bash"] });
	assert.deepEqual(parseYamlSubset('a: [x, "y z", w]'), { a: ["x", "y z", "w"] });
	assert.deepEqual(parseYamlSubset("tools: []"), { tools: [] });
});

test("parseYamlSubset reads block lists", () => {
	assert.deepEqual(parseYamlSubset("list:\n  - a\n  - b"), { list: ["a", "b"] });
});

test("parseYamlSubset reads one nested level of maps (delegate allow/deny)", () => {
	const fm = parseYamlSubset("delegate:\n  allow: [scout, code-*]\n  deny: [experimental-*]");
	assert.deepEqual(fm, { delegate: { allow: ["scout", "code-*"], deny: ["experimental-*"] } });
});

test("parseYamlSubset strips unquoted trailing comments", () => {
	assert.deepEqual(parseYamlSubset("name: scout # a comment"), { name: "scout" });
	// a '#' inside quotes is NOT a comment
	assert.deepEqual(parseYamlSubset('label: "a # b"'), { label: "a # b" });
});

test("asStringArray accepts arrays, comma-scalars, and rejects empties", () => {
	assert.deepEqual(asStringArray(["a", "b"]), ["a", "b"]);
	assert.deepEqual(asStringArray("a, b, c"), ["a", "b", "c"]);
	assert.deepEqual(asStringArray("single"), ["single"]);
	assert.equal(asStringArray(undefined), undefined);
	assert.equal(asStringArray(""), undefined);
});

test("asPermission accepts {allow,deny}, a bare list shorthand, and a comma-scalar", () => {
	assert.deepEqual(asPermission({ allow: ["a"], deny: ["b"] }), { allow: ["a"], deny: ["b"] });
	assert.deepEqual(asPermission(["a", "b"]), { allow: ["a", "b"] });
	assert.deepEqual(asPermission("a, b"), { allow: ["a", "b"] });
	assert.equal(asPermission(undefined), undefined);
	assert.equal(asPermission({}), undefined);
});

test("asBoolean coerces real booleans and the strings 'true'/'false'", () => {
	assert.equal(asBoolean(true), true);
	assert.equal(asBoolean(false), false);
	assert.equal(asBoolean("true"), true);
	assert.equal(asBoolean("false"), false);
	assert.equal(asBoolean(undefined), undefined);
	assert.equal(asBoolean("nonsense"), undefined);
});

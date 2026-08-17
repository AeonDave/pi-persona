import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseAgent } from "../../../src/agents/agent.ts";

const SCOUT = `---
name: scout
description: Fast read-only explorer
model: anthropic/claude-x
thinking: low
tools: read, grep, find
---
You are scout. Explore and report.`;

test("parseAgent reads frontmatter and uses the body as the system prompt", () => {
	const a = parseAgent(SCOUT, "/a/scout.md");
	assert.ok(a);
	assert.equal(a.name, "scout");
	assert.equal(a.description, "Fast read-only explorer");
	assert.equal(a.model, "anthropic/claude-x");
	assert.deepEqual(a.tools, ["read", "grep", "find"]);
	assert.equal(a.systemPrompt, "You are scout. Explore and report.");
	assert.equal(a.source, "/a/scout.md");
});

test("an agent carries no systemPromptMode — both engines APPEND, so there is no mode to pick", () => {
	// The field used to be parsed and read by nothing, and its `replace` default described
	// behavior agents have never had (child: `--append-system-prompt`; inproc: appendSystemPrompt).
	// Pinned so it can't come back as a second, silently-ignored knob.
	const a = parseAgent("---\nname: s\nsystemPromptMode: replace\n---\nbody", "/s");
	assert.ok(a);
	assert.ok(!("systemPromptMode" in a), "a mode nothing honours must not appear on the parsed agent");
});

test("parseAgent accepts tools written as an inline list", () => {
	const a = parseAgent("---\nname: x\ntools: [read, web_search]\n---\nbody", "/s");
	assert.deepEqual(a?.tools, ["read", "web_search"]);
});

test("parseAgent preserves an explicit empty tool allowlist as deny-all", () => {
	const a = parseAgent("---\nname: locked\ntools: []\n---\nbody", "/s");
	assert.deepEqual(a?.tools, [], "undefined means session defaults; [] must remain an explicit no-tools grant");
});

test("parseAgent preserves a tools deny block instead of silently granting the session default", () => {
	const a = parseAgent("---\nname: research\ntools:\n  deny: [edit]\n---\nbody", "/s");
	assert.deepEqual(a?.excludeTools, ["edit"]);
	assert.equal(a?.tools, undefined);
});

test("parseAgent preserves both allow and deny tool lists", () => {
	const a = parseAgent("---\nname: bounded\ntools:\n  allow: [read, grep, edit]\n  deny: [edit]\n---\nbody", "/s");
	assert.deepEqual(a?.tools, ["read", "grep", "edit"]);
	assert.deepEqual(a?.excludeTools, ["edit"]);
});

test("the bundled research worker really denies edit at runtime", () => {
	const source = new URL("../../../agents/research.md", import.meta.url);
	const agent = parseAgent(readFileSync(source, "utf8"), source.pathname);
	assert.deepEqual(agent?.excludeTools, ["edit"]);
});

test("parseAgent reads isolation: worktree (else undefined)", () => {
	assert.equal(parseAgent("---\nname: s\nisolation: worktree\n---\nbody", "/s")?.isolation, "worktree");
	assert.equal(parseAgent("---\nname: s\n---\nbody", "/s")?.isolation, undefined);
	assert.equal(parseAgent("---\nname: s\nisolation: none\n---\nbody", "/s")?.isolation, undefined, "none ⇒ unset");
});

test("parseAgent reads spine: false, the shared-layer opt-out (else undefined)", () => {
	assert.equal(parseAgent("---\nname: s\nspine: false\n---\nbody", "/s")?.spine, false);
	assert.equal(parseAgent("---\nname: s\n---\nbody", "/s")?.spine, undefined, "absent ⇒ the session setting decides");
	assert.equal(parseAgent("---\nname: s\nspine: true\n---\nbody", "/s")?.spine, undefined, "only an explicit false is recorded");
});

test("parseAgent reads mcp: true (else undefined)", () => {
	assert.equal(parseAgent("---\nname: s\nmcp: true\n---\nbody", "/s")?.mcp, true);
	assert.equal(parseAgent("---\nname: s\n---\nbody", "/s")?.mcp, undefined);
	assert.equal(parseAgent("---\nname: s\nmcp: false\n---\nbody", "/s")?.mcp, undefined, "false ⇒ unset");
});

test("parseAgent returns null when name is missing", () => {
	assert.equal(parseAgent("---\ndescription: no name\n---\nbody", "/s"), null);
});

test("parseAgent leaves optional fields undefined when absent", () => {
	const a = parseAgent("---\nname: bare\n---\nJust a prompt.", "/s");
	assert.equal(a?.model, undefined);
	assert.equal(a?.tools, undefined);
	assert.equal(a?.excludeTools, undefined);
	assert.equal(a?.systemPrompt, "Just a prompt.");
});

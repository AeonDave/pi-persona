import { test } from "node:test";
import assert from "node:assert/strict";

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
	assert.equal(a.systemPromptMode, "replace");
	assert.equal(a.source, "/a/scout.md");
});

test("parseAgent accepts tools written as an inline list", () => {
	const a = parseAgent("---\nname: x\ntools: [read, web_search]\n---\nbody", "/s");
	assert.deepEqual(a?.tools, ["read", "web_search"]);
});

test("parseAgent reads isolation: worktree (else undefined)", () => {
	assert.equal(parseAgent("---\nname: s\nisolation: worktree\n---\nbody", "/s")?.isolation, "worktree");
	assert.equal(parseAgent("---\nname: s\n---\nbody", "/s")?.isolation, undefined);
	assert.equal(parseAgent("---\nname: s\nisolation: none\n---\nbody", "/s")?.isolation, undefined, "none ⇒ unset");
});

test("parseAgent returns null when name is missing", () => {
	assert.equal(parseAgent("---\ndescription: no name\n---\nbody", "/s"), null);
});

test("parseAgent leaves optional fields undefined when absent", () => {
	const a = parseAgent("---\nname: bare\n---\nJust a prompt.", "/s");
	assert.equal(a?.model, undefined);
	assert.equal(a?.tools, undefined);
	assert.equal(a?.systemPrompt, "Just a prompt.");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadDefinitions, loadTeams } from "../../src/loader.ts";

function tmp(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-test-"));
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
	return dir;
}

test("loadDefinitions splits personas (persona:true) from agents and records shadowing", () => {
	const user = tmp({
		"magi.md": "---\nname: magi\npersona: true\n---\nMAGI supervisor",
		"scout.md": "---\nname: scout\ntools: read\n---\nScout agent",
	});
	const project = tmp({
		"magi.md": "---\nname: magi\npersona: true\nlabel: Project MAGI\n---\nProject MAGI",
	});
	const r = loadDefinitions([
		{ path: user, scope: "user" },
		{ path: project, scope: "project" },
	]);
	assert.equal(r.personas.find((p) => p.name === "magi")?.label, "Project MAGI", "project persona wins");
	assert.equal(r.agents.find((a) => a.name === "scout")?.name, "scout");
	assert.equal(r.shadowed.length, 1, "the user magi is shadowed by the project magi");
});

test("loadTeams merges teams.yaml files (later wins)", () => {
	const dir = tmp({ "teams.yaml": "review: [a, b]\nmagi: [m, b, c]" });
	const teams = loadTeams([path.join(dir, "teams.yaml")]);
	assert.deepEqual(teams.review, ["a", "b"]);
	assert.deepEqual(teams.magi, ["m", "b", "c"]);
});

test("loadDefinitions ignores unreadable dirs gracefully", () => {
	const r = loadDefinitions([{ path: path.join(os.tmpdir(), "pi-persona-does-not-exist-xyz"), scope: "user" }]);
	assert.deepEqual(r.personas, []);
	assert.deepEqual(r.agents, []);
});

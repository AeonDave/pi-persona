import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadContracts, loadDefinitions, loadTeams } from "../../src/loader.ts";

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

test("a persona and an agent may share a name (separate namespaces, no shadowing)", () => {
	const personasDir = tmp({ "reviewer.md": "---\nname: reviewer\npersona: true\n---\nReviewer supervisor" });
	const agentsDir = tmp({ "reviewer.md": "---\nname: reviewer\ntools: read\n---\nReviewer agent" });
	const r = loadDefinitions([
		{ path: personasDir, scope: "personas" },
		{ path: agentsDir, scope: "agents" },
	]);
	assert.equal(r.personas.find((p) => p.name === "reviewer")?.isPersona, true);
	assert.equal(r.agents.find((a) => a.name === "reviewer")?.name, "reviewer");
	assert.equal(r.shadowed.length, 0);
});

test("loadTeams merges teams.yaml files (later wins)", () => {
	const dir = tmp({ "teams.yaml": "review: [a, b]\nmagi: [m, b, c]" });
	const teams = loadTeams([path.join(dir, "teams.yaml")]);
	assert.deepEqual(teams.review, ["a", "b"]);
	assert.deepEqual(teams.magi, ["m", "b", "c"]);
});

test("loadContracts discovers *.contract.json across dirs (later wins, malformed skipped)", () => {
	const builtin = tmp({
		"v.contract.json": JSON.stringify({ name: "v", fields: { vote: { type: "string", required: true } } }),
		"broken.contract.json": "{ not json",
	});
	const project = tmp({
		"v.contract.json": JSON.stringify({ name: "v", fields: { vote: { type: "string" }, extra: { type: "number" } } }),
	});
	const contracts = loadContracts([
		{ path: builtin, scope: "builtin" },
		{ path: project, scope: "project" },
	]);
	assert.ok(contracts.v, "the valid contract loaded");
	assert.equal(contracts.v?.fields.vote?.required, undefined, "project version (vote not required) won");
	assert.ok(contracts.v?.fields.extra, "project added a field");
	assert.equal(Object.keys(contracts).length, 1, "the malformed file was skipped");
});

test("loadDefinitions ignores unreadable dirs gracefully", () => {
	const r = loadDefinitions([{ path: path.join(os.tmpdir(), "pi-persona-does-not-exist-xyz"), scope: "user" }]);
	assert.deepEqual(r.personas, []);
	assert.deepEqual(r.agents, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tempDir } from "../setup/temp-dir.ts";
import { loadContracts, loadDefinitions, loadTeams } from "../../src/loader.ts";

function tmp(files: Record<string, string>): string {
	const dir = tempDir("pi-persona-test-");
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

test("a persona and an agent with the same name are reported and fail closed", () => {
	const personasDir = tmp({ "reviewer.md": "---\nname: reviewer\npersona: true\n---\nReviewer supervisor" });
	const agentsDir = tmp({ "reviewer.md": "---\nname: reviewer\ntools: read\n---\nReviewer agent" });
	const r = loadDefinitions([
		{ path: personasDir, scope: "personas" },
		{ path: agentsDir, scope: "agents" },
	]);
	assert.equal(r.personas.find((p) => p.name === "reviewer"), undefined);
	assert.equal(r.agents.find((a) => a.name === "reviewer"), undefined);
	assert.deepEqual(r.collisions.map((c) => c.name), ["reviewer"]);
	assert.equal(r.shadowed.length, 0);
});

test("collision guard keys on frontmatter `name`, not the filename (fail closed)", () => {
	// Persona foo.md declares name: dev; agent dev.md declares name: dev. Different
	// basenames, SAME runtime identity — the ambiguous pair must be omitted from both
	// registries, exactly like a same-filename collision.
	const personasDir = tmp({ "foo.md": "---\nname: dev\npersona: true\n---\nSupervisor" });
	const agentsDir = tmp({ "dev.md": "---\nname: dev\ntools: read\n---\nAgent" });
	const r = loadDefinitions([
		{ path: personasDir, scope: "user" },
		{ path: agentsDir, scope: "project" },
	]);
	assert.equal(r.personas.find((p) => p.name === "dev"), undefined);
	assert.equal(r.agents.find((a) => a.name === "dev"), undefined);
	assert.deepEqual(r.collisions.map((c) => c.name), ["dev"]);
});

test("same-kind duplicate frontmatter names resolve by precedence and report the mismatch", () => {
	// user x.md (name: shared) vs project y.md (name: shared): the project file wins,
	// the user file is shadowed, and both name≠basename mismatches are warnings.
	const user = tmp({ "x.md": "---\nname: shared\npersona: true\nlabel: User\n---\nUser" });
	const project = tmp({ "y.md": "---\nname: shared\npersona: true\nlabel: Project\n---\nProject" });
	const r = loadDefinitions([
		{ path: user, scope: "user" },
		{ path: project, scope: "project" },
	]);
	assert.equal(r.personas.length, 1);
	assert.equal(r.personas[0]?.label, "Project", "project precedence still wins under parsed names");
	assert.equal(r.shadowed.length, 1);
	assert.equal(r.shadowed[0]?.name, "shared");
	assert.ok(r.warnings.some((w) => w.includes("x.md") && w.includes("shared")), "user mismatch warned");
	assert.ok(r.warnings.some((w) => w.includes("y.md")), "project mismatch warned");
});

test("a file without a frontmatter name is dropped WITH a warning, not silently", () => {
	const dir = tmp({ "broken.md": "---\ntools: read\n---\nno name here", "ok.md": "---\nname: ok\n---\nAgent" });
	const r = loadDefinitions([{ path: dir, scope: "user" }]);
	assert.deepEqual(r.agents.map((a) => a.name), ["ok"]);
	assert.deepEqual(r.personas, []);
	assert.ok(r.warnings.some((w) => w.includes("broken.md")), "the dropped file is reported");
});

test("loadContracts keys by filename and warns on malformed files and name mismatches", () => {
	const dir = tmp({
		"broken.contract.json": "{ not json",
		"renamed.contract.json": JSON.stringify({ name: "other", fields: { vote: { type: "string" } } }),
		"good.contract.json": JSON.stringify({ name: "good", fields: { result: { type: "string", required: true } } }),
	});
	const { contracts, warnings } = loadContracts([{ path: dir, scope: "user" }]);
	assert.ok(contracts.good, "the valid contract loaded");
	assert.ok(contracts.renamed, "keyed by the FILENAME (deterministic)");
	assert.equal(contracts.other, undefined, "the embedded name is not the registry key");
	assert.ok(warnings.some((w) => w.includes("broken.contract.json")), "malformed file warned");
	assert.ok(warnings.some((w) => w.includes("renamed.contract.json") && w.includes("other")), "name mismatch warned");
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
	const { contracts, warnings } = loadContracts([
		{ path: builtin, scope: "builtin" },
		{ path: project, scope: "project" },
	]);
	assert.ok(contracts.v, "the valid contract loaded");
	assert.equal(contracts.v?.fields.vote?.required, undefined, "project version (vote not required) won");
	assert.ok(contracts.v?.fields.extra, "project added a field");
	assert.equal(Object.keys(contracts).length, 1, "the malformed file was skipped");
	assert.ok(warnings.some((w) => w.includes("broken.contract.json")), "the malformed file is reported");
});

test("loadDefinitions ignores unreadable dirs gracefully", () => {
	const r = loadDefinitions([{ path: path.join(os.tmpdir(), "pi-persona-does-not-exist-xyz"), scope: "user" }]);
	assert.deepEqual(r.personas, []);
	assert.deepEqual(r.agents, []);
});

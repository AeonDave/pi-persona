import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { seedDefaults } from "../../../src/core/seed.ts";

/** A throwaway bundled layout (personas + agents + teams + flows + contracts + presets). */
function bundled(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-bundled-"));
	fs.mkdirSync(path.join(dir, "personas"));
	fs.writeFileSync(path.join(dir, "personas", "sample.md"), "PERSONA sample");
	fs.writeFileSync(path.join(dir, "personas", "reviewer.md"), "PERSONA reviewer"); // collides with the agent below
	fs.mkdirSync(path.join(dir, "agents"));
	fs.writeFileSync(path.join(dir, "agents", "scout.md"), "AGENT scout");
	fs.writeFileSync(path.join(dir, "agents", "reviewer.md"), "AGENT reviewer");
	fs.mkdirSync(path.join(dir, "flows"));
	fs.writeFileSync(path.join(dir, "flows", "deep.flow.json"), "{}");
	fs.mkdirSync(path.join(dir, "contracts"));
	fs.writeFileSync(path.join(dir, "contracts", "v.contract.json"), "{}");
	fs.mkdirSync(path.join(dir, "presets"));
	fs.writeFileSync(path.join(dir, "presets", "p.preset.json"), "{}");
	fs.writeFileSync(path.join(dir, "teams.yaml"), "magi: [a, b, c]");
	return dir;
}
const userDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-user-"));
const read = (p: string): string => fs.readFileSync(p, "utf8");

test("seedDefaults copies personas + agents into <user>/agents, and teams/flows/contracts/presets into their dirs", () => {
	const u = userDir();
	seedDefaults(bundled(), u, false);
	assert.equal(read(path.join(u, "agents", "sample.md")), "PERSONA sample", "persona seeded into <user>/agents");
	assert.equal(read(path.join(u, "agents", "scout.md")), "AGENT scout", "agent seeded into the same folder");
	assert.ok(fs.existsSync(path.join(u, "flows", "deep.flow.json")));
	assert.ok(fs.existsSync(path.join(u, "contracts", "v.contract.json")));
	assert.ok(fs.existsSync(path.join(u, "presets", "p.preset.json")));
	assert.equal(read(path.join(u, "teams.yaml")), "magi: [a, b, c]");
});

test("on a persona/agent name collision the PERSONA owns the file (the builtin agent still loads)", () => {
	const u = userDir();
	const r = seedDefaults(bundled(), u, false);
	assert.equal(read(path.join(u, "agents", "reviewer.md")), "PERSONA reviewer", "the persona wins the shared filename");
	assert.ok(r.skipped.some((p) => p.endsWith("reviewer.md")), "the colliding agent copy was skipped");
});

test("force=false keeps a user edit; force=true restores the bundled original", () => {
	const b = bundled();
	const u = userDir();
	seedDefaults(b, u, false);
	fs.writeFileSync(path.join(u, "agents", "sample.md"), "MY EDITS");
	const keep = seedDefaults(b, u, false);
	assert.equal(read(path.join(u, "agents", "sample.md")), "MY EDITS", "non-forced seed keeps edits");
	assert.equal(keep.copied.length, 0, "nothing copied on a second non-forced seed");
	seedDefaults(b, u, true);
	assert.equal(read(path.join(u, "agents", "sample.md")), "PERSONA sample", "restore overwrites with the original");
});

test("seedDefaults tolerates a bundled dir missing some asset folders", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persona-partial-"));
	fs.mkdirSync(path.join(dir, "personas"));
	fs.writeFileSync(path.join(dir, "personas", "a.md"), "x"); // only personas
	const u = userDir();
	const r = seedDefaults(dir, u, false);
	assert.equal(r.copied.length, 1);
	assert.ok(fs.existsSync(path.join(u, "agents", "a.md")));
});

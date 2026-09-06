import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { migratePristineSeededDefaults } from "../../../src/core/seed.ts";
import { parsePersona } from "../../../src/persona/persona.ts";
import { tempDir } from "../../setup/temp-dir.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = path.join(ROOT, "test", "fixtures", "personas-1.13.4");
const PERSONAS = ["dev", "planner", "researcher", "swarm", "audit", "verify"] as const;

for (const name of PERSONAS) {
	test(`the ${name} experience refresh upgrades the pristine 1.13.4 seed and preserves custom edits`, () => {
		const user = tempDir(`pi-persona-${name}-refresh-`);
		fs.mkdirSync(path.join(user, "agents"));
		const target = path.join(user, "agents", `${name}.md`);
		const original = fs.readFileSync(path.join(FIXTURES, `${name}.md`));
		fs.writeFileSync(target, original);
		const first = migratePristineSeededDefaults(ROOT, user);
		assert.deepEqual(first.migrated, [target]);
		assert.deepEqual(first.warnings, []);
		assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(ROOT, "personas", `${name}.md`)));
		assert.deepEqual(migratePristineSeededDefaults(ROOT, user).migrated, [], "already refreshed seeds stay untouched");

		const customized = Buffer.concat([original, Buffer.from("\nMy own collaboration conventions.\n")]);
		fs.writeFileSync(target, customized);
		assert.deepEqual(migratePristineSeededDefaults(ROOT, user).migrated, [], "a user edit excludes the seed from automatic refresh");
		assert.deepEqual(fs.readFileSync(target), customized);
	});

	test(`the ${name} experience refresh preserves its declared capabilities and orchestration`, () => {
		const old = parsePersona(fs.readFileSync(path.join(FIXTURES, `${name}.md`), "utf8"), "before");
		const current = parsePersona(fs.readFileSync(path.join(ROOT, "personas", `${name}.md`), "utf8"), "after");
		assert.ok(old);
		assert.ok(current);
		const behavior = (persona: NonNullable<typeof old>) => {
			const { body: _body, description: _description, source: _source, ...contract } = persona;
			return contract;
		};
		assert.deepEqual(behavior(current), behavior(old));
	});
}

test("persona refresh recognizes a pristine CRLF checkout variant", () => {
	const user = tempDir("pi-persona-crlf-refresh-");
	fs.mkdirSync(path.join(user, "agents"));
	const target = path.join(user, "agents", "dev.md");
	const lf = fs.readFileSync(path.join(FIXTURES, "dev.md"), "utf8");
	fs.writeFileSync(target, lf.replace(/\n/g, "\r\n"), "utf8");

	const result = migratePristineSeededDefaults(ROOT, user);
	assert.deepEqual(result.migrated, [target]);
	assert.deepEqual(result.warnings, []);
});

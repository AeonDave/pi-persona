import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	existsSync,
	openSync,
	linkSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { tempDir } from "../../setup/temp-dir.ts";
import {
	migratePersonaSettings,
	patchPersonaSettings,
	readPersonaSettings,
} from "../../../src/persona/settings-store.ts";

test("a missing canonical file reads as defaults without creating a file", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	assert.deepEqual(readPersonaSettings(file), {
		version: 1,
		preferences: {},
		personas: {},
		lastPersona: null,
		selectionRevision: 0,
	});
	assert.equal(existsSync(file), false);
});

test("reads known fields and preserves unknown top-level and per-persona fields", () => {
	const dir = tempDir("pi-persona-settings-");
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({
		version: 1,
		preferences: { nudge: false, spine: "C:\\Prompts\\Spine.MD" },
		personas: { magi: { models: { melchior: "provider/model" }, futurePersonaField: { kept: true } } },
		lastPersona: "magi",
		futureTopLevelField: { kept: true },
	}), "utf8");
	const settings = readPersonaSettings(file);
	const magi = settings.personas.magi as unknown as Record<string, unknown> | undefined;
	assert.equal(settings.preferences.nudge, false);
	assert.equal(settings.preferences.spine, "C:\\Prompts\\Spine.MD");
	assert.deepEqual(settings.personas.magi?.models, { melchior: "provider/model" });
	assert.deepEqual(magi?.futurePersonaField, { kept: true });
	assert.equal(settings.lastPersona, "magi");
	assert.deepEqual(settings.futureTopLevelField, { kept: true });
	patchPersonaSettings(file, { preferences: { nudge: false }, models: { magi: { casper: "provider/new" } } });
	const updated = readPersonaSettings(file);
	const updatedMagi = updated.personas.magi as unknown as Record<string, unknown> | undefined;
	assert.deepEqual(updated.futureTopLevelField, { kept: true }, "patches preserve unknown top-level keys");
	assert.deepEqual(updatedMagi?.futurePersonaField, { kept: true }, "patches preserve unknown per-persona keys");
	assert.deepEqual(updated.personas.magi?.models, { melchior: "provider/model", casper: "provider/new" });
});

test("reads UTF-8 BOM and CRLF canonical settings without losing Windows path case", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	const json = JSON.stringify({
		version: 1,
		preferences: { spine: "C:\\Prompts\\Spine.MD" },
		personas: {},
		lastPersona: null,
	}, null, 2).replace(/\n/g, "\r\n");
	writeFileSync(file, `\uFEFF${json}`, "utf8");
	assert.equal(readPersonaSettings(file).preferences.spine, "C:\\Prompts\\Spine.MD");
});

test("patches merge narrowly, support null removal, and preserve unrelated concurrent edits", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	patchPersonaSettings(file, {
		preferences: { nudge: false, spine: "C:\\Prompts\\Spine.MD" },
		models: { magi: { melchior: "provider/a", casper: "provider/c" } },
		lastPersona: "magi",
	});
	const staleSession = readPersonaSettings(file);
	patchPersonaSettings(file, {
		preferences: { exocom: true },
		models: { tribunal: { arbiter: "provider/judge" } },
	});
	patchPersonaSettings(file, {
		preferences: { nudge: null },
		models: { magi: { melchior: null, balthasar: "provider/b" } },
		lastPersona: null,
	});
	assert.equal(staleSession.preferences.nudge, false, "a prior read is an independent snapshot");
	const saved = readPersonaSettings(file);
	assert.equal(saved.preferences.nudge, undefined);
	assert.equal(saved.preferences.exocom, true);
	assert.equal(saved.preferences.spine, "C:\\Prompts\\Spine.MD");
	assert.deepEqual(saved.personas.magi?.models, { casper: "provider/c", balthasar: "provider/b" });
	assert.deepEqual(saved.personas.tribunal?.models, { arbiter: "provider/judge" });
	assert.equal(saved.lastPersona, null);
});

test("patch validation rejects unknown preferences without changing canonical bytes", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: false } });
	const original = readFileSync(file, "utf8");
	assert.throws(() => patchPersonaSettings(file, { preferences: { retiredOption: true } as never }), /unknown/i);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("oversized updates fail before replacement and keep the previous canonical file readable", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	const original = readFileSync(file, "utf8");
	assert.throws(() => patchPersonaSettings(file, {
		models: { magi: { melchior: "x".repeat(1024 * 1024) } },
	}), /exceeds/i);
	assert.equal(readFileSync(file, "utf8"), original);
	assert.equal(readPersonaSettings(file).preferences.nudge, true);
});

test("separate processes serialize read-modify-write patches without losing either update", async () => {
	const file = join(tempDir("pi-persona-settings-concurrent-"), "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	const lockFile = `${file}.lock`;
	writeFileSync(lockFile, `${process.pid}\nheld-for-concurrency-test\n`, "utf8");
	const moduleUrl = pathToFileURL(join(process.cwd(), "src/persona/settings-store.ts")).href;
	const script = [
		`import { patchPersonaSettings } from ${JSON.stringify(moduleUrl)};`,
		`process.stdout.write(${JSON.stringify("READY\n")});`,
		`await new Promise((resolve) => process.stdin.once("data", resolve));`,
		`try { patchPersonaSettings(${JSON.stringify(file)}, JSON.parse(process.env.PATCH_JSON)); }`,
		`catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }`,
	].join("\n");
	const patches = [
		{ preferences: { broker: false } },
		{ models: { magi: { melchior: "provider/model" } }, lastPersona: "magi" },
	];
	const children = patches.map((patch) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: process.cwd(),
			env: { ...process.env, PATCH_JSON: JSON.stringify(patch) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let errorOutput = "";
		let output = "";
		let readyResolved = false;
		const ready = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => {
				if (!readyResolved) reject(new Error(`settings writer exited before ready (${code}): ${errorOutput}`));
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (!readyResolved && output.includes("READY\n")) {
					readyResolved = true;
					resolve();
				}
			});
		});
		const exited = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`settings writer failed (${code}): ${errorOutput}`)));
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
		});
		return { child, ready, exited };
	});
	try {
		await Promise.all(children.map(({ ready }) => ready));
		for (const { child } of children) {
			child.stdin.write("go\n");
			child.stdin.end();
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		unlinkSync(lockFile);
		await Promise.all(children.map(({ exited }) => exited));
	} finally {
		try { unlinkSync(lockFile); } catch { /* The child writers may already have removed it. */ }
		for (const { child } of children) {
			if (child.exitCode === null) child.kill();
		}
	}
	const saved = readPersonaSettings(file);
	assert.equal(saved.preferences.nudge, true);
	assert.equal(saved.preferences.broker, false);
	assert.deepEqual(saved.personas.magi?.models, { melchior: "provider/model" });
	assert.equal(saved.lastPersona, "magi");
});

test("omitted patch fields leave saved preferences, models, and last persona untouched", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	patchPersonaSettings(file, {
		preferences: { persist: false },
		models: { magi: { melchior: "provider/model" } },
		lastPersona: "magi",
	});
	patchPersonaSettings(file, { preferences: { broker: false } });
	const saved = readPersonaSettings(file);
	assert.equal(saved.preferences.persist, false);
	assert.equal(saved.preferences.broker, false);
	assert.deepEqual(saved.personas.magi?.models, { melchior: "provider/model" });
	assert.equal(saved.lastPersona, "magi");
});

test("companion settings round-trip through the same canonical file without selection revisions", () => {
	const file = join(tempDir("pi-persona-settings-companions-"), "settings.json");
	patchPersonaSettings(file, { preferences: {
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: false,
		flowPort: 0,
		flowIdleMs: 30_000,
	} });
	const saved = readPersonaSettings(file);
	assert.deepEqual(saved.preferences, {
		mindCapture: "prompt",
		mindNudge: false,
		flowEnabled: false,
		flowPort: 0,
		flowIdleMs: 30_000,
	});
	assert.equal(saved.selectionRevision, 0, "settings changes are not explicit persona-selection gestures");
});

test("selection revision advances only for explicit persona-selection patches", () => {
	const file = join(tempDir("pi-persona-settings-revision-"), "settings.json");
	patchPersonaSettings(file, { preferences: { persist: true }, models: { magi: { melchior: "provider/a" } } });
	assert.equal(readPersonaSettings(file).selectionRevision, 0);
	patchPersonaSettings(file, { preferences: { broker: false }, models: { magi: { casper: "provider/c" } } });
	assert.equal(readPersonaSettings(file).selectionRevision, 0, "preference/model writes are not selection gestures");
	patchPersonaSettings(file, { lastPersona: "magi" });
	assert.equal(readPersonaSettings(file).selectionRevision, 1);
	patchPersonaSettings(file, { lastPersona: "magi" });
	assert.equal(readPersonaSettings(file).selectionRevision, 2, "reselecting the same persona is still a gesture");
	patchPersonaSettings(file, { lastPersona: null });
	assert.equal(readPersonaSettings(file).selectionRevision, 3, "explicitly clearing the selection is a gesture");
	patchPersonaSettings(file, { lastPersona: null });
	assert.equal(readPersonaSettings(file).selectionRevision, 4);
});

test("invalid or exhausted selection revisions fail closed without overwriting data", () => {
	const file = join(tempDir("pi-persona-settings-revision-invalid-"), "settings.json");
	const base = { version: 1, preferences: {}, personas: {}, lastPersona: "magi" };
	for (const selectionRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		const original = JSON.stringify({ ...base, selectionRevision });
		writeFileSync(file, original, "utf8");
		assert.throws(() => readPersonaSettings(file), /selectionRevision/i);
		assert.throws(() => patchPersonaSettings(file, { lastPersona: null }), /selectionRevision/i);
		assert.equal(readFileSync(file, "utf8"), original);
	}
	const maxRevision = JSON.stringify({ ...base, selectionRevision: Number.MAX_SAFE_INTEGER });
	writeFileSync(file, maxRevision, "utf8");
	assert.throws(() => patchPersonaSettings(file, { lastPersona: "magi" }), /selectionRevision|safe integer/i);
	assert.equal(readFileSync(file, "utf8"), maxRevision, "overflow cannot wrap or replace canonical state");
});

test("invalid existing data is rejected and never overwritten by a patch", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	const original = '{"version":99,"private":"keep"}';
	writeFileSync(file, original, "utf8");
	assert.throws(() => readPersonaSettings(file), /version/i);
	assert.throws(() => patchPersonaSettings(file, { preferences: { broker: false } }), /version/i);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("malformed JSON and unknown preference names fail closed", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	writeFileSync(file, "{", "utf8");
	assert.throws(() => readPersonaSettings(file), /json|parse|settings/i);
	writeFileSync(file, JSON.stringify({ version: 1, preferences: { retired: true }, personas: {}, lastPersona: null }), "utf8");
	const unknownPreference = readFileSync(file, "utf8");
	assert.throws(() => readPersonaSettings(file), /unknown/i);
	assert.throws(() => patchPersonaSettings(file, { preferences: { broker: false } }), /unknown/i);
	assert.equal(readFileSync(file, "utf8"), unknownPreference, "unknown schema keys are rejected rather than silently erased");
});

test("malformed UTF-8 inside otherwise valid canonical JSON is rejected without overwriting the bytes", () => {
	const file = join(tempDir("pi-persona-settings-invalid-utf8-"), "settings.json");
	const original = Buffer.concat([
		Buffer.from('{"version":1,"preferences":{"spine":"before'),
		Buffer.from([0xff]),
		Buffer.from('after"},"personas":{},"lastPersona":null}'),
	]);
	writeFileSync(file, original);
	let patchError: unknown;
	try {
		patchPersonaSettings(file, { preferences: { nudge: false } });
	} catch (error) {
		patchError = error;
	}
	assert.deepEqual(readFileSync(file), original, "invalid byte sequences must not be normalized and replaced");
	assert.ok(patchError instanceof Error, "patching malformed UTF-8 must fail closed");
	assert.throws(() => readPersonaSettings(file), /JSON|UTF|encoding|settings/i);
});

test("hard-linked canonical settings are rejected before reading or writing", () => {
	const dir = tempDir("pi-persona-settings-");
	const file = join(dir, "settings.json");
	const alias = join(dir, "other-name.json");
	writeFileSync(file, JSON.stringify({ version: 1, preferences: {}, personas: {}, lastPersona: null }), "utf8");
	linkSync(file, alias);
	assert.equal(statSync(file).nlink, 2);
	assert.throws(() => readPersonaSettings(file), /link|regular|unsafe/i);
	assert.throws(() => patchPersonaSettings(file, { lastPersona: "magi" }), /link|regular|unsafe/i);
});

test("symbolic-linked canonical settings are rejected without following the link", (t) => {
	const dir = tempDir("pi-persona-settings-");
	const file = join(dir, "settings.json");
	const target = join(dir, "target.json");
	const bytes = JSON.stringify({ version: 1, preferences: {}, personas: {}, lastPersona: null });
	writeFileSync(target, bytes, "utf8");
	try {
		symlinkSync(target, file, "file");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
			t.skip(`file symlinks unavailable in this environment (${code})`);
			return;
		}
		throw error;
	}
	assert.throws(() => readPersonaSettings(file), /unsafe|regular|link/i);
	assert.throws(() => patchPersonaSettings(file, { lastPersona: "magi" }), /unsafe|regular|link/i);
	assert.equal(readFileSync(target, "utf8"), bytes);
});

test("oversized canonical settings are rejected and never replaced", () => {
	const file = join(tempDir("pi-persona-settings-"), "settings.json");
	const original = `{"version":1,"payload":"${"x".repeat(1024 * 1024)}"}`;
	writeFileSync(file, original, "utf8");
	assert.throws(() => readPersonaSettings(file), /exceeds/i);
	assert.throws(() => patchPersonaSettings(file, { lastPersona: "magi" }), /exceeds/i);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("a failed atomic replacement leaves old bytes intact and removes its unique temp file", () => {
	const dir = tempDir("pi-persona-settings-");
	const file = join(dir, "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	const oldBytes = readFileSync(file, "utf8");
	assert.throws(() => patchPersonaSettings(file, { preferences: { nudge: false } }, {
		rename: () => { throw Object.assign(new Error("locked target"), { code: "EPERM" }); },
		sleep: () => {},
	}), /rename|locked|EPERM/i);
	assert.equal(readFileSync(file, "utf8"), oldBytes);
	assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("the transaction lock covers read-modify-write and is released on failure", () => {
	const dir = tempDir("pi-persona-settings-");
	const file = join(dir, "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	let held = false;
	let released = false;
	assert.throws(() => patchPersonaSettings(file, { preferences: { nudge: false } }, {
		acquireLock: () => {
			assert.equal(held, false);
			held = true;
			return () => { held = false; released = true; };
		},
		rename: () => {
			assert.equal(held, true, "lock remains held while the atomic replacement runs");
			throw new Error("injected failure");
		},
		sleep: () => {},
	}), /injected failure/);
	assert.equal(held, false);
	assert.equal(released, true);
	assert.equal(readPersonaSettings(file).preferences.nudge, true);
});

test("transient Windows lock-open errors retry exclusively without bypassing the lock", () => {
	const file = join(tempDir("pi-persona-settings-lock-retry-"), "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	const transientErrors = ["EPERM", "EACCES", "EBUSY"];
	let attempts = 0;
	let waits = 0;
	patchPersonaSettings(file, { preferences: { nudge: false } }, {
		openExclusiveLock: (lockFile) => {
			attempts++;
			const code = transientErrors.shift();
			if (code) throw Object.assign(new Error(`temporary ${code}`), { code });
			return openSync(lockFile, "wx", 0o600);
		},
		sleep: () => { waits++; },
	});
	assert.equal(attempts, 4, "each transient error is retried before exclusive creation");
	assert.equal(waits, 3);
	assert.equal(readPersonaSettings(file).preferences.nudge, false);
	assert.equal(existsSync(`${file}.lock`), false);
});

test("persistent permission errors time out boundedly and never remove a foreign lock", () => {
	const file = join(tempDir("pi-persona-settings-lock-denied-"), "settings.json");
	patchPersonaSettings(file, { preferences: { nudge: true } });
	const lockFile = `${file}.lock`;
	const lockBytes = "another writer owns this lock\n";
	writeFileSync(lockFile, lockBytes, "utf8");
	const canonicalBytes = readFileSync(file, "utf8");
	let attempts = 0;
	assert.throws(() => patchPersonaSettings(file, { preferences: { nudge: false } }, {
		openExclusiveLock: () => {
			attempts++;
			throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
		},
		sleep: () => {},
	}), /timed out acquiring persona settings lock.*EPERM/i);
	assert.equal(attempts, 80, "transient-looking failures have a fixed retry bound");
	assert.equal(readFileSync(lockFile, "utf8"), lockBytes, "permission failures never trigger stale-lock reclamation");
	assert.equal(readFileSync(file, "utf8"), canonicalBytes);
});

test("migration imports valid models and last persona, commits once, and archives exact originals", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const configBytes = '{"magi":{"models":{"melchior":"provider/a","casper":"provider/c"}}}\n';
	const stateBytes = '{"lastPersona":"magi"}\n';
	writeFileSync(legacyConfigFile, configBytes, "utf8");
	writeFileSync(legacyStateFile, stateBytes, "utf8");
	const migrated = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.deepEqual(migrated.settings.personas.magi?.models, { melchior: "provider/a", casper: "provider/c" });
	assert.equal(migrated.settings.lastPersona, "magi");
	assert.deepEqual(migrated.migrated, [legacyConfigFile, legacyStateFile], migrated.warnings.join("\n"));
	assert.deepEqual(migrated.warnings, []);
	assert.equal(readFileSync(`${legacyConfigFile}.migrated`, "utf8"), configBytes);
	assert.equal(readFileSync(`${legacyStateFile}.migrated`, "utf8"), stateBytes);
	assert.equal(statSync(`${legacyConfigFile}.migrated`).nlink, 1, "archives are portable independent copies, not hard links");
	assert.equal(existsSync(legacyConfigFile), false);
	assert.equal(existsSync(legacyStateFile), false);

	writeFileSync(legacyConfigFile, '{"later":{"models":{"worker":"provider/new"}}}', "utf8");
	const again = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.equal(again.settings.personas.later, undefined, "an existing canonical file is never reimported");
	assert.equal(existsSync(legacyConfigFile), true, "post-migration files are not archived or consumed");
});

test("migration with no valid legacy snapshot returns defaults without creating canonical settings", () => {
	const dir = tempDir("pi-persona-settings-migrate-empty-");
	const file = join(dir, "settings.json");
	const result = migratePersonaSettings(file, {
		legacyConfigFile: join(dir, "missing-config.json"),
		legacyStateFile: join(dir, "missing-state.json"),
	});
	assert.deepEqual(result.settings, { version: 1, preferences: {}, personas: {}, lastPersona: null, selectionRevision: 0 });
	assert.deepEqual(result.migrated, []);
	assert.deepEqual(result.warnings, []);
	assert.equal(existsSync(file), false);
	assert.equal(existsSync(`${file}.lock`), false, "an empty first run is read-only, even for migration locks");
});

test("migration does not overwrite an existing archive and reports the source as retained", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const original = '{"magi":{"models":{"melchior":"provider/a"}}}';
	writeFileSync(legacyConfigFile, original, "utf8");
	writeFileSync(`${legacyConfigFile}.migrated`, "previous archive", "utf8");
	const result = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.equal(result.settings.personas.magi?.models?.melchior, "provider/a");
	assert.equal(readFileSync(`${legacyConfigFile}.migrated`, "utf8"), "previous archive");
	assert.equal(readFileSync(legacyConfigFile, "utf8"), original);
	assert.ok(result.warnings.some((warning) => warning.includes(legacyConfigFile)));
	assert.deepEqual(result.migrated, []);
});

test("unsafe or malformed legacy files remain untouched while valid canonical state is committed", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const invalid = '{"magi":{"models":{"melchior":7}}}';
	writeFileSync(legacyConfigFile, invalid, "utf8");
	writeFileSync(legacyStateFile, "not json", "utf8");
	const result = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.deepEqual(result.settings.personas, {});
	assert.equal(result.settings.lastPersona, null);
	assert.ok(result.warnings.length >= 2);
	assert.equal(readFileSync(legacyConfigFile, "utf8"), invalid);
	assert.equal(readFileSync(legacyStateFile, "utf8"), "not json");
	assert.equal(existsSync(`${legacyConfigFile}.migrated`), false);
	assert.equal(existsSync(`${legacyStateFile}.migrated`), false);
	assert.equal(existsSync(file), false, "malformed-only migration must not materialize default state");
	assert.equal(existsSync(`${file}.lock`), false, "invalid-only legacy input is not a reason to create runtime state");
});

test("legacy JSON containing malformed UTF-8 is neither imported nor archived", () => {
	const dir = tempDir("pi-persona-settings-migrate-invalid-utf8-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const original = Buffer.concat([
		Buffer.from('{"magi":{"models":{"melchior":"provider/before'),
		Buffer.from([0xff]),
		Buffer.from('after"}}}'),
	]);
	writeFileSync(legacyConfigFile, original);
	const result = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.deepEqual(result.settings.personas, {});
	assert.equal(result.settings.lastPersona, null);
	assert.ok(result.warnings.some((warning) => warning.includes(legacyConfigFile)));
	assert.deepEqual(readFileSync(legacyConfigFile), original, "the malformed legacy source must remain byte-for-byte recoverable");
	assert.equal(existsSync(`${legacyConfigFile}.migrated`), false);
	assert.equal(existsSync(file), false, "malformed-only migration cannot materialize canonical defaults");
});

test("migration refuses to overwrite an invalid canonical file or consume legacy inputs", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const canonicalBytes = "{";
	writeFileSync(file, canonicalBytes, "utf8");
	writeFileSync(legacyConfigFile, "{}", "utf8");
	assert.throws(() => migratePersonaSettings(file, { legacyConfigFile, legacyStateFile }), /json|parse|settings/i);
	assert.equal(readFileSync(file, "utf8"), canonicalBytes);
	assert.equal(existsSync(legacyConfigFile), true);
});

test("a legacy source with multiple hard links is not imported or archived", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const alias = join(dir, "legacy-alias.json");
	const original = '{"magi":{"models":{"melchior":"provider/a"}}}';
	writeFileSync(legacyConfigFile, original, "utf8");
	linkSync(legacyConfigFile, alias);
	const result = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.deepEqual(result.settings.personas, {});
	assert.equal(readFileSync(legacyConfigFile, "utf8"), original);
	assert.equal(existsSync(`${legacyConfigFile}.migrated`), false);
	assert.ok(result.warnings.some((warning) => warning.includes(legacyConfigFile)));
});

test("oversized legacy sources are retained and not imported", () => {
	const dir = tempDir("pi-persona-settings-migrate-");
	const file = join(dir, "settings.json");
	const legacyConfigFile = join(dir, "config.json");
	const legacyStateFile = join(dir, "state.json");
	const original = `{"magi":{"models":{}},"padding":"${"x".repeat(1024 * 1024)}"}`;
	writeFileSync(legacyConfigFile, original, "utf8");
	const result = migratePersonaSettings(file, { legacyConfigFile, legacyStateFile });
	assert.deepEqual(result.settings.personas, {});
	assert.ok(result.warnings.some((warning) => warning.includes("exceeds")));
	assert.equal(readFileSync(legacyConfigFile, "utf8"), original);
	assert.equal(existsSync(`${legacyConfigFile}.migrated`), false);
});

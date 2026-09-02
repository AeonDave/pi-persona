import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { tempDir } from "../../setup/temp-dir.ts";
import {
	inspectLegacySeededSpines,
	LEGACY_SEEDED_DEFAULTS,
	migratePristineSeededDefaults,
	type SeedMigrationIO,
	seedDefaults,
	type SpineLegacyIO,
	type SpineLegacyStat,
} from "../../../src/core/seed.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LEGACY_SPINE = fileURLToPath(new URL("../../fixtures/spine-1.8.0.md", import.meta.url));
const LEGACY_WORKER_SPINE = fileURLToPath(new URL("../../fixtures/spine.worker-1.8.0.md", import.meta.url));

/** A throwaway bundled layout (personas + agents + teams + flows + contracts + presets). */
function bundled(): string {
	const dir = tempDir("pi-persona-bundled-");
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
	fs.mkdirSync(path.join(dir, "prompts"));
	fs.writeFileSync(path.join(dir, "prompts", "spine.md"), "SPINE supervisor");
	fs.writeFileSync(path.join(dir, "prompts", "spine.worker.md"), "SPINE worker");
	fs.writeFileSync(path.join(dir, "teams.yaml"), "magi: [a, b, c]");
	return dir;
}
const userDir = (): string => tempDir("pi-persona-user-");
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

test("one failing file never aborts the seed — the rest lands and the failure is a named warning", () => {
	// Windows: a destination held open by an editor/AV makes renameSync fail with EPERM.
	// Simulate by pointing the bundled source at a missing file for ONE entry: the copy
	// throws, the remaining defaults must still be placed.
	const b = bundled();
	const u = userDir();
	fs.rmSync(path.join(b, "agents", "scout.md"));
	fs.mkdirSync(path.join(b, "agents"), { recursive: true });
	// A directory where a file is expected makes copyFileSync fail deterministically on every OS.
	fs.mkdirSync(path.join(b, "agents", "scout.md"));
	const r = seedDefaults(b, u, false);
	assert.equal(read(path.join(u, "agents", "sample.md")), "PERSONA sample", "later files still seeded");
	assert.ok(fs.existsSync(path.join(u, "teams.yaml")), "the tail of the seed still ran");
	assert.ok(r.warnings?.some((w) => w.includes("scout.md")), "the failure is named, not thrown");
});

test("the spine pair is seeded FLAT into <user>, which is where `on` resolution looks for the user's own copy", () => {
	// Without this, the documented "your own copy shadows the bundled one" precedence has no
	// gesture that creates that copy — a user would have to know the filenames and write them by
	// hand. The destination is deliberately the data dir itself, not a `prompts/` subfolder:
	// that is the path resolveSpine is handed.
	const u = userDir();
	seedDefaults(bundled(), u, false);
	assert.equal(read(path.join(u, "spine.md")), "SPINE supervisor");
	assert.equal(read(path.join(u, "spine.worker.md")), "SPINE worker");
	assert.ok(!fs.existsSync(path.join(u, "prompts")), "flat, not nested — a nested copy shadows nothing");
});

test("a seeded spine follows the same keep-edits / restore-originals rule as every other default", () => {
	const b = bundled();
	const u = userDir();
	seedDefaults(b, u, false);
	fs.writeFileSync(path.join(u, "spine.md"), "MY OWN LAYER");
	seedDefaults(b, u, false);
	assert.equal(read(path.join(u, "spine.md")), "MY OWN LAYER", "a non-forced seed keeps the layer the user wrote");
	seedDefaults(b, u, true);
	assert.equal(read(path.join(u, "spine.md")), "SPINE supervisor", "/persona restore brings the bundled text back");
});

test("an ordinary seed never rewrites an existing pristine v1.8.0 spine pair", () => {
	const u = userDir();
	fs.copyFileSync(LEGACY_SPINE, path.join(u, "spine.md"));
	fs.copyFileSync(LEGACY_WORKER_SPINE, path.join(u, "spine.worker.md"));

	const result = seedDefaults(REPO_ROOT, u, false);

	assert.equal(read(path.join(u, "spine.md")), read(LEGACY_SPINE));
	assert.equal(read(path.join(u, "spine.worker.md")), read(LEGACY_WORKER_SPINE));
	assert.ok(result.skipped.includes(path.join(u, "spine.md")));
	assert.ok(result.skipped.includes(path.join(u, "spine.worker.md")));
});

test("an ordinary seed preserves edited or custom spine copies", () => {
	const u = userDir();
	const edited = `${read(LEGACY_SPINE)}\nMy local addition.\n`;
	const customWorker = "My entirely custom worker layer.\n";
	fs.writeFileSync(path.join(u, "spine.md"), edited);
	fs.writeFileSync(path.join(u, "spine.worker.md"), customWorker);

	const result = seedDefaults(REPO_ROOT, u, false);

	assert.equal(read(path.join(u, "spine.md")), edited);
	assert.equal(read(path.join(u, "spine.worker.md")), customWorker);
	assert.ok(result.skipped.includes(path.join(u, "spine.md")));
	assert.ok(result.skipped.includes(path.join(u, "spine.worker.md")));
});

function legacyStat(overrides: Partial<SpineLegacyStat> = {}): SpineLegacyStat {
	return {
		dev: 1,
		ino: 2,
		nlink: 1,
		size: 2714,
		isFile: () => true,
		...overrides,
	};
}

test("legacy inspection is read-only, role-scoped, and recognizes only exact pristine bytes", () => {
	const u = userDir();
	const supervisor = path.join(u, "spine.md");
	const worker = path.join(u, "spine.worker.md");
	fs.copyFileSync(LEGACY_SPINE, supervisor);
	fs.copyFileSync(LEGACY_WORKER_SPINE, worker);

	const result = inspectLegacySeededSpines(u, { supervisor: true, worker: false });

	assert.deepEqual(result, { legacy: [supervisor], warnings: [] });
	assert.equal(read(supervisor), read(LEGACY_SPINE), "inspection never rewrites the user's file");
	assert.equal(read(worker), read(LEGACY_WORKER_SPINE), "a disabled role is not touched or classified");
});

test("legacy inspection preserves a custom file with the exact legacy byte length", () => {
	const u = userDir();
	const supervisor = path.join(u, "spine.md");
	const custom = Buffer.alloc(fs.statSync(LEGACY_SPINE).size, 0x78);
	fs.writeFileSync(supervisor, custom);

	const result = inspectLegacySeededSpines(u, { supervisor: true, worker: false });

	assert.deepEqual(result, { legacy: [], warnings: [] });
	assert.deepEqual(fs.readFileSync(supervisor), custom);
});

test("legacy inspection rejects oversized, non-regular, and hard-linked user files before opening or reading them", () => {
	for (const [label, stat] of [
		["oversized", legacyStat({ size: 2715 })],
		["symlink/non-regular", legacyStat({ isFile: () => false })],
		["hard-linked", legacyStat({ nlink: 2 })],
	] as const) {
		let opens = 0;
		let reads = 0;
		const io: SpineLegacyIO = {
			lstat: () => stat,
			open: () => {
				opens += 1;
				return 7;
			},
			fstat: () => stat,
			read: () => {
				reads += 1;
				return Buffer.alloc(0);
			},
			close: () => {},
		};

		const result = inspectLegacySeededSpines("user", { supervisor: true, worker: false }, io);

		assert.equal(opens, 0, `${label}: lstat must reject it before open/fstat`);
		assert.equal(reads, 0, `${label}: rejected user files must never be read`);
		assert.deepEqual(result, { legacy: [], warnings: [] });
	}
});

test("legacy inspection fstats the opened descriptor and rejects a swapped unsafe target before reading", () => {
	let reads = 0;
	let closes = 0;
	const io: SpineLegacyIO = {
		lstat: () => legacyStat(),
		open: () => 7,
		fstat: () => legacyStat({ nlink: 2 }),
		read: () => {
			reads += 1;
			return Buffer.alloc(2714);
		},
		close: () => {
			closes += 1;
		},
	};

	const result = inspectLegacySeededSpines("user", { supervisor: true, worker: false }, io);

	assert.equal(reads, 0, "an unsafe descriptor is never read even when the earlier lstat looked safe");
	assert.equal(closes, 1, "the rejected descriptor is still closed");
	assert.deepEqual(result, { legacy: [], warnings: [] });
});

test("legacy inspection uses a fixed-size read and revalidates the opened descriptor after it", () => {
	const bytes = fs.readFileSync(LEGACY_SPINE);
	const seenMax: number[] = [];
	let fstats = 0;
	const io: SpineLegacyIO = {
		lstat: () => legacyStat(),
		open: () => 7,
		fstat: () => {
			fstats += 1;
			return legacyStat();
		},
		read: (_fd, maxBytes) => {
			seenMax.push(maxBytes);
			return bytes;
		},
		close: () => {},
	};

	const result = inspectLegacySeededSpines("user", { supervisor: true, worker: false }, io);

	assert.deepEqual(seenMax, [2715], "the reader is capped at expected legacy bytes + one sentinel byte");
	assert.equal(fstats, 2, "the descriptor is checked before and after the bounded read");
	assert.deepEqual(result, { legacy: [path.join("user", "spine.md")], warnings: [] });
});

test("on a bundled persona/agent name collision the persona owns the seed and the ambiguity is reported", () => {
	const u = userDir();
	const r = seedDefaults(bundled(), u, false);
	assert.equal(read(path.join(u, "agents", "reviewer.md")), "PERSONA reviewer", "the persona wins the shared filename");
	assert.ok(r.skipped.some((p) => p.endsWith("reviewer.md")), "the colliding agent copy was skipped");
	assert.deepEqual(r.collisions, ["reviewer"]);
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

test("force restore replaces a hard-linked destination entry without modifying the other link", () => {
	const b = bundled();
	const u = userDir();
	const external = path.join(u, "external-user-file.md");
	const target = path.join(u, "agents", "sample.md");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(external, "USER DATA OUTSIDE THE SEEDED ENTRY");
	fs.linkSync(external, target);

	seedDefaults(b, u, true);

	assert.equal(read(external), "USER DATA OUTSIDE THE SEEDED ENTRY", "restore must replace the directory entry, not write through its inode");
	assert.equal(read(target), "PERSONA sample");
});

test("seedDefaults tolerates a bundled dir missing some asset folders", () => {
	const dir = tempDir("pi-persona-partial-");
	fs.mkdirSync(path.join(dir, "personas"));
	fs.writeFileSync(path.join(dir, "personas", "a.md"), "x"); // only personas
	const u = userDir();
	const r = seedDefaults(dir, u, false);
	assert.equal(r.copied.length, 1);
	assert.ok(fs.existsSync(path.join(u, "agents", "a.md")));
});

test("migratePristineSeededDefaults upgrades only an exact old bundled copy", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(path.join(b, "personas", "custom.md"), "CURRENT CUSTOM\n");
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	fs.writeFileSync(path.join(u, "agents", "dev.md"), "OLD DEFAULT\n");
	fs.writeFileSync(path.join(u, "agents", "custom.md"), "USER EDIT\n");
	const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: "OLD DEFAULT\n".length, sha256: hash("OLD DEFAULT\n") } },
	});

	assert.deepEqual(result.migrated, [path.join(u, "agents", "dev.md")]);
	assert.equal(read(path.join(u, "agents", "dev.md")), "CURRENT DEFAULT\n");
	assert.equal(read(path.join(u, "agents", "custom.md")), "USER EDIT\n", "custom bytes are preserved");
});

test("migration accepts multiple exact historical versions for one seeded default", () => {
	const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
	const historical = ["OLD A\n", "OLD B\n"] as const;
	const candidates = historical.map((text) => ({ size: Buffer.byteLength(text), sha256: hash(text) }));

	for (const old of historical) {
		const b = tempDir("pi-persona-migration-bundled-");
		const u = userDir();
		fs.mkdirSync(path.join(b, "personas"), { recursive: true });
		fs.mkdirSync(path.join(u, "agents"), { recursive: true });
		fs.writeFileSync(path.join(b, "personas", "elite.md"), "CURRENT ELITE\n");
		fs.writeFileSync(path.join(u, "agents", "elite.md"), old);

		const result = migratePristineSeededDefaults(b, u, {
			legacyDefaults: { "personas/elite.md": candidates },
		});

		assert.deepEqual(result.migrated, [path.join(u, "agents", "elite.md")], `migrates ${old.trim()}`);
		assert.equal(read(path.join(u, "agents", "elite.md")), "CURRENT ELITE\n");
	}
});

test("migration applies dependencies from the historical version that actually matched", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(b, "agents"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const short = "OLD\n";
	const matched = "A DIFFERENT, LONGER OLD DEFAULT\n";
	const spec = (text: string, addition: string) => ({
		size: Buffer.byteLength(text),
		sha256: createHash("sha256").update(text).digest("hex"),
		requiredAdditions: [`agents/${addition}`],
	});
	fs.writeFileSync(path.join(b, "personas", "elite.md"), "CURRENT ELITE\n");
	fs.writeFileSync(path.join(b, "agents", "short-only.md"), "SHORT\n");
	fs.writeFileSync(path.join(b, "agents", "matched-only.md"), "MATCHED\n");
	fs.writeFileSync(path.join(u, "agents", "elite.md"), matched);

	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: {
			"personas/elite.md": [spec(short, "short-only.md"), spec(matched, "matched-only.md")],
		},
	});

	assert.deepEqual(result.installed, [path.join(u, "agents", "matched-only.md")]);
	assert.equal(fs.existsSync(path.join(u, "agents", "short-only.md")), false);
	assert.equal(read(path.join(u, "agents", "elite.md")), "CURRENT ELITE\n");
});

test("migratePristineSeededDefaults rejects a symlink instead of replacing its target", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const target = path.join(u, "target.md");
	fs.writeFileSync(target, "OLD DEFAULT\n");
	const user = path.join(u, "agents", "dev.md");
	try {
		fs.symlinkSync(target, user);
	} catch {
		return; // symlinks may be disabled on a restricted Windows checkout
	}
	const hash = createHash("sha256").update("OLD DEFAULT\n").digest("hex");
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: "OLD DEFAULT\n".length, sha256: hash } },
	});
	assert.deepEqual(result.migrated, []);
	assert.equal(read(target), "OLD DEFAULT\n");
});

test("migration inspects only explicit legacy entries and never opens an unrelated huge custom file", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD DEFAULT\n";
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(path.join(u, "agents", "dev.md"), old);
	const custom = path.join(u, "agents", "custom.md");
	fs.writeFileSync(custom, Buffer.alloc(4 * 1024 * 1024, 0x78));
	const opened: string[] = [];
	const io: SeedMigrationIO = {
		lstat: fs.lstatSync,
		open: (file) => {
			opened.push(file);
			return fs.openSync(file, "r");
		},
		fstat: fs.fstatSync,
		read: (fd, maxBytes) => {
			const buffer = Buffer.alloc(maxBytes);
			const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytes);
		},
		close: fs.closeSync,
	};
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: Buffer.byteLength(old), sha256: createHash("sha256").update(old).digest("hex") } },
		io,
	});
	assert.deepEqual(result.migrated, [path.join(u, "agents", "dev.md")]);
	assert.ok(!opened.includes(custom), "unrelated custom bytes were never opened");
});

test("migration bounds a file that grows after fstat and skips it", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD DEFAULT\n";
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(path.join(u, "agents", "dev.md"), old);
	const maxReads: number[] = [];
	const stat = { dev: 1, ino: 2, nlink: 1, size: Buffer.byteLength(old), isFile: () => true };
	const io: SeedMigrationIO = {
		lstat: () => stat,
		open: () => 7,
		fstat: () => stat,
		read: (_fd, maxBytes) => {
			maxReads.push(maxBytes);
			return Buffer.alloc(maxBytes); // sentinel byte proves growth
		},
		close: () => {},
	};
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: Buffer.byteLength(old), sha256: createHash("sha256").update(old).digest("hex") } },
		io,
	});
	assert.deepEqual(result.migrated, []);
	assert.deepEqual(maxReads, [Buffer.byteLength(old) + 1]);
});

test("migration never overwrites a concurrent edit in the final replacement window", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD DEFAULT\n";
	const target = path.join(u, "agents", "dev.md");
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(target, old);
	const spec = { size: Buffer.byteLength(old), sha256: createHash("sha256").update(old).digest("hex") };
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": spec },
		beforeInstall: () => fs.writeFileSync(target, "USER EDIT WON THE RACE\n"),
	});
	assert.deepEqual(result.migrated, []);
	assert.equal(read(target), "USER EDIT WON THE RACE\n");
	assert.ok(result.warnings.some((warning) => warning.includes("changed during migration")));
});

test("migration stages exclusively and installs with an atomic hard-link", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD DEFAULT\n";
	const target = path.join(u, "agents", "dev.md");
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(target, old);
	const flags: number[] = [];
	let linked = false;
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: Buffer.byteLength(old), sha256: createHash("sha256").update(old).digest("hex") } },
		io: {
			copyFile: (from, to, copyFlags) => {
				flags.push(copyFlags ?? 0);
				fs.copyFileSync(from, to, copyFlags);
			},
			link: (from, to) => {
				linked = true;
				fs.linkSync(from, to);
			},
		},
	});
	assert.deepEqual(result.migrated, [target]);
	assert.equal(linked, true, "installation uses hard-link creation, not copy-to-target");
	assert.ok(flags.some((value) => (value & fs.constants.COPYFILE_EXCL) !== 0), "staging uses exclusive creation");
	assert.equal(read(target), "CURRENT DEFAULT\n");
});

test("a preexisting random staging path is never followed, overwritten, or removed", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD DEFAULT\n";
	const target = path.join(u, "agents", "dev.md");
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(target, old);
	const staged = `${target}.pi-persona-migrate-${process.pid}-fixed.tmp`;
	fs.writeFileSync(staged, "KEEP THIS CRASH RECOVERY FILE\n");
	const result = migratePristineSeededDefaults(b, u, {
		idFactory: () => "fixed",
		legacyDefaults: { "personas/dev.md": { size: Buffer.byteLength(old), sha256: createHash("sha256").update(old).digest("hex") } },
	});
	assert.deepEqual(result.migrated, []);
	assert.equal(read(staged), "KEEP THIS CRASH RECOVERY FILE\n");
	assert.equal(read(target), old);
	assert.ok(result.warnings.some((warning) => warning.includes("staging path already exists")));
});

test("migration exposes inspection I/O failures as diagnostics", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	fs.writeFileSync(path.join(b, "personas", "dev.md"), "CURRENT DEFAULT\n");
	fs.writeFileSync(path.join(u, "agents", "dev.md"), "OLD DEFAULT\n");
	const io: SeedMigrationIO = { open: () => { throw new Error("open failed"); } };
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: { "personas/dev.md": { size: 12, sha256: "unused" } },
		io,
	});
	assert.equal(result.migrated.length, 0);
	assert.ok(result.warnings.some((warning) => warning.includes("open failed")));
});

test("an eligible parent installs its missing required addition before migrating", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(b, "agents"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD ELITE\n";
	fs.writeFileSync(path.join(b, "personas", "elite.md"), "CURRENT ELITE\n");
	fs.writeFileSync(path.join(b, "agents", "evidence-verifier.md"), "EVIDENCE VERIFIER\n");
	fs.writeFileSync(path.join(u, "agents", "elite.md"), old);
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: {
			"personas/elite.md": {
				size: Buffer.byteLength(old),
				sha256: createHash("sha256").update(old).digest("hex"),
				requiredAdditions: ["agents/evidence-verifier.md"],
			},
		},
	});
	assert.deepEqual(result.installed, [path.join(u, "agents", "evidence-verifier.md")]);
	assert.deepEqual(result.migrated, [path.join(u, "agents", "elite.md")]);
	assert.equal(read(path.join(u, "agents", "evidence-verifier.md")), "EVIDENCE VERIFIER\n");
	assert.equal(read(path.join(u, "agents", "elite.md")), "CURRENT ELITE\n");
});

test("fresh or edited parents do not install required additions", () => {
	for (const mode of ["fresh", "edited"] as const) {
		const b = tempDir("pi-persona-migration-bundled-");
		const u = userDir();
		fs.mkdirSync(path.join(b, "personas"), { recursive: true });
		fs.mkdirSync(path.join(b, "agents"), { recursive: true });
		fs.mkdirSync(path.join(u, "agents"), { recursive: true });
		const old = "OLD ELITE\n";
		fs.writeFileSync(path.join(b, "personas", "elite.md"), "CURRENT ELITE\n");
		fs.writeFileSync(path.join(b, "agents", "evidence-verifier.md"), "EVIDENCE VERIFIER\n");
		if (mode === "edited") fs.writeFileSync(path.join(u, "agents", "elite.md"), "USER EDIT\n");
		const result = migratePristineSeededDefaults(b, u, {
			legacyDefaults: {
				"personas/elite.md": {
					size: Buffer.byteLength(old),
					sha256: createHash("sha256").update(old).digest("hex"),
					requiredAdditions: ["agents/evidence-verifier.md"],
				},
			},
		});
		assert.deepEqual(result.installed, [], `${mode}: no dependency install`);
		assert.deepEqual(result.migrated, [], `${mode}: no parent migration`);
		assert.equal(fs.existsSync(path.join(u, "agents", "evidence-verifier.md")), false, `${mode}: dependency remains absent`);
	}
});

test("a required-addition failure leaves the eligible parent on its old bytes", () => {
	const b = tempDir("pi-persona-migration-bundled-");
	const u = userDir();
	fs.mkdirSync(path.join(b, "personas"), { recursive: true });
	fs.mkdirSync(path.join(b, "agents"), { recursive: true });
	fs.mkdirSync(path.join(u, "agents"), { recursive: true });
	const old = "OLD ELITE\n";
	const parent = path.join(u, "agents", "elite.md");
	fs.writeFileSync(path.join(b, "personas", "elite.md"), "CURRENT ELITE\n");
	fs.writeFileSync(path.join(b, "agents", "evidence-verifier.md"), "EVIDENCE VERIFIER\n");
	fs.writeFileSync(parent, old);
	const result = migratePristineSeededDefaults(b, u, {
		legacyDefaults: {
			"personas/elite.md": {
				size: Buffer.byteLength(old),
				sha256: createHash("sha256").update(old).digest("hex"),
				requiredAdditions: ["agents/evidence-verifier.md"],
			},
		},
		io: {
			copyFile: (from, to, flags) => {
				if (from.endsWith(path.join("agents", "evidence-verifier.md"))) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
				fs.copyFileSync(from, to, flags);
			},
		},
	});
	assert.deepEqual(result.installed, []);
	assert.deepEqual(result.migrated, []);
	assert.equal(read(parent), old, "dependency failure never mutates the parent");
	assert.ok(result.warnings.some((warning) => warning.includes("required addition")));
});

test("no legacy digest matches a CURRENTLY shipped file — an entry that did would migrate nothing", () => {
	// The table records the bytes of PREVIOUS releases, hashed in the repository's canonical LF form
	// (.gitattributes pins `eol=lf`, which is what ships). Hashing the working copy instead — CRLF on
	// Windows, or simply the current file — produces an entry that can never match a user's stale copy
	// and silently ships the change inert. This catches both mistakes at once.
	const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
	for (const [asset, entry] of Object.entries(LEGACY_SEEDED_DEFAULTS)) {
		const file = path.join(repoRoot, asset);
		if (!fs.existsSync(file)) continue;
		const shipped = fs.readFileSync(file).toString("utf8").split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
		const digest = createHash("sha256").update(shipped, "utf8").digest("hex");
		for (const spec of Array.isArray(entry) ? entry : [entry]) {
			assert.notEqual(spec.sha256, digest, `${asset}: a legacy digest equals the file being shipped, so nothing would ever be migrated`);
		}
	}
});

test("the MAGI cores carry a legacy digest, so an existing install gains their verticalization", () => {
	// Agents are seeded COPIES, not a live layer read from the package: without an entry here the
	// `purpose:` added to the three cores reaches only brand-new installs.
	for (const core of ["agents/melchior.md", "agents/balthasar.md", "agents/casper.md"]) {
		assert.ok(LEGACY_SEEDED_DEFAULTS[core], `${core} has no legacy digest — its update would ship inert`);
	}
});

test("swarm carries a legacy digest, so an existing install gains the live-peer section", () => {
	assert.ok(LEGACY_SEEDED_DEFAULTS["personas/swarm.md"], "personas/swarm.md has no legacy digest — its 1.12.2 live-peer section would ship inert");
});

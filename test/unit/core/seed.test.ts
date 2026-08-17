import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { tempDir } from "../../setup/temp-dir.ts";
import {
	inspectLegacySeededSpines,
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
	const dir = tempDir("pi-persona-partial-");
	fs.mkdirSync(path.join(dir, "personas"));
	fs.writeFileSync(path.join(dir, "personas", "a.md"), "x"); // only personas
	const u = userDir();
	const r = seedDefaults(dir, u, false);
	assert.equal(r.copied.length, 1);
	assert.ok(fs.existsSync(path.join(u, "agents", "a.md")));
});

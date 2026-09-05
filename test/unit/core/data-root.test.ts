import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { tempDir } from "../../setup/temp-dir.ts";
import { migrateLegacyDataRoot } from "../../../src/core/data-root.ts";

/** A throwaway Pi agent dir — never the developer's real ~/.pi/agent. */
function agentDir(): string {
	return tempDir("pi-persona-dataroot-");
}

function write(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
}

/** The shape a real install carries under the legacy root: one registry scope per workspace plus
 *  the durable join-code aliases (and their reservations), which nothing can reconstruct. */
function seedLegacyRoot(dir: string): { registry: string; code: string; used: string; ledger: string } {
	const exocom = path.join(dir, "pi-persona", "exocom");
	return {
		registry: write(path.join(exocom, "0123456789abcdef01234567", "agents", "sess-a.json"), '{"session_id":"sess-a"}'),
		ledger: write(path.join(exocom, "0123456789abcdef01234567", "ledger.jsonl"), '{"seq":1}\n'),
		code: write(path.join(exocom, "codes", "30615a39.json"), '{"code":"0aZ9","scope_id":"0123456789abcdef01234567","version":1}'),
		used: write(path.join(exocom, "codes", ".used", "30615a39.json"), '{"code":"0aZ9","scope_id":"0123456789abcdef01234567","version":1}'),
	};
}

function relocated(dir: string, legacyPath: string): string {
	return legacyPath.replace(path.join(dir, "pi-persona"), path.join(dir, "persona"));
}

test("the legacy root moves across whole when the current root does not exist yet", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.existsSync(path.join(dir, "pi-persona")), false, "the agent dir keeps ONE directory per plugin");
	for (const source of Object.values(legacy)) {
		assert.equal(fs.existsSync(source), false, `${source} was moved, not copied`);
		assert.equal(fs.readFileSync(relocated(dir, source), "utf8").length > 0, true);
		assert.ok(result.moved.includes(relocated(dir, source)), `${source} is reported`);
	}
	assert.deepEqual(result.kept, []);
});

test("the durable join-code subtree survives with its reservations", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	migrateLegacyDataRoot(dir);
	const codes = path.join(dir, "persona", "exocom", "codes");
	assert.equal(fs.readFileSync(path.join(codes, "30615a39.json"), "utf8"), fs.readFileSync(relocated(dir, legacy.code), "utf8"));
	assert.equal(JSON.parse(fs.readFileSync(path.join(codes, "30615a39.json"), "utf8")).scope_id, "0123456789abcdef01234567");
	assert.equal(JSON.parse(fs.readFileSync(path.join(codes, ".used", "30615a39.json"), "utf8")).code, "0aZ9");
});

test("both roots merge without overwriting anything already at the current root", () => {
	const dir = agentDir();
	seedLegacyRoot(dir);
	const collision = write(path.join(dir, "persona", "exocom", "codes", "30615a39.json"), '{"code":"0aZ9","scope_id":"ffffffffffffffffffffffff","version":1}');
	write(path.join(dir, "persona", "config.json"), "{}"); // untouched persona data already at the destination
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(result.warnings, []);
	assert.equal(JSON.parse(fs.readFileSync(collision, "utf8")).scope_id, "ffffffffffffffffffffffff", "the destination copy wins");
	const legacyCollision = path.join(dir, "pi-persona", "exocom", "codes", "30615a39.json");
	assert.equal(fs.existsSync(legacyCollision), true, "a copy we did not move is never deleted");
	assert.deepEqual(result.kept, [legacyCollision]);
	assert.equal(fs.existsSync(path.join(dir, "persona", "exocom", "codes", ".used", "30615a39.json")), true, "the non-colliding siblings still move");
	assert.equal(fs.existsSync(path.join(dir, "persona", "exocom", "0123456789abcdef01234567", "agents", "sess-a.json")), true);
	assert.equal(fs.readFileSync(path.join(dir, "persona", "config.json"), "utf8"), "{}");
});

test("a second run is a no-op, and so is a run with only the current root or neither", () => {
	const dir = agentDir();
	seedLegacyRoot(dir);
	const first = migrateLegacyDataRoot(dir);
	assert.ok(first.moved.length > 0);
	const second = migrateLegacyDataRoot(dir); // current root only
	assert.deepEqual(second, { moved: [], kept: [], warnings: [] });
	assert.equal(fs.existsSync(path.join(dir, "persona", "exocom", "codes", "30615a39.json")), true);

	const empty = agentDir(); // neither root
	assert.deepEqual(migrateLegacyDataRoot(empty), { moved: [], kept: [], warnings: [] });
	assert.deepEqual(fs.readdirSync(empty), [], "no root is created for an install that has neither");
});

test("an interrupted move is completed rather than reported as a collision", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	// Exactly the state a crash between link() and unlink() leaves: both names, one inode.
	const target = relocated(dir, legacy.code);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.linkSync(legacy.code, target);
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(result.kept, [], "the same inode under both names is our own half-done move");
	assert.ok(result.moved.includes(target));
	assert.equal(fs.existsSync(path.join(dir, "pi-persona")), false);
});

test("entries that are not regular files stay where they are", () => {
	const dir = agentDir();
	seedLegacyRoot(dir);
	const link = path.join(dir, "pi-persona", "exocom", "codes", "linked.json");
	fs.symlinkSync(path.join(dir, "persona", "config.json"), link);
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "a link is never followed or moved");
	assert.deepEqual(result.kept, [link]);
	assert.equal(fs.existsSync(path.join(dir, "persona", "exocom", "codes", "linked.json")), false);
	assert.equal(fs.existsSync(path.join(dir, "persona", "exocom", "codes", "30615a39.json")), true, "its siblings still move");
});

test("a filesystem without hard links falls back to a copy that never clobbers", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			link: () => {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			},
		},
	});
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.existsSync(path.join(dir, "pi-persona")), false);
	assert.equal(fs.readFileSync(relocated(dir, legacy.used), "utf8").includes("0aZ9"), true);
});

test("a destination that cannot hold the tree degrades to a warning and keeps the source", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	write(path.join(dir, "persona", "exocom"), "not a directory");
	const result = migrateLegacyDataRoot(dir);
	assert.equal(result.warnings.length, 1, result.warnings.join("; "));
	assert.match(result.warnings[0] as string, /data root migration/);
	assert.equal(fs.existsSync(legacy.code), true, "nothing is removed when nothing was moved");
	assert.deepEqual(result.moved, []);
});

/** A directory link the way the rest of this suite plants one (junctions need no privilege on
 *  Windows; a plain `dir` symlink does). Returns false on a host that refuses either. */
function linkDirectory(target: string, link: string): boolean {
	try {
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch {
		return false;
	}
}

test("a linked destination directory never relocates data out of the agent dir", (t) => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const outside = path.join(dir, "outside");
	fs.mkdirSync(outside, { recursive: true });
	if (!linkDirectory(outside, path.join(dir, "persona", "exocom", "codes"))) {
		t.skip("this host does not permit directory links");
		return;
	}
	const result = migrateLegacyDataRoot(dir);
	assert.equal(fs.existsSync(path.join(outside, "30615a39.json")), false, "the durable join code stayed inside the agent dir");
	assert.equal(fs.existsSync(legacy.code), true, "a source we did not place is never removed");
	assert.equal(result.warnings.length > 0, true, "a linked destination is reported");
	assert.deepEqual(result.moved.filter((p) => p.includes("codes")), []);
});

test("a linked destination at the exocom level leaves registry and ledger state where they are", (t) => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const outside = path.join(dir, "outside");
	fs.mkdirSync(outside, { recursive: true });
	if (!linkDirectory(outside, path.join(dir, "persona", "exocom"))) {
		t.skip("this host does not permit directory links");
		return;
	}
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(fs.readdirSync(outside), [], "nothing was written through the link");
	assert.equal(fs.existsSync(legacy.ledger), true);
	assert.equal(fs.existsSync(legacy.registry), true);
	assert.equal(result.warnings.length > 0, true);
	assert.deepEqual(result.moved, []);
});

test("a relocated persona root is followed, because that is where the plugin already reads and writes", (t) => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const elsewhere = path.join(dir, "elsewhere");
	fs.mkdirSync(elsewhere, { recursive: true });
	if (!linkDirectory(elsewhere, path.join(dir, "persona"))) {
		t.skip("this host does not permit directory links");
		return;
	}
	const result = migrateLegacyDataRoot(dir);
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.readFileSync(path.join(elsewhere, "exocom", "codes", "30615a39.json"), "utf8").includes("0aZ9"), true);
	assert.equal(fs.existsSync(legacy.code), false);
	assert.equal(fs.existsSync(path.join(dir, "pi-persona")), false);
});

test("a peer that finished a move is not reported as a collision", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			// Exactly what a peer migrator leaves behind between our readdir and our link: the bytes
			// at the destination, the legacy name gone, and EEXIST for us.
			link: (from, to) => {
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(from, to);
				fs.unlinkSync(from);
				throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
			},
		},
	});
	assert.deepEqual(result.kept, [], "nothing is kept: every source is gone");
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.existsSync(relocated(dir, legacy.code)), true);
});

test("losing the race to remove a migrated source is not a warning", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			// NTFS hands the loser of two concurrent removals EPERM, not ENOENT — with the name
			// already gone in every measured case.
			unlink: (target) => {
				fs.unlinkSync(target);
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			},
		},
	});
	assert.deepEqual(result.warnings, [], "a source that is provably gone was migrated, not stranded");
	assert.equal(result.moved.includes(relocated(dir, legacy.code)), true);
	assert.equal(fs.existsSync(path.join(dir, "pi-persona")), false);
});

test("a source that cannot be removed leaves no hard-linked destination behind", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			// One locked legacy file (a foreign handle), everything else removable.
			unlink: (target) => {
				if (target === legacy.ledger) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				fs.unlinkSync(target);
			},
		},
	});
	const target = relocated(dir, legacy.ledger);
	assert.equal(fs.existsSync(legacy.ledger), true, "the pre-run state is intact");
	assert.equal(fs.existsSync(target), false, "exocom refuses a ledger with a second link, so ours is undone");
	assert.equal(result.moved.includes(target), false);
	assert.deepEqual(result.kept, [legacy.ledger]);
	assert.equal(result.warnings.length, 1, result.warnings.join("; "));
	assert.equal(fs.existsSync(relocated(dir, legacy.code)), true, "its siblings still move");
});

test("a destination link that cannot be undone is reported as unusable", () => {
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			unlink: (target) => {
				if (target.includes("ledger.jsonl")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				fs.unlinkSync(target);
			},
		},
	});
	assert.equal(fs.existsSync(legacy.ledger), true);
	assert.equal(fs.existsSync(relocated(dir, legacy.ledger)), true, "neither name could be removed");
	assert.equal(result.warnings.length, 1, result.warnings.join("; "));
	assert.match(result.warnings[0] as string, /unusable/);
});

test("resuming an interrupted move never unwinds the placement an earlier run completed", () => {
	// An interrupted run leaves the bytes under BOTH names, so the next run finds its own inode at the
	// destination and only has to finish the unlink. If THAT unlink is blocked too, undoing the link
	// would delete a placement this run never made and leave the destination empty — the one outcome
	// worse than a lingering second name.
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const target = relocated(dir, legacy.ledger);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.linkSync(legacy.ledger, target); // the previous run linked, then died before unlinking

	const result = migrateLegacyDataRoot(dir, {
		io: {
			// A foreign handle still holds the legacy name open, exactly as it did last time.
			unlink: (victim) => {
				if (victim === legacy.ledger) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				fs.unlinkSync(victim);
			},
		},
	});

	assert.equal(fs.existsSync(target), true, "the earlier run's placement must survive");
	assert.equal(fs.existsSync(legacy.ledger), true, "and its legacy name is still there to retry");
	assert.ok(
		result.warnings.some((w) => w.includes("already holds it")),
		`the blocked removal is reported without undoing the placement: ${JSON.stringify(result.warnings)}`,
	);
});

test("a peer that finished the move is not a collision on the copy fallback either", () => {
	// The link-less path must not report a completed peer move as a collision either. Note the source
	// being gone is caught by copyFileSync's own ENOENT before EEXIST is ever reached, so this covers
	// the PATH rather than the `existsSync` guard on the EEXIST branch, which that ENOENT shadows.
	const dir = agentDir();
	const legacy = seedLegacyRoot(dir);
	const result = migrateLegacyDataRoot(dir, {
		io: {
			link: (from, to) => {
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(from, to);
				fs.unlinkSync(from);
				throw Object.assign(new Error("EPERM"), { code: "EPERM" }); // forces copyAcross
			},
		},
	});
	assert.deepEqual(result.kept, [], "a completed peer move leaves nothing to keep");
	assert.equal(fs.existsSync(relocated(dir, legacy.code)), true);
});

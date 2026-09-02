/**
 * Seeding the bundled defaults into the user's Pi agent dir, so a user can edit/extend them
 * and the supervisor always runs the user's copies (they shadow the builtin by discovery
 * precedence). `force` overwrites existing files — that is the "restore originals" command;
 * non-force keeps user edits (first run / pulling in new defaults).
 *
 * Layout mirrors discovery: personas + agents live together under `<user>/agents` (classified
 * by `persona: true`), teams in `<user>/teams.yaml`, the spine pair flat in `<user>` (bundled
 * under `prompts/`, but that is where `resolveSpine` looks), and flows/contracts/presets in
 * their own `<user>/<kind>` dirs. Persona and agent names are one shared namespace at runtime; a
 * colliding seed is reported and the persona wins the single shared user file. The loader then
 * reports the ambiguity instead of silently splitting the namespaces.
 *
 * Pure over node:fs (no Pi imports), so the copy/skip logic is unit-tested with temp dirs.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SPINE_FILES = ["spine.md", "spine.worker.md"] as const;
type SpineFile = (typeof SPINE_FILES)[number];

/** Exact bytes shipped in v1.8.0 and copied by `/persona seed`. v1.8.1 rewrote both prompts, but
 *  `on` prefers the seeded user file, so those pristine copies otherwise shadow the rewrite forever.
 *  Detection is deliberately read-only: a single user edit changes the digest and is preserved,
 *  while an exact legacy copy can be bypassed by resolution without risking a concurrent edit. */
const LEGACY_SPINE_SHA256: Readonly<Record<SpineFile, string>> = {
	"spine.md": "36c304f0bf9bf1114342cde8cd638adec004a6a50415e17d23c90c82e2394b7b",
	"spine.worker.md": "33dbe81db24602f208a23957c88e638aff1bad38c4038b7356350c75d898f936",
};
const LEGACY_SPINE_SIZE: Readonly<Record<SpineFile, number>> = {
	"spine.md": 2714,
	"spine.worker.md": 1436,
};

export interface SpineLegacySelection {
	supervisor: boolean;
	worker: boolean;
}

export interface SpineLegacyResult {
	/** Exact pristine v1.8.0 user files. Callers may skip these as resolution candidates. */
	legacy: string[];
	warnings: string[];
}

/** The small portion of `fs.Stats` needed to reject links and revalidate an opened file. */
export interface SpineLegacyStat {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
	isFile(): boolean;
}

/** Per-activation filesystem seam. Production leaves it empty; tests can prove rejected files are
 *  never opened/read and that the content read is bounded without replacing process-wide `node:fs`. */
export interface SpineLegacyIO {
	lstat?: (path: string) => SpineLegacyStat;
	open?: (path: string) => number;
	fstat?: (fd: number) => SpineLegacyStat;
	/** Read at most `maxBytes` from offset zero. */
	read?: (fd: number, maxBytes: number) => Buffer;
	close?: (fd: number) => void;
}

export interface SeedResult {
	/** Absolute paths written. */
	copied: string[];
	/** Absolute paths left untouched (already existed, or a persona owned a colliding name). */
	skipped: string[];
	/** Basenames present in both bundled persona and agent sources; the persona wins seeding. */
	collisions?: string[];
	/** Per-file failures (a destination locked by an editor/AV on Windows, EACCES…). One bad
	 *  file must not abort the whole seed: the rest still lands and each failure is named. */
	warnings?: string[];
}

/** Exact bytes from earlier releases whose seeded copies are known to be stale. A user file is
 * eligible only when BOTH size and digest match. Keep this explicit allow-list deliberately
 * small: it is a migration policy, not a fuzzy upgrader. */
export interface SeededDefaultSpec {
	size: number;
	sha256: string;
	/** Bundled agent files that must exist before this parent default may be migrated. */
	requiredAdditions?: readonly string[];
}

/** One seeded asset can have several known-pristine historical byte sequences. */
export type SeededDefaultEntry = SeededDefaultSpec | readonly SeededDefaultSpec[];

const ELITE_REQUIRED_ADDITIONS = ["agents/evidence-verifier.md"] as const;

export const LEGACY_SEEDED_DEFAULTS: Readonly<Record<string, SeededDefaultEntry>> = {
	"personas/dev.md": [
		{ size: 3985, sha256: "fb02263d97c53d6c10b6089c9c65ae7fad27a77c28434b5c892dbb87dd285e5b" },
		// v1.10.5–v1.12.0
		{ size: 5194, sha256: "0899ee3b10971c2b324e9e9c868fcab833ea80a80b83d94a1f0a95147475e9b5" },
		// v1.12.1
		{ size: 5195, sha256: "54da40a44a777f8a3b36b6c038248116e19be5a6515707747d070dc3f32ead56" },
	],
	// The MAGI cores gained `purpose:` (their verticalization) in v1.10.6. Agents are seeded COPIES,
	// not a live layer read from the package, so without these an existing install keeps three cores
	// that render as bare names — the label feature would ship inert for everyone who already has them.
	"agents/melchior.md": { size: 1503, sha256: "aa7a69296640f1023e00e2f2285b12cfdee158bb89f7b0b3d8c03a6317de9508" },
	"agents/balthasar.md": { size: 1527, sha256: "27273ed49ea265f528efad4724e6abec6d051fa60d1f4fa678982e7383364981" },
	"agents/casper.md": { size: 1508, sha256: "5074341b7e1ae7e9a44bc71de0405a17ccb404eacfaeb2fcf40f2ac4c23828ea" },
	"personas/elite.md": [
		{
			// v1.0.0
			size: 10489,
			sha256: "a898364924b2f8fd2a60e8bd170650bc851c972f330f51f351be7390986629de",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.1.0
			size: 10325,
			sha256: "c3d9f969ad31bb6ecb2fef5ccc9e30fc88bfd8a215a865b91c66496976af78aa",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.2.0–v1.3.0
			size: 11162,
			sha256: "df2b01eed543eee7064006611e84c08e9c01498d7d18b37b1cd596bf604801ed",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.4.0
			size: 12001,
			sha256: "2aca09540abadfaebe4cd52a0803b31694406b9a5795419c43a52a92d53068c9",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.5.1–v1.5.2
			size: 12043,
			sha256: "a37f8130c04ab404101a36a145dcf5c27f91e5204562af15addd592849113ec7",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.6.0–v1.6.1
			size: 12739,
			sha256: "e688c82b41f8a6d0040c9c9523e7c109c2e3585194af1b43b99b8629be339eda",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.6.2–v1.6.3
			size: 13994,
			sha256: "3e1e841da9ddb0c478cbe5e3238fbf17ea032b07c03f319da5b45a1b1add59b2",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.7.0–v1.8.1
			size: 15970,
			sha256: "073f3c05f134df5d5daf8cd05df51dc15916300977a19d8b6dda3c8dd36abd1c",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.9.0–v1.10.5: migrate only untouched copies to the current hardened prompt.
			size: 16521,
			sha256: "e0ab767934b62e25e712ec31ebbc97dc780dff93d2e3855181f8bbe0086a4940",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.11.0–v1.12.1
			size: 18267,
			sha256: "dbe4a4da34338e4210b5abf9a902b4c56bba31eced1f00eb775e30b25ee37b90",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
	],
	// Live-peer collaboration landed in v1.12.2. Without these, a seeded copy from 1.7–1.12.1
	// (and the two earlier untouched hashes) keeps the pre-collaboration prompt forever.
	"personas/swarm.md": [
		{ size: 1857, sha256: "77de7f590fdede6ede4848be11b39fb16bfb4733687ac1b1244cc59e626874c6" }, // v1.1.0–v1.4.0
		{ size: 1955, sha256: "b7a7caa38c4d31c8cc27b85eb7facbf2339a024ad8d4cd2ba681a2a885de7646" }, // v1.5.1–v1.6.3
		{ size: 2285, sha256: "985a1c5455b2c81537a55b31daed216d7f67a897b3b2d5bde35d64f3779d6fe4" }, // v1.7.0–v1.12.1
	],
};

export interface SeedMigrationResult {
	/** Absolute user paths upgraded from an exact, known-pristine old default. */
	migrated: string[];
	/** Absolute user paths installed as required additions during an eligible migration. */
	installed: string[];
	/** Absolute user paths intentionally left alone (edited, unknown, absent, or unchanged). */
	skipped: string[];
	/** Absolute paths that could not be inspected or replaced safely. */
	warnings: string[];
}

export interface SeedMigrationOptions {
	/** Override the built-in allow-list in tests or for a future explicitly supported release. */
	legacyDefaults?: Readonly<Record<string, SeededDefaultEntry>>;
	/** Filesystem seams for bounded inspection and no-clobber replacement tests. */
	io?: SeedMigrationIO;
	/** Test-only race hook, called after the old target is moved to backup and before install. */
	beforeInstall?: (target: string, backup: string, staged: string) => void;
	/** Test seam for making the random staging suffix deterministic. Production uses randomUUID. */
	idFactory?: () => string;
}

export interface SeedMigrationIO extends SpineLegacyIO {
	copyFile?: (from: string, to: string, flags?: number) => void;
	link?: (from: string, to: string) => void;
	rename?: (from: string, to: string) => void;
	remove?: (path: string) => void;
}

function listByExt(dir: string, ext: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
	} catch {
		return []; // a bundled asset folder may be absent — that is fine
	}
}

interface ResolvedSpineLegacyIO {
	lstat(path: string): SpineLegacyStat;
	open(path: string): number;
	fstat(fd: number): SpineLegacyStat;
	read(fd: number, maxBytes: number): Buffer;
	close(fd: number): void;
}

/** Read through a descriptor into a fixed allocation. A file that grows after `fstat` can fill at
 * most expected-size + one byte, which is enough to reject it without ever loading the growth. */
function readBounded(fd: number, maxBytes: number): Buffer {
	const buffer = Buffer.alloc(maxBytes);
	let offset = 0;
	while (offset < maxBytes) {
		const read = readSync(fd, buffer, offset, maxBytes - offset, offset);
		if (read === 0) break;
		offset += read;
	}
	return buffer.subarray(0, offset);
}

function resolveLegacyIO(io: SpineLegacyIO): ResolvedSpineLegacyIO {
	return {
		lstat: io.lstat ?? lstatSync,
		open: io.open ?? ((path) => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))),
		fstat: io.fstat ?? fstatSync,
		read: io.read ?? readBounded,
		close: io.close ?? closeSync,
	};
}

interface SpineFingerprint {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
}

type Inspection =
	| { kind: "legacy" }
	| { kind: "skip" }
	| { kind: "warning"; detail: string };

function fingerprint(stat: SpineLegacyStat): SpineFingerprint {
	return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

function sameFingerprint(left: SpineFingerprint, right: SpineFingerprint): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size;
}

function safeLegacyShape(stat: SpineLegacyStat, expectedSize: number): boolean {
	return stat.isFile() && stat.nlink === 1 && stat.size === expectedSize;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Inspect through an opened descriptor. The user-controlled path is never read until both lstat
 *  and fstat establish a single-link regular file of the exact known legacy size. */
function inspectLegacy(path: string, file: SpineFile, io: ResolvedSpineLegacyIO): Inspection {
	let before: SpineLegacyStat;
	try {
		before = io.lstat(path);
	} catch {
		return { kind: "skip" };
	}
	if (!safeLegacyShape(before, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };

	let fd: number;
	try {
		fd = io.open(path);
	} catch (error) {
		return { kind: "warning", detail: `open failed: ${errorText(error)}` };
	}
	try {
		const opened = io.fstat(fd);
		if (!safeLegacyShape(opened, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(before), fingerprint(opened))) return { kind: "skip" };
		const bytes = io.read(fd, LEGACY_SPINE_SIZE[file] + 1);
		if (bytes.byteLength !== LEGACY_SPINE_SIZE[file]) return { kind: "skip" };
		const after = io.fstat(fd);
		if (!safeLegacyShape(after, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(opened), fingerprint(after))) return { kind: "skip" };
		if (createHash("sha256").update(bytes).digest("hex") !== LEGACY_SPINE_SHA256[file]) return { kind: "skip" };
		return { kind: "legacy" };
	} catch (error) {
		return { kind: "warning", detail: `inspection failed: ${errorText(error)}` };
	} finally {
		try {
			io.close(fd);
		} catch {
			// The descriptor has no further use; a close error cannot change the classification.
		}
	}
}

/** Find exact, pristine v1.8.0 seeded spine files already present in `userDir` without writing.
 * The extension uses the result to fall through to the current bundled prompt for selector `on`.
 * `/persona restore` remains the explicit, user-authorized operation that updates bytes on disk. */
export function inspectLegacySeededSpines(
	userDir: string,
	selection: SpineLegacySelection,
	ioOverrides: SpineLegacyIO = {},
): SpineLegacyResult {
	const result: SpineLegacyResult = { legacy: [], warnings: [] };
	const io = resolveLegacyIO(ioOverrides);
	for (const file of SPINE_FILES) {
		if (file === "spine.md" ? !selection.supervisor : !selection.worker) continue;
		const path = join(userDir, file);
		const inspection = inspectLegacy(path, file, io);
		if (inspection.kind === "legacy") result.legacy.push(path);
		else if (inspection.kind === "warning") result.warnings.push(`spine legacy inspection warning: ${path}: ${inspection.detail}`);
	}
	return result;
}

type SeedInspection =
	| { kind: "legacy"; fingerprint: SpineFingerprint; spec: SeededDefaultSpec }
	| { kind: "skip" }
	| { kind: "warning"; detail: string };

interface ResolvedSeedMigrationIO extends ResolvedSpineLegacyIO {
	copyFile(from: string, to: string, flags?: number): void;
	link(from: string, to: string): void;
	rename(from: string, to: string): void;
	remove(path: string): void;
}

function resolveSeedMigrationIO(io: SeedMigrationIO): ResolvedSeedMigrationIO {
	return {
		...resolveLegacyIO(io),
		copyFile: io.copyFile ?? copyFileSync,
		link: io.link ?? linkSync,
		rename: io.rename ?? renameSync,
		remove: io.remove ?? ((path) => rmSync(path, { force: true })),
	};
}

function seededDefaultSpecs(entry: SeededDefaultEntry): readonly SeededDefaultSpec[] {
	return Array.isArray(entry) ? entry : [entry as SeededDefaultSpec];
}

/** Inspect one explicitly allowlisted target through a bounded descriptor. Unrelated user files
 * never enter this function: the migration loop is keyed only by the explicit allow-list. Multiple
 * historical digests of the same size share one bounded read. */
function inspectPristineSeededDefault(path: string, entry: SeededDefaultEntry, io: ResolvedSpineLegacyIO): SeedInspection {
	let before: SpineLegacyStat;
	try {
		before = io.lstat(path);
	} catch {
		return { kind: "skip" };
	}
	const candidates = seededDefaultSpecs(entry).filter((spec) => safeLegacyShape(before, spec.size));
	const expectedSize = candidates[0]?.size;
	if (expectedSize === undefined) return { kind: "skip" };
	let fd: number;
	try {
		fd = io.open(path);
	} catch (error) {
		return { kind: "warning", detail: `open failed: ${errorText(error)}` };
	}
	try {
		const opened = io.fstat(fd);
		if (!safeLegacyShape(opened, expectedSize) || !sameFingerprint(fingerprint(before), fingerprint(opened))) return { kind: "skip" };
		const bytes = io.read(fd, expectedSize + 1);
		const after = io.fstat(fd);
		if (!safeLegacyShape(after, expectedSize) || !sameFingerprint(fingerprint(opened), fingerprint(after))) return { kind: "skip" };
		// The sentinel byte rejects growth without ever hashing/retaining unbounded user data.
		if (bytes.byteLength !== expectedSize) return { kind: "skip" };
		const digest = createHash("sha256").update(bytes).digest("hex");
		const matched = candidates.find((spec) => spec.sha256 === digest);
		if (!matched) return { kind: "skip" };
		return { kind: "legacy", fingerprint: fingerprint(after), spec: matched };
	} catch (error) {
		return { kind: "warning", detail: `inspection failed: ${errorText(error)}` };
	} finally {
		try {
			io.close(fd);
		} catch {
			// A descriptor close failure cannot make an inspected file safe to replace.
		}
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function restoreBackupIfTargetMissing(target: string, backup: string, io: ResolvedSeedMigrationIO): boolean {
	try {
		io.lstat(target);
		return false;
	} catch (error) {
		if (!isMissing(error)) return false;
	}
	try {
		io.rename(backup, target);
		return true;
	} catch {
		return false;
	}
}

type AdditionInstallResult = { kind: "installed" | "present" } | { kind: "failed"; detail: string };

function userAgentTarget(userDir: string, relative: string): string | undefined {
	const normalized = relative.replaceAll("\\", "/");
	if (!normalized.startsWith("agents/") || normalized.includes("/../") || normalized.endsWith("/..") || normalized.includes("/./")) return undefined;
	const name = normalized.slice("agents/".length);
	if (!name || name.includes("/")) return undefined;
	return join(userDir, "agents", name);
}

function installMissingAddition(
	source: string,
	target: string,
	io: ResolvedSeedMigrationIO,
	idFactory: () => string,
): AdditionInstallResult {
	try {
		io.lstat(target);
		return { kind: "present" };
	} catch (error) {
		if (!isMissing(error)) return { kind: "failed", detail: `target inspection failed: ${errorText(error)}` };
	}
	const staged = `${target}.pi-persona-migrate-${process.pid}-${idFactory()}.tmp`;
	let stagedOwned = false;
	try {
		try {
			io.copyFile(source, staged, constants.COPYFILE_EXCL);
			stagedOwned = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "failed", detail: `staging path already exists; preserved: ${staged}` };
			return { kind: "failed", detail: `staging failed: ${errorText(error)}` };
		}
		try {
			io.link(staged, target);
			return { kind: "installed" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "present" };
			return { kind: "failed", detail: `install failed: ${errorText(error)}` };
		}
	} finally {
		if (stagedOwned) {
			try {
				io.remove(staged);
			} catch {
				// The addition is already linked; a stale temp is recoverable and diagnosed by parent.
			}
		}
	}
}

/**
 * Upgrade bundled persona/agent files whose user copy is byte-for-byte one of the explicitly
 * known pristine defaults from an older release. This operation is intentionally separate from
 * {@link seedDefaults}: normal seeding preserves every existing file, while activation may call
 * this function once to pick up a security/behavioral default without overwriting user work.
 *
 * The target is checked as a single-link regular file before and after reading, and is checked
 * once more immediately before replacement. A changed file, symlink, hard-link, missing asset,
 * or replacement error is skipped/reported rather than overwritten. The result is suitable for
 * `/doctor` and activation diagnostics; this function never throws for a per-file race.
 */
export function migratePristineSeededDefaults(
	bundledDir: string,
	userDir: string,
	options: SeedMigrationOptions = {},
): SeedMigrationResult {
	const migrated: string[] = [];
	const installed: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const legacyDefaults = options.legacyDefaults ?? LEGACY_SEEDED_DEFAULTS;
	const io = resolveSeedMigrationIO(options.io ?? {});
	const idFactory = options.idFactory ?? randomUUID;
	for (const [relative, entry] of Object.entries(legacyDefaults)) {
		const source = join(bundledDir, relative);
		const name = relative.replace(/^.*[\\/]/, "");
		const target = join(userDir, "agents", name);
		if (!existsSync(source)) {
			skipped.push(target);
			continue;
		}
		const inspection = inspectPristineSeededDefault(target, entry, io);
		if (inspection.kind === "warning") {
			warnings.push(`seed migration inspection warning: ${target}: ${inspection.detail}`);
			continue;
		}
		if (inspection.kind !== "legacy") {
			skipped.push(target);
			continue;
		}
		const spec = inspection.spec;
		let additionsReady = true;
		for (const addition of spec.requiredAdditions ?? []) {
			const additionTarget = userAgentTarget(userDir, addition);
			if (!additionTarget) {
				warnings.push(`seed migration required addition is invalid: ${addition}`);
				additionsReady = false;
				break;
			}
			const additionSource = join(bundledDir, addition);
			if (!existsSync(additionSource)) {
				warnings.push(`seed migration required addition missing from bundle: ${additionSource}`);
				additionsReady = false;
				break;
			}
			const additionResult = installMissingAddition(additionSource, additionTarget, io, idFactory);
			if (additionResult.kind === "failed") {
				warnings.push(`seed migration required addition failed for ${target}: ${additionResult.detail}`);
				additionsReady = false;
				break;
			}
			if (additionResult.kind === "installed") installed.push(additionTarget);
		}
		if (!additionsReady) {
			skipped.push(target);
			continue;
		}
		const suffix = `${process.pid}-${idFactory()}`;
		const staged = `${target}.pi-persona-migrate-${suffix}.tmp`;
		const backup = `${target}.pi-persona-migrate-${suffix}.bak`;
		let stagedOwned = false;
		try {
			// Stage the trusted bundled bytes beside the target with exclusive creation. A stale
			// temp from a crashed prior run is never followed, overwritten, or removed by us.
			try {
				io.copyFile(source, staged, constants.COPYFILE_EXCL);
				stagedOwned = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					warnings.push(`seed migration staging path already exists; preserved: ${staged}`);
					skipped.push(target);
					continue;
				}
				throw error;
			}
			let current: SpineLegacyStat;
			try {
				current = io.lstat(target);
			} catch {
				skipped.push(target);
				continue;
			}
			if (!safeLegacyShape(current, spec.size) || !sameFingerprint(inspection.fingerprint, fingerprint(current))) {
				skipped.push(target);
				continue;
			}
			// Move the old inode to a recoverable backup. Installing with a hard-link below makes
			// target creation atomic-visible and no-clobber: a concurrent writer that claims the
			// path causes link() to fail with EEXIST rather than replacing its bytes. Both paths
			// are siblings, so this is same-volume on POSIX and Windows/NTFS alike.
			io.rename(target, backup);
			const backupInspection = inspectPristineSeededDefault(backup, spec, io);
			if (backupInspection.kind !== "legacy") {
				if (!restoreBackupIfTargetMissing(target, backup, io)) warnings.push(`seed migration backup preserved: ${backup}`);
				warnings.push(`seed migration target changed before replacement: ${target}`);
				skipped.push(target);
				continue;
			}
			options.beforeInstall?.(target, backup, staged);
			try {
				io.link(staged, target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					// A concurrent custom edit won the path. Leave it untouched and discard only
					// the old known-pristine backup.
					io.remove(backup);
					warnings.push(`seed migration target changed during migration; preserved: ${target}`);
					skipped.push(target);
					continue;
				}
				if (!restoreBackupIfTargetMissing(target, backup, io)) warnings.push(`seed migration backup preserved: ${backup}`);
				throw error;
			}
			io.remove(backup);
			migrated.push(target);
		} catch (error) {
			warnings.push(`seed migration replacement warning: ${target}: ${errorText(error)}`);
		} finally {
			if (stagedOwned) {
				try {
					io.remove(staged);
				} catch {
					warnings.push(`seed migration temporary file remains: ${staged}`);
				}
			}
		}
	}
	return { migrated, installed, skipped, warnings };
}

/** Copy the bundled defaults under `bundledDir` into `userDir`. Returns what changed. */
export function seedDefaults(bundledDir: string, userDir: string, force: boolean): SeedResult {
	const copied: string[] = [];
	const skipped: string[] = [];
	const collisions: string[] = [];
	const warnings: string[] = [];
	const place = (src: string, dst: string): void => {
		// Per-file fault isolation, same posture as the migration path below: a locked or
		// unreadable destination is a warning, never an abort of the remaining defaults.
		try {
			placeFile(src, dst);
		} catch (error) {
			warnings.push(`${dst}: ${errorText(error)}`);
		}
	};
	const placeFile = (src: string, dst: string): void => {
		mkdirSync(dirname(dst), { recursive: true });
		if (!force) {
			// `existsSync` follows symlinks and leaves a TOCTOU window. Inspect the directory entry,
			// then still use exclusive creation so an editor/process that wins the race is preserved.
			try {
				lstatSync(dst);
				skipped.push(dst);
				return;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			try {
				copyFileSync(src, dst, constants.COPYFILE_EXCL);
				copied.push(dst);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				skipped.push(dst);
			}
			return;
		}

		// Restore is explicitly destructive for THIS directory entry, but must never write through
		// a user symlink/hard-link. Stage complete bytes beside it and atomically replace the entry;
		// readers see either old or new content, and another link to the old inode stays untouched.
		const staged = `${dst}.pi-persona-restore-${process.pid}-${randomUUID()}.tmp`;
		let stagedOwned = false;
		try {
			copyFileSync(src, staged, constants.COPYFILE_EXCL);
			stagedOwned = true;
			renameSync(staged, dst);
			stagedOwned = false;
			copied.push(dst);
		} finally {
			if (stagedOwned) rmSync(staged, { force: true });
		}
	};

	// Personas + agents share <user>/agents. Seed personas first so a colliding basename has one
	// deterministic on-disk owner; seedDefaults returns the collision names for diagnostics.
	const personaFiles = listByExt(join(bundledDir, "personas"), ".md");
	const ownedByPersona = new Set(personaFiles);
	for (const f of personaFiles) place(join(bundledDir, "personas", f), join(userDir, "agents", f));
	for (const f of listByExt(join(bundledDir, "agents"), ".md")) {
		if (ownedByPersona.has(f)) {
			collisions.push(f.slice(0, -3));
			skipped.push(join(userDir, "agents", f));
			continue;
		}
		place(join(bundledDir, "agents", f), join(userDir, "agents", f));
	}

	// flows / contracts / presets → their own user dirs.
	for (const [sub, ext] of [
		["flows", ".flow.json"],
		["contracts", ".contract.json"],
		["presets", ".preset.json"],
	] as const) {
		for (const f of listByExt(join(bundledDir, sub), ext)) place(join(bundledDir, sub, f), join(userDir, sub, f));
	}

	// The spine pair (docs/SPINE.md) — bundled under `prompts/`, seeded FLAT into the data dir,
	// because that is where `PI_PERSONA_SPINE=on` looks for the user's own copy. Without this the
	// documented "your own copy shadows the bundled one" precedence has no gesture that creates
	// the copy, and a user would have to know the two filenames and write them by hand.
	for (const f of SPINE_FILES) {
		const src = join(bundledDir, "prompts", f);
		const dst = join(userDir, f);
		if (existsSync(src)) place(src, dst);
	}

	// teams.yaml — a single merged file.
	const teamsSrc = join(bundledDir, "teams.yaml");
	if (existsSync(teamsSrc)) place(teamsSrc, join(userDir, "teams.yaml"));

	return { copied, skipped, ...(collisions.length > 0 ? { collisions } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
}

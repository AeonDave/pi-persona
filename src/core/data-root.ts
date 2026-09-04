/**
 * One-time relocation of the plugin's storage root inside the Pi agent dir.
 *
 * `pi-persona` is the npm PACKAGE name; the directory a user's data lives in is `persona` (the
 * same root `personaDataDir()` has always used for agents/config/state). Exocom and the POSIX
 * broker socket wrote their files under a second, package-named directory, so an install ended up
 * with `~/.pi/agent/pi-persona` next to `~/.pi/agent/persona` — two roots for one plugin. Moving
 * those writers is a one-line change; carrying the existing files across is this module.
 *
 * What is actually at stake is small but not reconstructible: registry entries are heartbeat-scoped
 * and a restarted Pi rewrites them, but `exocom/codes/` holds the durable cross-workspace join
 * aliases (and their `.used` reservations), which exist nowhere else.
 *
 * The migration therefore behaves like a careful merge rather than a rename:
 *   - it never overwrites a name the current root already has (the destination copy wins),
 *   - it never removes a source it did not successfully place at the destination,
 *   - each file is placed by hard-link-then-unlink, so an interruption leaves the bytes reachable
 *     under BOTH names and the next run finishes the move instead of losing it,
 *   - every failure is a per-entry warning, so one locked file cannot abort the rest — or, since
 *     this runs during activation, take the session down with it.
 *
 * Pure over node:fs (no Pi imports), so the whole policy is unit-tested against temp dirs.
 */

import { constants, copyFileSync, type Dirent, linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The package-named root written by ≤1.13.1, and the one root everything uses now. */
const LEGACY_ROOT = "pi-persona";
const CURRENT_ROOT = "persona";
/** The legacy tree is at most `exocom/codes/.used/<file>` deep. The cap is a backstop against a
 *  surprising tree, not an expected shape — nothing here follows a link, so it cannot loop. */
const MAX_DEPTH = 8;

export interface DataRootMigrationResult {
	/** Absolute paths under the current root now holding what the legacy root held. */
	moved: string[];
	/** Absolute legacy paths deliberately left alone: the current root already owns that name, or
	 *  the entry is not a regular file (a link, or a live/stale broker socket). */
	kept: string[];
	warnings: string[];
}

/** Per-call filesystem seam. Production leaves it empty; a test can prove the copy fallback that a
 *  filesystem without hard links (exFAT, some network mounts) takes without one. */
export interface DataRootMigrationIO {
	link?: (from: string, to: string) => void;
}

export interface DataRootMigrationOptions {
	io?: DataRootMigrationIO;
}

type ResolvedIO = Required<DataRootMigrationIO>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** True only when both names are the SAME regular file — i.e. our own link() landed and the
 *  unlink() after it did not. Deliberately conservative: a filesystem that reports no inode or no
 *  extra link answers false, and the caller then keeps both copies. Guessing wrong in the other
 *  direction would delete a user file that was never copied. */
function isSameFile(source: string, target: string): boolean {
	try {
		const from = lstatSync(source);
		const to = lstatSync(target);
		return from.isFile() && to.isFile() && from.ino !== 0 && from.nlink > 1 && from.dev === to.dev && from.ino === to.ino;
	} catch {
		return false;
	}
}

/** Place `source` at `target` without clobbering, for a filesystem that has no hard links. */
function copyAcross(source: string, target: string, result: DataRootMigrationResult): boolean {
	try {
		copyFileSync(source, target, constants.COPYFILE_EXCL);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			result.kept.push(source);
			return false;
		}
		if (isMissing(error)) return false; // another migrator moved it out from under us
		result.warnings.push(`data root migration could not copy ${source}: ${errorText(error)}`);
		return false;
	}
}

function moveFile(source: string, target: string, io: ResolvedIO, result: DataRootMigrationResult): void {
	try {
		// link() is atomic and no-clobber: a concurrent writer that already owns the destination
		// name fails us with EEXIST rather than having its bytes replaced.
		io.link(source, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return; // a concurrent migrator already moved this entry
		if (code === "EEXIST") {
			if (!isSameFile(source, target)) {
				result.kept.push(source);
				return;
			}
			// Same inode: finish the interrupted move below instead of stranding the legacy name.
		} else if (!copyAcross(source, target, result)) {
			return;
		}
	}
	try {
		unlinkSync(source);
	} catch (error) {
		if (!isMissing(error)) {
			// The bytes ARE at the destination, so this is not data loss — but the legacy root will
			// survive this run, and the next one completes it via the same-inode branch above.
			result.warnings.push(`data root migration placed ${target} but could not remove ${source}: ${errorText(error)}`);
			return;
		}
	}
	result.moved.push(target);
}

function mergeDirectory(from: string, to: string, depth: number, io: ResolvedIO, result: DataRootMigrationResult): void {
	if (depth > MAX_DEPTH) {
		result.warnings.push(`data root migration stopped at an unexpectedly deep path: ${from}`);
		return;
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(from, { withFileTypes: true });
	} catch (error) {
		if (!isMissing(error)) result.warnings.push(`data root migration could not read ${from}: ${errorText(error)}`);
		return;
	}
	if (entries.length === 0) return; // nothing to place; the caller removes the empty directory
	try {
		mkdirSync(to, { recursive: true, mode: 0o700 });
	} catch (error) {
		result.warnings.push(`data root migration could not create ${to}: ${errorText(error)}`);
		return;
	}
	for (const entry of entries) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		// Dirents carry lstat semantics, so a symlinked directory is NOT a directory here and falls
		// to the non-regular branch below with everything else we refuse to follow.
		if (entry.isDirectory()) {
			mergeDirectory(source, target, depth + 1, io, result);
			try {
				rmdirSync(source);
			} catch {
				// Non-empty (it still holds entries we kept) or already gone. Either way it is not
				// ours to force: rmdir is the only removal here that can never take user data.
			}
			continue;
		}
		if (!entry.isFile()) {
			// A POSIX broker socket is a runtime rendezvous artifact, not user data: it cannot be
			// copied, and the new endpoint path is derived fresh on the next session. Leave it, and
			// leave anything else exotic, exactly where it is.
			result.kept.push(source);
			continue;
		}
		moveFile(source, target, io, result);
	}
}

/**
 * Merge `<agentDir>/pi-persona` into `<agentDir>/persona`, then remove the legacy root once it is
 * empty. A missing legacy root (a fresh install, or an install already migrated) is a no-op, so
 * this is safe to call on every activation, from several Pi processes at once, and to interrupt.
 * It never throws for a per-entry race or failure — the caller reports {@link
 * DataRootMigrationResult.warnings} instead of losing the session to them.
 */
export function migrateLegacyDataRoot(agentDir: string, options: DataRootMigrationOptions = {}): DataRootMigrationResult {
	const io: ResolvedIO = { link: options.io?.link ?? linkSync };
	const legacy = join(agentDir, LEGACY_ROOT);
	const result: DataRootMigrationResult = { moved: [], kept: [], warnings: [] };
	let root;
	try {
		root = lstatSync(legacy);
	} catch (error) {
		if (!isMissing(error)) result.warnings.push(`data root migration could not inspect ${legacy}: ${errorText(error)}`);
		return result;
	}
	if (!root.isDirectory() || root.isSymbolicLink()) {
		result.warnings.push(`data root migration left an unexpected ${legacy} untouched`);
		return result;
	}
	mergeDirectory(legacy, join(agentDir, CURRENT_ROOT), 0, io, result);
	try {
		// The point of the whole exercise: the agent dir ends with one directory per plugin. rmdir
		// only succeeds on the empty root, so a kept collision preserves it (and this run's report).
		rmdirSync(legacy);
	} catch {
		// Still holds entries we deliberately kept, or another process removed it first.
	}
	return result;
}

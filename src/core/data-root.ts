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
 *   - it places nothing THROUGH a link below the current root, so a planted (or stale) junction
 *     cannot carry the tree out of the agent dir — the root itself is exempt, since that is the
 *     link `personaDataDir()` and every other writer already follow,
 *   - each file is placed by hard-link-then-unlink, so an INTERRUPTION leaves the bytes reachable
 *     under BOTH names and the next run finishes the move instead of losing it; an OBSERVED unlink
 *     failure is different — this run undoes the link it just made, because exocom reads `nlink > 1`
 *     as tampering, and it never undoes a placement an earlier run completed,
 *   - every failure is a per-entry warning, so one locked file cannot abort the rest — or, since
 *     this runs during activation, take the session down with it.
 *
 * Pure over node:fs (no Pi imports), so the whole policy is unit-tested against temp dirs.
 */

import { constants, copyFileSync, type Dirent, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
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
	/** Absolute legacy paths deliberately left alone: the current root already owns that name, the
	 *  entry is not a regular file (a link, or a live/stale broker socket), or a foreign handle held
	 *  the source open so this run undid its own placement rather than leave a second name behind. */
	kept: string[];
	warnings: string[];
}

/** Per-call filesystem seam. Production leaves it empty; a test can prove the copy fallback that a
 *  filesystem without hard links (exFAT, some network mounts) takes without one, and the removal
 *  failures (a foreign handle, a peer racing us for the same name) that only a loaded host hits. */
export interface DataRootMigrationIO {
	link?: (from: string, to: string) => void;
	unlink?: (path: string) => void;
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

/** Destination-side counterpart to the Dirent lstat semantics used on the source: a link is never a
 *  directory we place anything into. Same rule as `ensureDirectory` in exocom/codes.ts. */
function isRealDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
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
			// Only a source still on disk is a name we are keeping; a peer that completed this move
			// left nothing here, and reported the entry itself.
			if (existsSync(source)) result.kept.push(source);
			return false;
		}
		if (isMissing(error)) return false; // another migrator moved it out from under us
		result.warnings.push(`data root migration could not copy ${source}: ${errorText(error)}`);
		return false;
	}
}

/** The source outlived the placement that should have consumed it — a foreign handle holds it open
 *  (EBUSY/EPERM). Keeping both names is worse than doing nothing for the very files this migration
 *  exists to carry: exocom reads `nlink > 1` as tampering and refuses the ledger outright (see
 *  `assertSafeStat` in exocom/ledger.ts), so a "harmless" second name silently disables it. Undo the
 *  link we just made — provably ours, because it is the same inode — and report the entry as
 *  untouched, leaving the exact pre-run state for the next run to retry. A copy is a distinct file
 *  the destination can use on its own, so that one stays and the next run resolves the pair. */
function unwindPlacement(source: string, target: string, reason: string, io: ResolvedIO, result: DataRootMigrationResult): void {
	// Callers must only reach here for a link THIS call created; see `placedNow` in `moveFile`.
	if (isSameFile(source, target)) {
		try {
			io.unlink(target);
			result.kept.push(source);
			result.warnings.push(`data root migration left ${source} in place: ${reason}`);
		} catch {
			result.warnings.push(`data root migration placed ${target} but could not remove ${source}: ${reason} — ${target} is unusable to exocom until ${source} is removed`);
		}
		return;
	}
	result.warnings.push(`data root migration placed ${target} but could not remove ${source}: ${reason}`);
}

function moveFile(source: string, target: string, io: ResolvedIO, result: DataRootMigrationResult): void {
	// Only a link THIS call created may be undone later: the EEXIST/same-inode branch below resumes a
	// placement an earlier run already completed, and unwinding that would destroy work that is done
	// and leave the destination empty.
	let placedNow = true;
	try {
		// link() is atomic and no-clobber: a concurrent writer that already owns the destination
		// name fails us with EEXIST rather than having its bytes replaced.
		io.link(source, target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return; // a concurrent migrator already moved this entry
		if (code === "EEXIST") {
			if (!isSameFile(source, target)) {
				// A collision only while the source is still there; otherwise a peer finished this move.
				if (existsSync(source)) result.kept.push(source);
				return;
			}
			// Same inode: finish the interrupted move below instead of stranding the legacy name.
			placedNow = false;
		} else if (!copyAcross(source, target, result)) {
			return;
		}
	}
	try {
		io.unlink(source);
	} catch (error) {
		// Two processes removing the same name hand the loser EPERM on Windows rather than ENOENT, so
		// the errno alone cannot tell "still here" from "a peer got there first" — but the source can,
		// and a source that is gone was migrated, not stranded.
		if (!isMissing(error) && existsSync(source)) {
			if (placedNow) unwindPlacement(source, target, errorText(error), io, result);
			else result.warnings.push(`data root migration could not remove ${source}: ${errorText(error)} — ${target} already holds it`);
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
	// mkdir SUCCEEDS on a name that is already a link to a directory, and every placement below
	// would then write THROUGH it — out of the agent dir — before unlinking the legacy original.
	// Depth 0 is the current root itself, where a link means the user relocated their data dir and
	// following it is correct: `personaDataDir()` and exocom/codes.ts follow that same link.
	if (depth > 0 && !isRealDirectory(to)) {
		result.warnings.push(`data root migration left ${from} untouched: ${to} is not a directory`);
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
	const io: ResolvedIO = { link: options.io?.link ?? linkSync, unlink: options.io?.unlink ?? unlinkSync };
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

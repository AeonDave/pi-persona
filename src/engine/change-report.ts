/**
 * Files-changed report for a NON-worktree leg. Claude Code and Codex tell the supervisor which
 * files a sub-agent touched; a worktree leg gets that from `captureWorktreeArtifact`'s unified
 * diff (engine.ts's `appendWorktreeArtifact`), but a leg without isolation runs in the SHARED
 * checkout — there is no private diff to export, only "what changed in `git status` while this
 * leg ran". That is inherently approximate (a parallel sibling can dirty the same files), so the
 * report says so plainly rather than reading like an authoritative per-leg diff.
 *
 * Pure over `GitExec` (see worktree.ts) so it is unit-tested without a real repository; the only
 * process boundary is `captureStatus`'s two `git` calls (rev-parse gate + porcelain status), gated
 * by `findGitRoot`'s synchronous filesystem walk so a cwd outside any repository never pays for
 * them at all.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { normalizeWritePath, pathsOverlap } from "../core/ownership.ts";
import type { GitExec } from "./worktree.ts";

/** path → 2-character porcelain status code (e.g. " M", "??", "A ", "R "). */
export interface StatusSnapshot {
	entries: Map<string, string>;
}

export interface ChangedPath {
	path: string;
	kind: "M" | "A" | "D" | "R" | "?" | "clean";
}

/** Bound how many changed paths are named in the report — a leg that rewrites hundreds of files
 *  (a codemod, a lockfile regen) must not flood the supervisor's context with every path. */
export const MAX_REPORTED_PATHS = 40;

function kindFromXY(xy: string): ChangedPath["kind"] {
	if (xy === "??") return "?";
	const x = xy[0];
	const y = xy[1];
	if (x === "A" || y === "A") return "A";
	if (x === "D" || y === "D") return "D";
	if (x === "R" || y === "R") return "R";
	return "M";
}

/** Parse `git status --porcelain=v1 -z` output. Each entry is `XY path\0`; a rename/copy
 *  (X or Y is `R`/`C`) carries an extra `\0`-terminated old-path field, which is consumed here
 *  and not itself recorded — only the new path is a "changed path" from the leg's point of view. */
export function parsePorcelainZ(stdout: string): StatusSnapshot {
	const entries = new Map<string, string>();
	const parts = stdout.split("\0");
	let i = 0;
	while (i < parts.length) {
		const entry = parts[i];
		i++;
		if (!entry) continue;
		const xy = entry.slice(0, 2);
		const path = entry.slice(3);
		entries.set(path, xy);
		if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++; // skip the old-path field
	}
	return { entries };
}

/** How many ancestor directories {@link findGitRoot} will check above `start` before giving up —
 *  generous for any real project nesting, but finite so a pathological path can't loop. */
const MAX_GIT_ROOT_ANCESTORS = 12;

/** Walk up from `start` looking for a `.git` entry (a directory for a normal checkout, a file for
 *  a submodule/worktree pointer) — what real `git -C <dir> ...` does internally when `<dir>` is a
 *  subdirectory of the repository. Reimplemented here as a synchronous, injectable `exists` check
 *  (default `existsSync`) so `captureStatus` can skip the real `git` round trip for a cwd that
 *  plainly isn't inside ANY repository, without missing one whose top level is merely an ANCESTOR
 *  of `start` — the common case of a Pi session started in a package subdirectory of a larger
 *  repo. `undefined` when no ancestor within {@link MAX_GIT_ROOT_ANCESTORS} has `.git`, or once the
 *  filesystem root is reached. Pure over the injected `exists`, so it is unit-tested without a
 *  filesystem. */
export function findGitRoot(start: string, exists: (p: string) => boolean = existsSync): string | undefined {
	let current = resolve(start);
	for (let i = 0; i < MAX_GIT_ROOT_ANCESTORS; i++) {
		if (exists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined; // reached the filesystem root
		current = parent;
	}
	return undefined;
}

/** `undefined` when `root` is not (inside) a Git repository or `git status` fails — never throws
 *  (mirrors `GitExec`'s own never-throw contract), so a leg without a repo, or one whose git is
 *  briefly unavailable, degrades to "no report" rather than breaking the leg it only observes.
 *
 *  Gated by {@link findGitRoot}: a cwd that plainly isn't inside any repository (within the walk's
 *  bound) never spawns a real `git` process — a genuine per-leg cost otherwise paid on every run
 *  outside a repository. The discovered repository top, not `root` itself, is passed to `git -C`
 *  below (the porcelain output is repo-relative either way).
 *
 *  `knownGitRoot` lets a caller that already resolved (and, via a PRIOR call to this function,
 *  vouched for) the repository root skip BOTH the filesystem walk and the `rev-parse` liveness
 *  gate — `withChangeReport`'s before/after pair shares one root, so only the FIRST capture needs
 *  to prove it; the second trusts that proof rather than re-spawning `rev-parse` for no new
 *  information. Omit it for the general case (an unresolved `root`, or a standalone caller with no
 *  prior proof), which keeps today's full discover-then-verify behavior unchanged. */
export async function captureStatus(root: string, exec: GitExec, knownGitRoot?: string): Promise<StatusSnapshot | undefined> {
	const gitRoot = knownGitRoot ?? findGitRoot(root);
	if (!gitRoot) return undefined;
	if (knownGitRoot === undefined) {
		const repo = await exec(["-C", gitRoot, "rev-parse", "--is-inside-work-tree"]);
		if (repo.code !== 0 || repo.stdout.trim().toLowerCase() !== "true") return undefined;
	}
	const status = await exec(["-C", gitRoot, "status", "--porcelain=v1", "--untracked-files=all", "-z"]);
	if (status.code !== 0) return undefined;
	return parsePorcelainZ(status.stdout);
}

/** Paths that appeared or changed status between the two snapshots, followed by paths that
 *  disappeared (resolved back to clean) — in that order; `renderChangeReport` sorts for display. */
export function diffStatus(before: StatusSnapshot, after: StatusSnapshot): ChangedPath[] {
	const changes: ChangedPath[] = [];
	for (const [path, xy] of after.entries) {
		if (before.entries.get(path) === xy) continue;
		changes.push({ path, kind: kindFromXY(xy) });
	}
	for (const [path] of before.entries) {
		if (!after.entries.has(path)) changes.push({ path, kind: "clean" });
	}
	return changes;
}

/** Render the block appended to a leg's output, or `undefined` when nothing changed (the caller
 *  must not tack an empty block onto an untouched result). `writeSet` is the leg's OWN declared
 *  ownership (from `delegate`'s `writeSet`); a changed path outside it is flagged — not blocked,
 *  since a shared checkout has no enforcement lever here, only a supervisor-visible warning. */
export function renderChangeReport(changes: ChangedPath[], writeSet?: readonly string[]): string | undefined {
	if (changes.length === 0) return undefined;
	const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));
	const owned = writeSet && writeSet.length > 0 ? writeSet.map(normalizeWritePath) : undefined;
	const lines = sorted.slice(0, MAX_REPORTED_PATHS).map((c) => {
		const outside = owned !== undefined && !owned.some((ws) => pathsOverlap(normalizeWritePath(c.path), ws));
		return `- ${c.path} (${c.kind})${outside ? " ⚠ outside declared writeSet" : ""}`;
	});
	if (sorted.length > MAX_REPORTED_PATHS) lines.push(`+${sorted.length - MAX_REPORTED_PATHS} more`);
	return ["--- FILES CHANGED DURING THIS LEG (shared checkout; parallel legs may overlap) ---", ...lines].join("\n");
}

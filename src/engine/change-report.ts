/**
 * Files-changed report for a NON-worktree leg. Claude Code and Codex tell the supervisor which
 * files a sub-agent touched; a worktree leg gets that from `captureWorktreeArtifact`'s unified
 * diff (engine.ts's `appendWorktreeArtifact`), but a leg without isolation runs in the SHARED
 * checkout — there is no private diff to export, only "what changed in `git status` while this
 * leg ran". That is inherently approximate (a parallel sibling can dirty the same files), so the
 * report says so plainly rather than reading like an authoritative per-leg diff.
 *
 * Pure over `GitExec` (see worktree.ts) so it is unit-tested without a real repository; the only
 * process boundary is `captureStatus`'s two `git` calls (rev-parse gate + porcelain status).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

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

/** `undefined` when `root` is not a Git repository or `git status` fails — never throws (mirrors
 *  `GitExec`'s own never-throw contract), so a leg without a repo, or one whose git is briefly
 *  unavailable, degrades to "no report" rather than breaking the leg it only observes.
 *
 *  Gated by a cheap, synchronous `.git` pre-check: a delegate leg's `root` is nearly always a
 *  scratch cwd or a real repository's TOP level (the same assumption `worktreePreflight` already
 *  makes), so skipping straight to "no report" when `.git` is plainly absent avoids spawning a
 *  real `git` process — a genuine per-leg cost — for every leg run outside a repository. The one
 *  case this under-reports is `root` being a repo reached only via an ancestor's `.git` (cwd nested
 *  below the repo top); accepted, since the report is best-effort by design. */
export async function captureStatus(root: string, exec: GitExec): Promise<StatusSnapshot | undefined> {
	if (!existsSync(join(root, ".git"))) return undefined;
	const repo = await exec(["-C", root, "rev-parse", "--is-inside-work-tree"]);
	if (repo.code !== 0 || repo.stdout.trim().toLowerCase() !== "true") return undefined;
	const status = await exec(["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"]);
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

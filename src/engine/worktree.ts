/**
 * Git worktree isolation — run a sub-agent in a throwaway `git worktree` so its file
 * edits / test runs never touch the main working tree (spec §6 `isolation: worktree`).
 * The worktree is detached at HEAD, used, then force-removed (the agent's experiments are
 * discarded — isolation, not persistence; the agent returns its findings as its result).
 *
 * Pure over an injected `GitExec` (so the lifecycle is unit-tested without a real repo);
 * the default exec shells out to `git` via Pi-agnostic `child_process` (cross-OS — git is
 * the same on Windows/POSIX). Only the child-process engine uses this (a worktree needs its
 * own cwd, i.e. a separate process).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitExec = (args: string[]) => { code: number; stdout: string; stderr: string };

/** Default git runner — `git <args>`, never throwing (returns the exit code). */
export const defaultGitExec: GitExec = (args) => {
	try {
		const stdout = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
};

/** Whether `root` is inside a git work tree (worktree isolation needs a repo). */
export function isGitRepo(root: string, exec: GitExec = defaultGitExec): boolean {
	return exec(["-C", root, "rev-parse", "--is-inside-work-tree"]).code === 0;
}

/** Create a detached worktree off `root`'s HEAD, run `body(worktreeDir)`, then force-remove it. */
export async function withWorktree<T>(root: string, exec: GitExec, body: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-persona-wt-"));
	const add = exec(["-C", root, "worktree", "add", "--detach", dir, "HEAD"]);
	if (add.code !== 0) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		throw new Error(`could not create git worktree: ${add.stderr.trim() || `git exited ${add.code}`}`);
	}
	try {
		return await body(dir);
	} finally {
		// Remove the worktree registration, then the dir (force: it may carry the agent's edits).
		exec(["-C", root, "worktree", "remove", "--force", dir]);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* the worktree remove usually handles it; ignore races */
		}
	}
}

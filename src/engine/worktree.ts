/**
 * Git worktree isolation — run a sub-agent in a throwaway `git worktree` so its file
 * edits / test runs never touch the main working tree (spec §6 `isolation: worktree`).
 * The worktree is detached at HEAD and removed after an export; a failed export or a thrown
 * worker retains it for recovery.
 *
 * Pure over an injected async `GitExec` (so the lifecycle is unit-tested without a real repo);
 * the default exec shells out to `git` via `child_process.execFile` — asynchronous, so the
 * extension host keeps rendering, ticking timers and serving broker sockets while a large
 * checkout is created or removed. Only the child-process engine uses this (a worktree needs
 * its own cwd, i.e. a separate process).
 */

import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorktreeRecovery, type WorktreeRecovery } from "../core/worktree-recovery.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitExec = (args: string[]) => Promise<GitResult>;

export type WorktreeArtifact =
	| { ok: true; diff: string }
	| { ok: false; error: string };

/** Bound the data copied from an isolated checkout into the supervisor context. */
export const MAX_WORKTREE_ARTIFACT_CHARS = 1_000_000;

/** Output buffer for one git invocation — comfortably above MAX_WORKTREE_ARTIFACT_CHARS so the
 *  size check below, not the OS pipe, is what rejects an oversized diff. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Exit 1 is valid for `git diff --no-index`; process failures must never look like it. */
export function gitFailureCode(error: { code?: unknown; signal?: unknown; killed?: unknown }): number {
	return !error.signal && !error.killed && typeof error.code === "number" ? error.code : -1;
}

/** Default git runner — `git <args>`, never throwing (returns the exit code). */
export const defaultGitExec: GitExec = (args) =>
	new Promise((resolveResult) => {
		execFile("git", args, { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
			if (!err) {
				resolveResult({ code: 0, stdout, stderr });
				return;
			}
			const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };
			const code = gitFailureCode(e);
			resolveResult({ code, stdout: stdout ?? "", stderr: stderr || e.message });
		});
	});

/** Why a git call failed, for an operator: the first line of its stderr (bounded), else its exit
 *  code; callers add their own `git` prefix. A broken git (for example an x86_64 process reaching arm64-only macOS Command Line Tools)
 *  exits non-zero just like a non-repository, so the message must carry git's own words. */
export function gitFailureCause(result: GitResult): string {
	const line = result.stderr.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line ? (line.length > 240 ? `${line.slice(0, 239)}…` : line) : `exited ${result.code}`;
}

/** The `/doctor` line for a `git --version` probe run the same way pi-persona runs git for real. */
export function gitDoctorLine(result: GitResult): string {
	return result.code === 0
		? `git: ${result.stdout.trim() || "available"}`
		: `git: UNUSABLE (${gitFailureCause(result)}) — worktree isolation, compete and change reports need a working git`;
}

/** The preflight gate for an isolated coding leg. Isolation is a safety boundary: a missing
 * repository or a dirty checkout is not permission to run against the real cwd. */
export async function worktreePreflight(root: string, exec: GitExec = defaultGitExec): Promise<{ ok: true } | { ok: false; error: string }> {
	const repo = await exec(["-C", root, "rev-parse", "--is-inside-work-tree"]);
	if (repo.code !== 0 || repo.stdout.trim().toLowerCase() === "false") {
		return {
			ok: false,
			error: `worktree isolation requires a Git repository at ${root}; use a Git checkout or remove isolation: "worktree"${repo.code !== 0 ? ` (git: ${gitFailureCause(repo)})` : ""}`,
		};
	}
	const status = await exec(["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.code !== 0) {
		return {
			ok: false,
			error: `worktree isolation could not inspect Git status at ${root}; commit/stash the checkout or remove isolation: "worktree" (git: ${gitFailureCause(status)})`,
		};
	}
	if (status.stdout.trim().length > 0) {
		const summary = status.stdout.trim().replace(/\s+/g, " ").slice(0, 240);
		return {
			ok: false,
			error: `worktree isolation requires a clean Git checkout; commit/stash current changes (including untracked files) or remove isolation: "worktree" (status: ${summary})`,
		};
	}
	return { ok: true };
}

/** Capture the complete post-run worktree state as a portable unified diff from its pinned
 * starting commit. Files newly created by a coding leg are added with `git diff --no-index`.
 * Exit code 1 is the normal "files differ" result for --no-index. */
export async function captureWorktreeArtifact(root: string, baseCommit: string, exec: GitExec = defaultGitExec): Promise<WorktreeArtifact> {
	if (!baseCommit.trim()) {
		return { ok: false, error: "could not export the isolated worktree diff: starting commit is missing" };
	}
	const tracked = await exec(["-C", root, "diff", "--no-ext-diff", "--binary", baseCommit, "--"]);
	if (tracked.code !== 0) {
		return { ok: false, error: `could not export the isolated worktree diff: ${tracked.stderr.trim() || `git exited ${tracked.code}`}` };
	}
	if (tracked.stdout.length > MAX_WORKTREE_ARTIFACT_CHARS) {
		return { ok: false, error: `isolated worktree artifact is too large to return safely (limit ${MAX_WORKTREE_ARTIFACT_CHARS} characters)` };
	}
	const listed = await exec(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]);
	if (listed.code !== 0) {
		return { ok: false, error: `could not enumerate new files in the isolated worktree: ${listed.stderr.trim() || `git exited ${listed.code}`}` };
	}
	const parts = tracked.stdout.trim().length > 0 ? [tracked.stdout] : [];
	let totalChars = tracked.stdout.length;
	for (const name of listed.stdout.split("\0").filter((entry) => entry.length > 0)) {
		const result = await exec(["-C", root, "diff", "--no-ext-diff", "--binary", "--no-index", "--", "/dev/null", name]);
		if (result.code !== 0 && result.code !== 1) {
			return { ok: false, error: `could not export new file ${name}: ${result.stderr.trim() || `git exited ${result.code}`}` };
		}
		totalChars += result.stdout.length;
		if (totalChars > MAX_WORKTREE_ARTIFACT_CHARS) {
			return { ok: false, error: `isolated worktree artifact is too large to return safely (limit ${MAX_WORKTREE_ARTIFACT_CHARS} characters)` };
		}
		if (result.stdout.trim().length > 0) parts.push(result.stdout);
	}
	return { ok: true, diff: parts.join("\n") };
}

/** The caller decides whether its exported result makes cleanup safe. */
export type WorktreeOutcome<T> = { value: T; cleanup: "remove" | "retain" };

/** Observe the path without following a replacement symlink. */
export async function describeWorktreeRecovery(path: string, baseCommit: string, reason: string): Promise<WorktreeRecovery> {
	const availability = await lstat(path).then((entry) => entry.isDirectory() ? "retained" as const : "unavailable" as const, () => "unavailable" as const);
	return { path, baseCommit, reason, availability };
}

export class WorktreeRetainedError extends Error {
	readonly recovery: WorktreeRecovery;
	constructor(recovery: WorktreeRecovery, cause: unknown) {
		super(formatWorktreeRecovery(recovery), { cause });
		this.recovery = recovery;
	}
}

/** Create a detached worktree, pin its baseline and preserve it if its body throws. */
export async function withWorktree<T>(root: string, exec: GitExec, body: (dir: string, baseCommit: string) => Promise<WorktreeOutcome<T>>): Promise<T> {
	const preflight = await worktreePreflight(root, exec);
	if (!preflight.ok) throw new Error(preflight.error);
	const dir = await mkdtemp(join(tmpdir(), "pi-persona-wt-"));
	const add = await exec(["-C", root, "worktree", "add", "--detach", dir, "HEAD"]);
	if (add.code !== 0) {
		await rm(dir, { recursive: true, force: true }).catch(() => {
			/* best effort */
		});
		throw new Error(`could not create git worktree: ${add.stderr.trim() || `git exited ${add.code}`}`);
	}
	let retain = false;
	try {
		const initial = await exec(["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"]);
		const baseCommit = initial.stdout.trim();
		if (initial.code !== 0 || !baseCommit) {
			const reason = initial.stderr.trim() || (initial.code !== 0 ? `git exited ${initial.code}` : "Git returned an empty commit id");
			throw new Error(`could not resolve the initial worktree commit: ${reason}`);
		}
		let outcome: WorktreeOutcome<T>;
		try {
			outcome = await body(dir, baseCommit);
		} catch (error) {
			retain = true;
			const reason = error instanceof Error ? error.message : String(error);
			throw new WorktreeRetainedError(await describeWorktreeRecovery(dir, baseCommit, reason), error);
		}
		retain = outcome.cleanup === "retain";
		return outcome.value;
	} finally {
		if (!retain) {
			// Remove the worktree registration, then the dir (force: it may carry the agent's edits).
			// Never throw: cleanup must not replace the body's result (or its error) — `defaultGitExec`
			// never rejects, but an injected `GitExec` could, and a rejection here must not either.
			const rejected = (): GitResult => ({ code: 1, stdout: "", stderr: "git exec rejected" });
			const remove = await exec(["-C", root, "worktree", "remove", "--force", dir]).catch(rejected);
			await rm(dir, { recursive: true, force: true }).catch(() => {
				/* the worktree remove usually handles it; ignore races */
			});
			// A failed remove (on Windows a grandchild tool process can still hold a file inside the
			// worktree) leaves the .git/worktrees entry registered while the dir is gone — prune it,
			// or stale ghosts accumulate across delegations until a manual `git worktree prune`.
			// Never throw: cleanup must not replace the body's result (or its error).
			if (remove.code !== 0) {
				await exec(["-C", root, "worktree", "prune"]).catch(rejected);
				if (process.env.PI_PERSONA_DEBUG) {
					process.stderr.write(`[pi-persona] git worktree remove failed for ${dir} (pruned): ${remove.stderr.trim() || `git exited ${remove.code}`}\n`);
				}
			}
		}
	}
}

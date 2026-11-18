import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ConversationWorktree } from "../core/worktree-recovery.ts";
import { defaultGitExec, type GitExec } from "./worktree.ts";

export type ConversationWorktreeResult = { ok: true } | { ok: false; error: string };

const invalid = (error: string): ConversationWorktreeResult => ({ ok: false, error });
const normalized = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Verify the original registered checkout; never substitute the supervisor's workspace. */
export async function verifyConversationWorktree(value: ConversationWorktree, expectedRoot: string, exec: GitExec = defaultGitExec): Promise<ConversationWorktreeResult> {
	try {
		if (!value || !isAbsolute(value.path) || !isAbsolute(value.root) || !isAbsolute(expectedRoot)
			|| !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.baseCommit)) return invalid("Invalid worktree metadata");
		const pathStat = await lstat(value.path);
		if (!pathStat.isDirectory() || pathStat.isSymbolicLink() || !basename(value.path).startsWith("pi-persona-wt-")) return invalid("Worktree is missing or is not an owned directory");
		const [path, temp, root, expected] = await Promise.all([realpath(value.path), realpath(tmpdir()), realpath(value.root), realpath(expectedRoot)]);
		if (normalized(dirname(path)) !== normalized(temp) || normalized(root) !== normalized(expected) || normalized(path) === normalized(root)) return invalid("Worktree path or owning workspace does not match");
		const [rootCommon, childCommon, listed, commit] = await Promise.all([
			exec(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
			exec(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
			exec(["-C", root, "worktree", "list", "--porcelain", "-z"]),
			exec(["-C", root, "cat-file", "-e", `${value.baseCommit}^{commit}`]),
		]);
		if (rootCommon.code || childCommon.code || listed.code || commit.code) return invalid("Cannot verify the worktree repository, registration, or baseline commit");
		const [a, b] = await Promise.all([realpath(rootCommon.stdout.trim()), realpath(childCommon.stdout.trim())]);
		if (normalized(a) !== normalized(b)) return invalid("Worktree belongs to a different repository");
		const registered = listed.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
		let found = false;
		for (const item of registered) {
			try { if (normalized(await realpath(item)) === normalized(path)) found = true; } catch { /* stale registration */ }
		}
		return found ? { ok: true } : invalid("Worktree is not registered with the owning repository");
	} catch (error) { return invalid(`Cannot verify worktree: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Explicit cleanup only, through Git after the same validation as resume. */
export async function removeConversationWorktree(value: ConversationWorktree, expectedRoot: string, exec: GitExec = defaultGitExec): Promise<ConversationWorktreeResult> {
	const verified = await verifyConversationWorktree(value, expectedRoot, exec);
	if (!verified.ok) return verified;
	try {
		const result = await exec(["-C", expectedRoot, "worktree", "remove", "--force", value.path]);
		if (result.code !== 0) return invalid(`Git could not remove worktree: ${result.stderr.trim() || `exit ${result.code}`}`);
		try { await lstat(value.path); return invalid("Git reported success but the worktree directory still exists"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return invalid("Cannot verify worktree removal"); }
		return { ok: true };
	} catch (error) { return invalid(`Cannot remove worktree: ${error instanceof Error ? error.message : String(error)}`); }
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { type GitExec, isGitRepo, withWorktree } from "../../../src/engine/worktree.ts";

/** A fake git that records calls and returns scripted results. */
function fakeGit(results: Record<string, { code: number; stdout?: string }> = {}): { exec: GitExec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: GitExec = (args) => {
		calls.push(args);
		const key = args.join(" ");
		const hit = Object.entries(results).find(([k]) => key.includes(k))?.[1];
		return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: "" };
	};
	return { exec, calls };
}

test("isGitRepo true only when rev-parse succeeds", () => {
	assert.equal(isGitRepo("/r", fakeGit({ "rev-parse": { code: 0 } }).exec), true);
	assert.equal(isGitRepo("/r", fakeGit({ "rev-parse": { code: 128 } }).exec), false);
});

test("withWorktree adds a detached worktree, runs the body with its path, then removes it", async () => {
	const { exec, calls } = fakeGit();
	let ranIn = "";
	const out = await withWorktree("/repo", exec, async (dir) => {
		ranIn = dir;
		return "result";
	});
	assert.equal(out, "result");
	assert.equal(ranIn.length > 0, true, "the body got a worktree path");
	const add = calls.find((c) => c.includes("worktree") && c.includes("add"));
	const remove = calls.find((c) => c.includes("worktree") && c.includes("remove"));
	assert.ok(add, "git worktree add was issued");
	assert.ok(add?.includes("--detach"), "detached worktree (no branch)");
	assert.ok(remove, "git worktree remove was issued");
	assert.ok(remove?.includes("--force"), "force-removed");
});

test("withWorktree removes the worktree even when the body throws", async () => {
	const { exec, calls } = fakeGit();
	await assert.rejects(() =>
		withWorktree("/repo", exec, async () => {
			throw new Error("body failed");
		}),
	);
	assert.ok(
		calls.some((c) => c.includes("worktree") && c.includes("remove")),
		"cleanup ran despite the throw",
	);
});

test("withWorktree throws a clear error if the worktree cannot be created", async () => {
	const { exec } = fakeGit({ "worktree add": { code: 128 } });
	await assert.rejects(() => withWorktree("/repo", exec, async () => "x"), /worktree/i);
});

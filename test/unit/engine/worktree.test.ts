import { test } from "node:test";
import assert from "node:assert/strict";

import * as worktree from "../../../src/engine/worktree.ts";
import type { GitExec, WorktreeArtifact } from "../../../src/engine/worktree.ts";
import { isGitRepo, withWorktree } from "../../../src/engine/worktree.ts";

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

test("withWorktree rejects a dirty repository before creating or running an isolated leg", async () => {
	const { exec, calls } = fakeGit({ status: { code: 0, stdout: " M src/live.ts\n?? notes.txt\n" } });
	await assert.rejects(
		() => withWorktree("/repo", exec, async () => "must not run"),
		/commit|stash|remove isolation/i,
	);
	assert.equal(calls.some((c) => c.includes("worktree") && c.includes("add")), false, "dirty worktree must not spawn git worktree add");
});

test("withWorktree rejects a non-Git cwd before creating or running an isolated leg", async () => {
	const { exec, calls } = fakeGit({ "rev-parse": { code: 128 } });
	await assert.rejects(
		() => withWorktree("/not-a-repo", exec, async () => "must not run"),
		/git repository|isolation/i,
	);
	assert.equal(calls.some((c) => c.includes("worktree") && c.includes("add")), false, "non-repo must not spawn git worktree add");
});

test("captureWorktreeArtifact exports tracked and untracked edits as a unified diff", () => {
	const { exec, calls } = fakeGit({
		"no-index": { code: 1, stdout: "diff --git a/notes.txt b/notes.txt\n+new\n" },
		diff: { code: 0, stdout: "diff --git a/src/live.ts b/src/live.ts\n+changed\n" },
		"ls-files": { code: 0, stdout: "notes.txt\n" },
	});
	assert.equal(typeof worktree.captureWorktreeArtifact, "function", "the artifact capture seam must exist");
	const artifact = (worktree.captureWorktreeArtifact as (root: string, git: GitExec) => WorktreeArtifact)("/wt", exec);
	assert.equal(artifact.ok, true);
	if (artifact.ok) {
		assert.match(artifact.diff, /src\/live\.ts/);
		assert.match(artifact.diff, /notes\.txt/);
	}
	assert.ok(calls.some((c) => c.includes("ls-files") && c.includes("--others")));
});

test("captureWorktreeArtifact rejects an artifact too large to return safely", () => {
	const { exec } = fakeGit({ diff: { code: 0, stdout: "x".repeat(1_000_001) } });
	const artifact = worktree.captureWorktreeArtifact("/wt", exec);
	assert.equal(artifact.ok, false);
	if (!artifact.ok) assert.match(artifact.error, /too large|limit/i);
});

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

test("withWorktree prunes the registration when `git worktree remove` fails", async () => {
	// Windows: a grandchild tool process can still hold a file inside the worktree when cleanup
	// runs, so `remove` exits non-zero. The dir is deleted anyway — without a prune the repo keeps
	// a stale .git/worktrees entry, and they accumulate across delegations.
	const { exec, calls } = fakeGit({ "worktree remove": { code: 1 } });
	const out = await withWorktree("/repo", exec, async () => "result");
	assert.equal(out, "result", "a cleanup failure never fails the body's result");
	assert.ok(
		calls.some((c) => c.includes("worktree") && c.includes("prune")),
		"the stale registration was pruned",
	);
});

test("withWorktree does not prune when the worktree was removed cleanly", async () => {
	const { exec, calls } = fakeGit();
	await withWorktree("/repo", exec, async () => "x");
	assert.equal(calls.some((c) => c.includes("prune")), false, "no pruning of other live worktrees on the happy path");
});

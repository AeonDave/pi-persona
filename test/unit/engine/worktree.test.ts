import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import * as worktree from "../../../src/engine/worktree.ts";
import type { GitExec } from "../../../src/engine/worktree.ts";
import { withWorktree } from "../../../src/engine/worktree.ts";

const PINNED_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A fake git that records calls and returns scripted results. */
function fakeGit(results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): { exec: GitExec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: GitExec = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		const hit = Object.entries(results).find(([k]) => key.includes(k))?.[1];
		if (hit) return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
		if (args.includes("--verify") && args.includes("HEAD^{commit}")) {
			return { code: 0, stdout: PINNED_COMMIT, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

test("defaultGitExec never blocks the event loop: a timer fires while git runs", async () => {
	let ticked = false;
	const timer = setTimeout(() => {
		ticked = true;
	}, 0);
	const result = await worktree.defaultGitExec(["--version"]);
	clearTimeout(timer);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /git version/);
	assert.equal(ticked, true, "a zero-delay timer must run while the git child process is awaited");
});

test("defaultGitExec reports a failing git command as a code, never a throw", async () => {
	const result = await worktree.defaultGitExec(["-C", "/definitely/not/a/repo", "rev-parse", "--is-inside-work-tree"]);
	assert.notEqual(result.code, 0);
});

test("withWorktree removes a created worktree if its starting commit cannot be resolved", async () => {
	const { exec, calls } = fakeGit({ "--verify": { code: 128 } });
	let bodyRan = false;
	await assert.rejects(
		() => withWorktree("/repo", exec, async () => {
			bodyRan = true;
			return { cleanup: "remove" as const, value: undefined };
		}),
		/baseline|commit|resolve/i,
	);
	assert.equal(bodyRan, false, "the worker body cannot start without a pinned baseline");
	assert.ok(calls.some((c) => c.includes("worktree") && c.includes("remove")), "cleanup runs after baseline resolution fails");
});

test("withWorktree rejects a dirty repository before creating or running an isolated leg", async () => {
	const { exec, calls } = fakeGit({ status: { code: 0, stdout: " M src/live.ts\n?? notes.txt\n" } });
	await assert.rejects(
		() => withWorktree("/repo", exec, async () => ({ cleanup: "remove" as const, value: "must not run" })),
		/commit|stash|remove isolation/i,
	);
	assert.equal(calls.some((c) => c.includes("worktree") && c.includes("add")), false, "dirty worktree must not spawn git worktree add");
});

test("withWorktree rejects a non-Git cwd before creating or running an isolated leg", async () => {
	const { exec, calls } = fakeGit({ "rev-parse": { code: 128 } });
	await assert.rejects(
		() => withWorktree("/not-a-repo", exec, async () => ({ cleanup: "remove" as const, value: "must not run" })),
		/git repository|isolation/i,
	);
	assert.equal(calls.some((c) => c.includes("worktree") && c.includes("add")), false, "non-repo must not spawn git worktree add");
});

test("worktree preflight names git's own failure instead of blaming the checkout", async () => {
	// macOS: an x86_64 (Rosetta) process reaching the /usr/bin/git shim of arm64-only Command Line Tools.
	const xcrun = "xcrun: error: unable to load libxcrun (dlopen(/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib, 0x0005): tried: '…' (fat file, but missing compatible architecture (have 'arm64,arm64e', need 'x86_64'))).";
	const { exec } = fakeGit({ "rev-parse": { code: 1, stderr: `${xcrun}\nsecond line\n` } });
	const result = await worktree.worktreePreflight("/repo", exec);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /git: xcrun: error: unable to load libxcrun/, "the operator sees why git failed");
	assert.doesNotMatch(result.ok ? "" : result.error, /second line/, "only the first line of git's error");
	assert.ok((result.ok ? "" : result.error).length < 500, "a long git error stays bounded");

	const spawnFailure = fakeGit({ "rev-parse": { code: -1 } });
	const missing = await worktree.worktreePreflight("/repo", spawnFailure.exec);
	assert.match(missing.ok ? "" : missing.error, /\(git: exited -1\)/, "without stderr the exit code is the cause");
});

test("captureWorktreeArtifact exports tracked and untracked edits as a unified diff", async () => {
	const { exec, calls } = fakeGit({
		"no-index": { code: 1, stdout: "diff --git a/notes.txt b/notes.txt\n+new\n" },
		diff: { code: 0, stdout: "diff --git a/src/live.ts b/src/live.ts\n+changed\n" },
		"ls-files": { code: 0, stdout: "notes.txt\n" },
	});
	assert.equal(typeof worktree.captureWorktreeArtifact, "function", "the artifact capture seam must exist");
	const artifact = await worktree.captureWorktreeArtifact("/wt", PINNED_COMMIT, exec);
	assert.equal(artifact.ok, true);
	if (artifact.ok) {
		assert.match(artifact.diff, /src\/live\.ts/);
		assert.match(artifact.diff, /notes\.txt/);
	}
	assert.ok(calls.some((c) => c.includes("ls-files") && c.includes("--others")));
	assert.ok(calls.some((c) => c.includes("diff") && c.includes(PINNED_COMMIT)), "tracked changes are diffed against the pinned baseline, not mutable HEAD");
});

test("captureWorktreeArtifact rejects an artifact too large to return safely", async () => {
	const { exec } = fakeGit({ diff: { code: 0, stdout: "x".repeat(1_000_001) } });
	const artifact = await worktree.captureWorktreeArtifact("/wt", PINNED_COMMIT, exec);
	assert.equal(artifact.ok, false);
	if (!artifact.ok) assert.match(artifact.error, /too large|limit/i);
});

test("withWorktree adds a detached worktree, runs the body with its path, then removes it", async () => {
	const { exec, calls } = fakeGit();
	let ranIn = "";
	let baseCommit = "";
	const out = await withWorktree("/repo", exec, async (dir, initialCommit) => {
		ranIn = dir;
		baseCommit = initialCommit;
		return { cleanup: "remove" as const, value: "result" };
	});
	assert.equal(out, "result");
	assert.equal(ranIn.length > 0, true, "the body got a worktree path");
	assert.equal(baseCommit, PINNED_COMMIT, "the body got the resolved starting commit");
	const add = calls.find((c) => c.includes("worktree") && c.includes("add"));
	const remove = calls.find((c) => c.includes("worktree") && c.includes("remove"));
	assert.ok(add, "git worktree add was issued");
	assert.ok(add?.includes("--detach"), "detached worktree (no branch)");
	assert.ok(remove, "git worktree remove was issued");
	assert.ok(remove?.includes("--force"), "force-removed");
});

test("withWorktree retains the worktree and reports its baseline when the body throws", async () => {
	const { exec, calls } = fakeGit();
	let dir = "";
	try {
		await assert.rejects(() =>
			withWorktree("/repo", exec, async (path) => {
				dir = path;
				throw new Error("body failed");
			}),
			(error: Error) => error.message.includes("body failed") && error.message.includes(dir) && error.message.includes(PINNED_COMMIT),
		);
		assert.ok(dir);
		assert.equal(calls.some((c) => c.includes("worktree") && c.includes("remove")), false);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

test("git execution failures never masquerade as the no-index diff exit code", () => {
	assert.equal(worktree.gitFailureCode({ code: 1 }), 1);
	assert.equal(worktree.gitFailureCode({ code: "ETIMEDOUT" }), -1);
	assert.equal(worktree.gitFailureCode({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), -1);
	assert.equal(worktree.gitFailureCode({ code: 1, signal: "SIGTERM" }), -1);
	assert.equal(worktree.gitFailureCode({ code: 1, killed: true }), -1);
});

test("capture rejects an interrupted no-index diff", async () => {
	const { exec } = fakeGit({ "no-index": { code: -1 }, "ls-files": { code: 0, stdout: "new.txt\0" } });
	const artifact = await worktree.captureWorktreeArtifact("/wt", PINNED_COMMIT, exec);
	assert.equal(artifact.ok, false);
});

test("withWorktree throws a clear error if the worktree cannot be created", async () => {
	const { exec } = fakeGit({ "worktree add": { code: 128 } });
	await assert.rejects(() => withWorktree("/repo", exec, async () => ({ cleanup: "remove" as const, value: "x" })), /worktree/i);
});

test("withWorktree prunes the registration when `git worktree remove` fails", async () => {
	// Windows: a grandchild tool process can still hold a file inside the worktree when cleanup
	// runs, so `remove` exits non-zero. The dir is deleted anyway — without a prune the repo keeps
	// a stale .git/worktrees entry, and they accumulate across delegations.
	const { exec, calls } = fakeGit({ "worktree remove": { code: 1 } });
	const out = await withWorktree("/repo", exec, async () => ({ cleanup: "remove" as const, value: "result" }));
	assert.equal(out, "result", "a cleanup failure never fails the body's result");
	assert.ok(
		calls.some((c) => c.includes("worktree") && c.includes("prune")),
		"the stale registration was pruned",
	);
});

test("withWorktree does not prune when the worktree was removed cleanly", async () => {
	const { exec, calls } = fakeGit();
	await withWorktree("/repo", exec, async () => ({ cleanup: "remove" as const, value: "x" }));
	assert.equal(calls.some((c) => c.includes("prune")), false, "no pruning of other live worktrees on the happy path");
});

test("withWorktree returns the body's result even when the remove step's GitExec rejects", async () => {
	// `defaultGitExec` never rejects (M3/M4), but an injected fake can — the `finally` block's
	// comment promises cleanup never replaces the body's result, and that promise must hold even
	// when the exec itself throws, not just when it resolves with a non-zero code.
	const calls: string[][] = [];
	const exec: GitExec = async (args) => {
		calls.push(args);
		if (args.includes("remove")) throw new Error("git exec rejected");
		if (args.includes("--verify") && args.includes("HEAD^{commit}")) {
			return { code: 0, stdout: PINNED_COMMIT, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const out = await withWorktree("/repo", exec, async () => ({ cleanup: "remove" as const, value: "result" }));
	assert.equal(out, "result", "a rejecting remove must not replace (or throw over) the body's result");
	assert.ok(
		calls.some((c) => c.includes("worktree") && c.includes("prune")),
		"a failed (rejected) remove is treated as non-zero, so the stale registration is still pruned",
	);
});

test("the doctor git line reports the version, or why git is unusable and what needs it", () => {
	assert.equal(worktree.gitDoctorLine({ code: 0, stdout: "git version 2.52.0\n", stderr: "" }), "git: git version 2.52.0");
	const broken = worktree.gitDoctorLine({ code: 1, stdout: "", stderr: "xcrun: error: unable to load libxcrun (need 'x86_64')\n" });
	assert.match(broken, /^git: UNUSABLE \(xcrun: error: unable to load libxcrun/, "one git prefix, then git's own words");
	assert.match(broken, /worktree isolation, compete and change reports/);
	assert.match(worktree.gitDoctorLine({ code: -1, stdout: "", stderr: "" }), /^git: UNUSABLE \(exited -1\)/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { captureWorktreeArtifact, withWorktree, type GitExec } from "../../src/engine/worktree.ts";

function isolatedGitExec(globalConfig: string, home: string, hooks: string): GitExec {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "pi-persona test",
		GIT_AUTHOR_EMAIL: "pi-persona-test@example.invalid",
		GIT_COMMITTER_NAME: "pi-persona test",
		GIT_COMMITTER_EMAIL: "pi-persona-test@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	};
	for (const key of Object.keys(env)) {
		if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
	}
	delete env.GIT_CONFIG_COUNT;
	delete env.GIT_CONFIG_PARAMETERS;
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;

	return (args) => new Promise((resolveResult) => {
		execFile(
			"git",
			["-c", "core.autocrlf=false", "-c", `core.hooksPath=${hooks}`, ...args],
			{ encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const e = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
				resolveResult({
					code: !error ? 0 : typeof e?.code === "number" ? e.code : 1,
					stdout: stdout ?? "",
					stderr: stderr || e?.message || "",
				});
			},
		);
	});
}

async function gitOk(exec: GitExec, ...args: string[]): Promise<string> {
	const result = await exec(args);
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trimEnd();
}

async function makeRepoFixture() {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-persona-worktree-export-"));
	const home = join(tempRoot, "home");
	const hooks = join(tempRoot, "empty-hooks");
	const repo = join(tempRoot, "repo");
	await mkdir(home, { recursive: true });
	await mkdir(hooks, { recursive: true });
	await mkdir(repo);
	const globalConfig = join(tempRoot, "empty.gitconfig");
	await writeFile(globalConfig, "", "utf8");
	const exec = isolatedGitExec(globalConfig, home, hooks);
	await gitOk(exec, "-C", repo, "init", "--quiet", "-b", "main");
	await writeFile(join(repo, "committed.txt"), "baseline committed file\n", "utf8");
	await writeFile(join(repo, "uncommitted.txt"), "baseline uncommitted file\n", "utf8");
	await gitOk(exec, "-C", repo, "add", "--", "committed.txt", "uncommitted.txt");
	await gitOk(exec, "-C", repo, "commit", "--quiet", "-m", "baseline");
	return { tempRoot, repo, exec };
}

async function applyArtifact(exec: GitExec, sourceRepo: string, tempRoot: string, patch: string, name: string): Promise<string> {
	const applyRepo = join(tempRoot, name);
	const patchPath = join(tempRoot, `${name}.patch`);
	await gitOk(exec, "clone", "--quiet", "--no-hardlinks", sourceRepo, applyRepo);
	await writeFile(patchPath, patch, "utf8");
	await gitOk(exec, "-C", applyRepo, "apply", "--binary", patchPath);
	return applyRepo;
}

test("worktree export applies worker commits, uncommitted edits and new binary files to the original baseline", async () => {
	const { tempRoot, repo, exec } = await makeRepoFixture();
	try {
		const baseline = (await gitOk(exec, "-C", repo, "rev-parse", "HEAD")).trim();
		const expected = new Map<string, Buffer>([
			["committed.txt", Buffer.from("worker committed bytes A\n")],
			["uncommitted.txt", Buffer.from("worker uncommitted bytes B\n")],
			["new.bin", Buffer.from([0, 1, 2, 127, 128, 255])],
		]);
		const artifact = await withWorktree(repo, exec, async (dir, baseCommit) => {
			assert.equal(baseCommit, baseline, "the worktree callback receives its pinned starting commit");
			await writeFile(join(dir, "committed.txt"), expected.get("committed.txt")!);
			await gitOk(exec, "-C", dir, "add", "--", "committed.txt");
			await gitOk(exec, "-C", dir, "commit", "--quiet", "-m", "worker change A");
			await writeFile(join(dir, "uncommitted.txt"), expected.get("uncommitted.txt")!);
			await writeFile(join(dir, "new.bin"), expected.get("new.bin")!);
			return captureWorktreeArtifact(dir, baseCommit, exec);
		});

		assert.equal(artifact.ok, true, artifact.ok ? "" : artifact.error);
		if (!artifact.ok) return;
		assert.match(artifact.diff, /worker committed bytes A/, "the export includes commit A");
		assert.match(artifact.diff, /worker uncommitted bytes B/, "the export includes uncommitted edit B");
		assert.match(artifact.diff, /GIT binary patch/, "new binary files remain portable");

		assert.equal((await gitOk(exec, "-C", repo, "rev-parse", "HEAD")).trim(), baseline, "the main checkout HEAD is unchanged");
		assert.equal(await gitOk(exec, "-C", repo, "status", "--porcelain=v1", "--untracked-files=all"), "", "the main checkout remains clean");
		assert.deepEqual(await readFile(join(repo, "committed.txt")), Buffer.from("baseline committed file\n"));
		assert.deepEqual(await readFile(join(repo, "uncommitted.txt")), Buffer.from("baseline uncommitted file\n"));
		const listed = await gitOk(exec, "-C", repo, "worktree", "list", "--porcelain");
		assert.deepEqual(listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice("worktree ".length))), [resolve(repo)], "the temporary worktree is removed");

		const appliedRepo = await applyArtifact(exec, repo, tempRoot, artifact.diff, "applied-mixed-artifact");
		for (const [name, bytes] of expected) {
			assert.deepEqual(await readFile(join(appliedRepo, name)), bytes, `${name} reconstructs byte-for-byte from the baseline`);
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("worktree export includes commit-only changes", async () => {
	const { tempRoot, repo, exec } = await makeRepoFixture();
	try {
		const expected = Buffer.from("commit-only worker bytes\n");
		const artifact = await withWorktree(repo, exec, async (dir, baseCommit) => {
			await writeFile(join(dir, "committed.txt"), expected);
			await gitOk(exec, "-C", dir, "add", "--", "committed.txt");
			await gitOk(exec, "-C", dir, "commit", "--quiet", "-m", "only committed change");
			return captureWorktreeArtifact(dir, baseCommit, exec);
		});
		assert.equal(artifact.ok, true, artifact.ok ? "" : artifact.error);
		if (!artifact.ok) return;
		assert.match(artifact.diff, /commit-only worker bytes/);
		const appliedRepo = await applyArtifact(exec, repo, tempRoot, artifact.diff, "applied-commit-only-artifact");
		assert.deepEqual(await readFile(join(appliedRepo, "committed.txt")), expected);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("withWorktree removes the real worktree when resolving its baseline fails", async () => {
	const { tempRoot, repo, exec } = await makeRepoFixture();
	try {
		let worktreeDir: string | undefined;
		let bodyRan = false;
		const failBaseline: GitExec = async (args) => {
			const addIndex = args.indexOf("add");
			if (addIndex >= 0 && args.includes("--detach")) worktreeDir = args[args.indexOf("--detach") + 1];
			if (args.includes("--verify") && args.includes("HEAD^{commit}")) {
				return { code: 128, stdout: "", stderr: "simulated baseline resolution failure" };
			}
			return exec(args);
		};
		await assert.rejects(
			() => withWorktree(repo, failBaseline, async () => {
				bodyRan = true;
			}),
			/baseline|commit|resolve/i,
		);
		assert.equal(bodyRan, false, "the worker body never starts without a pinned baseline");
		assert.ok(worktreeDir, "the real worktree was created before baseline resolution failed");
		assert.equal(existsSync(worktreeDir!), false, "the temporary worktree directory is removed");
		const listed = await gitOk(exec, "-C", repo, "worktree", "list", "--porcelain");
		assert.deepEqual(listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice("worktree ".length))), [resolve(repo)], "the worktree registration is removed");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

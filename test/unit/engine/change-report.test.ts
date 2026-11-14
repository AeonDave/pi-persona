/**
 * Task 4: the files-changed report for a non-worktree leg. Pure functions only — the process
 * boundary (`captureStatus`'s two `git` calls) is exercised against `defaultGitExec` and a
 * nonexistent path so the "not a repo" branch is tested without a fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { captureStatus, diffStatus, findGitRoot, MAX_REPORTED_PATHS, parsePorcelainZ, renderChangeReport } from "../../../src/engine/change-report.ts";
import type { GitExec } from "../../../src/engine/worktree.ts";
import { defaultGitExec } from "../../../src/engine/worktree.ts";
import { tempDir } from "../../setup/temp-dir.ts";

test("diffStatus compares paths and status codes, so same-status edits to an already-dirty path are not detected", () => {
	const before = parsePorcelainZ(" M src/a.ts\0?? notes.txt\0");
	const after = parsePorcelainZ(" M src/a.ts\0 M src/b.ts\0A  src/c.ts\0");
	assert.deepEqual(diffStatus(before, after), [
		{ path: "src/b.ts", kind: "M" }, { path: "src/c.ts", kind: "A" }, { path: "notes.txt", kind: "clean" },
	]);
	assert.deepEqual(diffStatus(parsePorcelainZ(" M src/already-dirty.ts\0"), parsePorcelainZ(" M src/already-dirty.ts\0")), []);
});

test("parsePorcelainZ consumes a rename's old-path field instead of recording it as its own entry", () => {
	const snap = parsePorcelainZ("R  new.ts\0old.ts\0 M other.ts\0");
	assert.deepEqual([...snap.entries.entries()], [
		["new.ts", "R "],
		["other.ts", " M"],
	]);
});

test("renderChangeReport is an explicitly non-attributing snapshot delta, bounded, and scope-aware", () => {
	assert.equal(renderChangeReport([]), undefined);
	const many = Array.from({ length: 45 }, (_, i) => ({ path: `f${i}.ts`, kind: "M" as const }));
	const text = renderChangeReport(many)!;
	assert.match(text, /^--- GIT STATUS SNAPSHOT DELTA /);
	assert.match(text, /not proof this leg wrote these paths/);
	assert.match(text, /concurrent actors may contribute/);
	assert.match(text, /inspect before attribution/);
	assert.match(text, /already-dirty paths with unchanged status are not detected/);
	assert.match(text, /no report does not prove no writes/);
	assert.match(text, /\+5 more/);
	assert.equal(text.split("\n").length, 1 + MAX_REPORTED_PATHS + 2);

	const scoped = renderChangeReport([{ path: "src/x.ts", kind: "M" }, { path: "docs/y.md", kind: "A" }], ["src/"])!;
	assert.match(scoped, /src\/x\.ts \(M\)/);
	assert.doesNotMatch(scoped, /src\/x\.ts.*outside/);
	assert.match(scoped, /docs\/y\.md \(A\) ⚠ observed outside declared writeSet in shared-checkout status delta/);
	assert.match(scoped, /not proof this leg wrote it or violated scope/);

	for (const noScope of [renderChangeReport([{ path: "docs/y.md", kind: "A" }]), renderChangeReport([{ path: "docs/y.md", kind: "A" }], [])]) {
		assert.match(noScope!, /docs\/y\.md \(A\)/, "keep interesting concurrent changes visible without a declared write scope, including for readers");
		assert.doesNotMatch(noScope!, /outside declared writeSet/);
	}
});

test("findGitRoot returns the nearest ancestor that has a .git entry", () => {
	const root = resolve("/repo");
	const nested = join(root, "packages", "app");
	const exists = (p: string) => p === join(root, ".git");
	assert.equal(findGitRoot(nested, exists), root);
});

test("findGitRoot returns undefined when no ancestor within the walk has .git", () => {
	assert.equal(findGitRoot(resolve("/no/repo/here"), () => false), undefined);
});

test("findGitRoot is bounded: it gives up after MAX_GIT_ROOT_ANCESTORS checks rather than walking to the real filesystem root", () => {
	const deep = resolve("/", ...Array.from({ length: 20 }, (_, i) => `level${i}`));
	let calls = 0;
	assert.equal(
		findGitRoot(deep, () => {
			calls++;
			return false;
		}),
		undefined,
	);
	assert.ok(calls <= 12, `expected the walk to stop within 12 checks, saw ${calls}`);
});

test("captureStatus returns undefined outside a git repository", async () => {
	assert.equal(await captureStatus("/definitely/not/a/repo", defaultGitExec), undefined);
});

test("captureStatus skips the git round trip entirely when root has no .git entry", async () => {
	const cwd = tempDir("pi-persona-change-report-");
	let calls = 0;
	const exec: GitExec = async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "" };
	};
	assert.equal(await captureStatus(cwd, exec), undefined);
	assert.equal(calls, 0, "no git process should be spawned for a plain, non-repository directory");
});

test("captureStatus still asks git when .git exists but is not actually a repository", async () => {
	const cwd = tempDir("pi-persona-change-report-");
	mkdirSync(join(cwd, ".git"));
	const calls: string[][] = [];
	const exec: GitExec = async (args) => {
		calls.push(args);
		return { code: 128, stdout: "", stderr: "not a git repository" };
	};
	assert.equal(await captureStatus(cwd, exec), undefined);
	assert.equal(calls.length, 1, "a bare .git entry still triggers the real rev-parse check");
});

test("captureStatus finds a repository whose top level is an ancestor of a nested cwd", async () => {
	const repoRoot = tempDir("pi-persona-change-report-nested-");
	mkdirSync(join(repoRoot, ".git"));
	const nested = join(repoRoot, "packages", "app");
	mkdirSync(nested, { recursive: true });
	const calls: string[][] = [];
	const exec: GitExec = async (args) => {
		calls.push(args);
		if (args.includes("rev-parse")) return { code: 0, stdout: "true", stderr: "" };
		return { code: 0, stdout: " M src/a.ts\0", stderr: "" };
	};
	const snapshot = await captureStatus(nested, exec);
	assert.deepEqual([...(snapshot?.entries.entries() ?? [])], [["src/a.ts", " M"]]);
	assert.ok(calls.every((args) => args.includes("-C") && args.includes(repoRoot)), "git must run with -C at the discovered repository root, not the nested cwd");
});

test("captureStatus skips both its own findGitRoot walk and the rev-parse gate when given an already-resolved gitRoot", async () => {
	const repoRoot = tempDir("pi-persona-change-report-known-root-");
	mkdirSync(join(repoRoot, ".git"));
	const calls: string[][] = [];
	const exec: GitExec = async (args) => {
		calls.push(args);
		return { code: 0, stdout: " M src/a.ts\0", stderr: "" };
	};
	const snapshot = await captureStatus(repoRoot, exec, repoRoot);
	assert.deepEqual([...(snapshot?.entries.entries() ?? [])], [["src/a.ts", " M"]]);
	assert.equal(calls.length, 1, "only the status call runs — no rev-parse — when the caller already resolved and vouched for the root");
	assert.ok(!calls[0]!.includes("rev-parse"));
});

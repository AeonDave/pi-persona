/**
 * Task 4: the files-changed report for a non-worktree leg. Pure functions only — the process
 * boundary (`captureStatus`'s two `git` calls) is exercised against `defaultGitExec` and a
 * nonexistent path so the "not a repo" branch is tested without a fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { captureStatus, diffStatus, MAX_REPORTED_PATHS, parsePorcelainZ, renderChangeReport } from "../../../src/engine/change-report.ts";
import type { GitExec } from "../../../src/engine/worktree.ts";
import { defaultGitExec } from "../../../src/engine/worktree.ts";
import { tempDir } from "../../setup/temp-dir.ts";

test("diffStatus reports appeared, changed and disappeared entries", () => {
	const before = parsePorcelainZ(" M src/a.ts\0?? notes.txt\0");
	const after = parsePorcelainZ(" M src/a.ts\0 M src/b.ts\0A  src/c.ts\0");
	assert.deepEqual(diffStatus(before, after), [
		{ path: "src/b.ts", kind: "M" }, { path: "src/c.ts", kind: "A" }, { path: "notes.txt", kind: "clean" },
	]);
});

test("parsePorcelainZ consumes a rename's old-path field instead of recording it as its own entry", () => {
	const snap = parsePorcelainZ("R  new.ts\0old.ts\0 M other.ts\0");
	assert.deepEqual([...snap.entries.entries()], [
		["new.ts", "R "],
		["other.ts", " M"],
	]);
});

test("renderChangeReport is undefined when nothing changed, bounded, and flags paths outside the declared writeSet", () => {
	assert.equal(renderChangeReport([]), undefined);
	const many = Array.from({ length: 45 }, (_, i) => ({ path: `f${i}.ts`, kind: "M" as const }));
	const text = renderChangeReport(many)!;
	assert.match(text, /^--- FILES CHANGED DURING THIS LEG \(shared checkout; parallel legs may overlap\) ---/);
	assert.match(text, /\+5 more/);
	assert.equal(text.split("\n").length, 1 + MAX_REPORTED_PATHS + 1);
	const flagged = renderChangeReport([{ path: "src/x.ts", kind: "M" }, { path: "docs/y.md", kind: "A" }], ["src/"])!;
	assert.match(flagged, /docs\/y\.md \(A\) ⚠ outside declared writeSet/);
	assert.doesNotMatch(flagged, /src\/x\.ts.*outside/);
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

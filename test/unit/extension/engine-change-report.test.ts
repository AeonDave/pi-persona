/**
 * Task 4: `withChangeReport` must actually be wired into `createBuildEngine`'s plain `run` path
 * (non-worktree, non-mcp legs), not just exist as a standalone function. This builds a REAL engine
 * via `createBuildEngine` (child branch, worktree/mcp/broker off) with a stubbed base engine —
 * same fixture shape as engine-fallback.test.ts — and an injected `BuildEngineDeps.gitExec` fake
 * that answers `rev-parse` and `status` by call order, so a files-changed block is appended (or
 * not) exactly as `git status` before/after the leg would dictate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createBuildEngine, type BuildEngineDeps } from "../../../src/extension/engine.ts";
import type { GitExec } from "../../../src/engine/worktree.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";
import { tempDir } from "../../setup/temp-dir.ts";

const usage = { input: 0, output: 0, turns: 0 } as never;
const okResult = (): AgentResult => ({ agent: "a", output: "done", usage, ok: true });

function baseDeps(gitExec: GitExec, cwd: string = process.cwd(), result: () => AgentResult = okResult): () => BuildEngineDeps {
	const ctx = {
		cwd,
		model: { provider: "anthropic", id: "m" },
		modelRegistry: {
			getAll: () => [{ provider: "anthropic", id: "m" }],
			getAvailable: () => [{ provider: "anthropic", id: "m" }],
		},
		sessionManager: { getSessionId: () => "s1" },
	} as unknown as BuildEngineDeps["lastCtx"];
	return () => ({
		agents: [{ name: "a", model: "anthropic/m", systemPrompt: "x", source: "t" } as never],
		contractDefs: {},
		controller: { activePersona: undefined, capabilities: undefined } as never,
		host: { getThinkingLevel: () => "high" } as never,
		config: { engine: "child", broker: false } as never,
		personaConfigs: {} as never,
		lastCtx: ctx,
		workerSpineText: "",
		engineFactories: { makeEngine: () => ({ run: async () => result() }) as never, makeInProcessEngine: () => ({ run: async () => result() }) as never },
		makeBrokerDeps: () => undefined as never,
		userAgentDir: () => process.cwd(),
		childPiSettingsEnv: () => ({}),
		runLimits: { timeoutMs: 1000 } as never,
		bus: {} as never,
		supervisorHandle: "supervisor",
		gitExec,
	});
}

/** Answers `rev-parse` with a fixed reply and `status` with the next entry of `statusReplies`,
 *  by call order — mirrors the real before/after capture sequence `withChangeReport` performs. */
function fakeGit(statusReplies: string[], revParse: { code: number; stdout: string } = { code: 0, stdout: "true" }): GitExec {
	let statusCall = 0;
	return async (args) => {
		if (args.includes("rev-parse")) return { ...revParse, stderr: "" };
		if (args.includes("status")) {
			const stdout = statusReplies[statusCall] ?? "";
			statusCall += 1;
			return { code: 0, stdout, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

test("a non-worktree leg's output gets a files-changed block naming what appeared", async () => {
	const engine = createBuildEngine(baseDeps(fakeGit(["", " M src/a.ts\0"])))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.match(r.output, /^done\n\n--- FILES CHANGED DURING THIS LEG/);
	assert.match(r.output, /- src\/a\.ts \(M\)/);
});

test("a non-worktree leg with no status change returns the raw output untouched", async () => {
	const engine = createBuildEngine(baseDeps(fakeGit(["", ""])))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.equal(r.output, "done");
});

test("a failing git status produces no block and does not throw (the resolved root is trusted here, so rev-parse is never consulted — see change-report.test.ts for that gate)", async () => {
	const failStatus: GitExec = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
	const engine = createBuildEngine(baseDeps(failStatus))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.equal(r.output, "done");
});

test("a leg that aborted with empty output still gets a clean block, never leading blank lines", async () => {
	const abortResult = (): AgentResult => ({ agent: "a", output: "", usage, ok: false, error: "aborted", failureKind: "abort" });
	const engine = createBuildEngine(baseDeps(fakeGit(["", " M src/a.ts\0"]), undefined, abortResult))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, false);
	assert.equal(r.error, "aborted");
	assert.match(r.output, /^--- FILES CHANGED DURING THIS LEG/);
	assert.doesNotMatch(r.output, /^\s*\n/, "the block must not be preceded by blank lines when there was no output to trim");
});

test("a full leg (before + after capture) spawns exactly two git processes, not four — no redundant rev-parse", async () => {
	const repoRoot = tempDir("pi-persona-engine-change-report-spawns-");
	mkdirSync(join(repoRoot, ".git"));
	let calls = 0;
	const exec: GitExec = async (args) => {
		calls += 1;
		if (args.includes("status")) return { code: 0, stdout: calls === 1 ? "" : " M src/a.ts\0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const engine = createBuildEngine(baseDeps(exec, repoRoot))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.match(r.output, /FILES CHANGED DURING THIS LEG/);
	assert.equal(calls, 2, "one status call per capture, no rev-parse gate on either");
});

test("PI_PERSONA_LEG_CHANGE_REPORT off: no git process is spawned and the leg's output carries no report block", async () => {
	const repoRoot = tempDir("pi-persona-engine-change-report-off-");
	mkdirSync(join(repoRoot, ".git"));
	let calls = 0;
	const exec: GitExec = async () => {
		calls += 1;
		return { code: 0, stdout: " M src/a.ts\0", stderr: "" };
	};
	const deps = baseDeps(exec, repoRoot);
	const engine = createBuildEngine(() => ({ ...deps(), config: { engine: "child", broker: false, changeReport: false } as never }))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.equal(r.output, "done", "no report block appended");
	assert.equal(calls, 0, "the knob being off must not spawn any git process at all");
});

test("a leg's cwd nested below the repository top still gets a files-changed block", async () => {
	const repoRoot = tempDir("pi-persona-engine-change-report-");
	mkdirSync(join(repoRoot, ".git"));
	const nested = join(repoRoot, "packages", "app");
	mkdirSync(nested, { recursive: true });
	const engine = createBuildEngine(baseDeps(fakeGit(["", " M src/a.ts\0"]), nested))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.match(r.output, /^done\n\n--- FILES CHANGED DURING THIS LEG/);
	assert.match(r.output, /- src\/a\.ts \(M\)/);
});

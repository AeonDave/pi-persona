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

import { createBuildEngine, type BuildEngineDeps } from "../../../src/extension/engine.ts";
import type { GitExec } from "../../../src/engine/worktree.ts";
import type { AgentResult } from "../../../src/orchestration/types.ts";

const usage = { input: 0, output: 0, turns: 0 } as never;
const okResult = (): AgentResult => ({ agent: "a", output: "done", usage, ok: true });

function baseDeps(gitExec: GitExec): () => BuildEngineDeps {
	const ctx = {
		cwd: process.cwd(),
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
		engineFactories: { makeEngine: () => ({ run: async () => okResult() }) as never, makeInProcessEngine: () => ({ run: async () => okResult() }) as never },
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

test("a failing rev-parse produces no block and does not throw", async () => {
	const engine = createBuildEngine(baseDeps(fakeGit([], { code: 128, stdout: "" })))();
	const r = await engine.run({ agent: "a", task: "t" });
	assert.equal(r.ok, true);
	assert.equal(r.output, "done");
});

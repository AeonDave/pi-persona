import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSDK, type StrategyEngine } from "../../../src/orchestration/sdk.ts";
import { compete } from "../../../src/orchestration/strategies/compete.ts";
import { formatWorktreeRecovery } from "../../../src/core/worktree-recovery.ts";

const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
const recovery = { path: "/private/recover-one", baseCommit: "abc123", reason: "export failed", availability: "retained" as const };

for (const mode of ["winner", "judge-failed", "abort", "no-valid"] as const) {
	test(`compete retains recovery outside the ballot: ${mode}`, async () => {
		const abort = new AbortController();
		let entered = 0;
		let release = (): void => {};
		const allEntered = new Promise<void>((resolve) => { release = resolve; });
		let ballot = "";
		const engine: StrategyEngine = {
			run: async (spec) => {
				if (spec.agent === "arbiter") {
					ballot = spec.task;
					return mode === "judge-failed"
						? { agent: spec.agent, output: "", usage, ok: false, failureKind: "provider", error: "unavailable" }
						: { agent: spec.agent, output: "chosen", structured: { vote: /\[A\][\s\S]*?FULL-two[\s\S]*?\[B\]/.test(spec.task) ? "A" : "B" }, usage, ok: true };
				}
				if (++entered === 2) release();
				await allEntered;
				if (mode === "abort" && spec.agent === "one") abort.abort();
				const body = mode === "no-valid" ? "no diff" : `approach\n\n\`\`\`diff\n+FULL-${spec.agent}\n\`\`\``;
				const output = spec.agent === "one" ? `⚠ Worktree artifact capture failed; the following patch is worker-provided and was not verified against the worktree state.\n\n${formatWorktreeRecovery(recovery)}\n\n${body}` : body;
				return { agent: spec.agent, output, usage, ok: mode !== "no-valid", ...(spec.agent === "one" ? { worktreeRecovery: recovery } : {}) };
			},
		};
		const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 }, signal: abort.signal });
		const result = await compete.run({ task: "T", roster: "team", params: { judge: "arbiter" } }, sdk);
		assert.match(result.output, /\/private\/recover-one/);
		assert.deepEqual(result.structured?.worktreeRecoveries, [{ agent: "one", ...recovery }]);
		assert.doesNotMatch(ballot, /\/private\/recover-one|abc123|export failed/);
		if (ballot) assert.match(ballot, /not verified against the worktree state/);
		if (mode === "winner") {
			assert.equal(result.structured?.winner, "two", "the losing candidate's retained work is still reported");
			assert.match(result.output, /\`\`\`diff\n\+FULL-two\n\`\`\`$/);
		}
		if (mode === "abort") assert.equal(result.failureKind, "abort");
	});
}

test("compete warns when the winner's worker-provided patch was not verified", async () => {
	const engine: StrategyEngine = { async run(spec) {
		if (spec.agent === "arbiter") return { agent: spec.agent, output: "chosen", structured: { vote: /\[A\][\s\S]*?FULL-one[\s\S]*?\[B\]/.test(spec.task) ? "A" : "B" }, usage, ok: true };
		const body = `approach\n\n\`\`\`diff\n+FULL-${spec.agent}\n\`\`\``;
		return { agent: spec.agent, output: spec.agent === "one" ? `⚠ Worktree artifact capture failed; the following patch is worker-provided and was not verified against the worktree state.\n\n${formatWorktreeRecovery(recovery)}\n\n${body}` : body, usage, ok: true, ...(spec.agent === "one" ? { worktreeRecovery: recovery } : {}) };
	} };
	const sdk = makeSDK({ engine, roster: { team: () => ["one", "two"] }, limits: { maxChildren: 8, maxConcurrency: 4, timeoutMs: 1000, budgetTokens: 1000 } });
	const result = await compete.run({ task: "T", roster: "team", params: { judge: "arbiter" } }, sdk);
	assert.equal(result.structured?.winner, "one");
	assert.match(result.output, /not verified against the worktree state/);
	assert.match(result.output, /\`\`\`diff\n\+FULL-one\n\`\`\`$/);
});

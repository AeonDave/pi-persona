import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildEngine, type BuildEngineDeps } from "../../src/extension/engine.ts";
import { defaultGitExec } from "../../src/engine/worktree.ts";
import { emptyUsage } from "../../src/engine/stream.ts";

async function git(...args: string[]): Promise<void> {
	const result = await defaultGitExec(args);
	assert.equal(result.code, 0, result.stderr);
}

test("worktree conversations retain and reuse exactly the isolated checkout, while ordinary workers clean up", { timeout: 30_000 }, async () => {
	const temp = await mkdtemp(join(tmpdir(), "persona-conversation-git-"));
	const repo = join(temp, "repo");
	await mkdir(repo);
	const children: string[] = [];
	let retained = "";
	let uncertainTree = "";
	let mode: "normal" | "fail" | "clean" | "uncertain" = "normal";
	try {
		await git("-C", repo, "init", "--quiet");
		await git("-C", repo, "config", "user.name", "Persona Test");
		await git("-C", repo, "config", "user.email", "persona@example.invalid");
		await git("-C", repo, "config", "core.hooksPath", join(temp, "empty-hooks"));
		await writeFile(join(repo, "file.txt"), "base\n");
		await git("-C", repo, "add", "file.txt");
		await git("-C", repo, "commit", "--quiet", "-m", "baseline");
		const ctx = { cwd: repo, model: { provider: "p", id: "m" }, modelRegistry: { getAll: () => [], getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" } } as unknown as BuildEngineDeps["lastCtx"];
		const deps = (): BuildEngineDeps => ({ agents: [{ name: "a", model: "p/m", systemPrompt: "x", source: "test" }], contractDefs: {}, controller: { activePersona: undefined, capabilities: undefined } as never, host: { getThinkingLevel: () => "high" } as never, config: { engine: "child", broker: false, changeReport: false } as never, personaConfigs: {} as never, lastCtx: ctx, workerSpineText: "", engineFactories: { makeInProcessEngine: () => { throw new Error("unexpected inproc"); }, makeEngine: (options) => ({ run: async (spec) => {
			const cwd = options.cwd!;
			children.push(cwd);
			if (spec.session?.resume) assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), mode === "normal" ? "first\n" : "second\n");
			await writeFile(join(cwd, "file.txt"), mode === "clean" ? "base\n" : spec.session?.resume ? "second\n" : "first\n");
			return { agent: "a", ok: mode !== "fail", output: "done", usage: emptyUsage(), ...(spec.session ? { sessionSaved: mode === "normal" || mode === "clean", sessionQuiescent: mode !== "uncertain" } : {}) };
		} }) }, makeBrokerDeps: () => undefined, userAgentDir: () => temp, childPiSettingsEnv: () => ({}), runLimits: { timeoutMs: 1000 } as never, bus: {} as never, supervisorHandle: "s" });
		const engine = createBuildEngine(deps)(undefined, undefined, { providerFallback: false });
		const file = join(temp, "session.jsonl");
		const first = await engine.run({ agent: "a", task: "first", isolation: "worktree", session: { file, resume: false } });
		assert.equal(first.ok, true, first.error);
		assert.ok(first.sessionWorktree);
		retained = first.sessionWorktree.path;
		assert.equal(existsSync(retained), true);
		assert.match(first.output, /first/);
		await writeFile(join(repo, "unrelated.txt"), "dirty main tree");
		const second = await engine.run({ agent: "a", task: "next", isolation: "worktree", session: { file, resume: true, worktree: first.sessionWorktree } });
		assert.equal(second.ok, true, second.error);
		assert.equal(children[1], retained);
		assert.match(second.output, /second/);
		assert.equal(second.sessionWorktree?.baseCommit, first.sessionWorktree.baseCommit);
		const missing = await engine.run({ agent: "a", task: "next", isolation: "worktree", session: { file, resume: true } });
		assert.equal(missing.ok, false);
		const foreign = await engine.run({ agent: "a", task: "next", isolation: "worktree", session: { file, resume: true, worktree: { ...first.sessionWorktree, root: temp } } });
		assert.equal(foreign.ok, false);
		const escaped = await engine.run({ agent: "a", task: "next", isolation: "none", session: { file, resume: true, worktree: first.sessionWorktree } });
		assert.equal(escaped.ok, false);
		assert.equal(children.length, 2);
		mode = "fail";
		const failed = await engine.run({ agent: "a", task: "next", isolation: "worktree", session: { file, resume: true, worktree: first.sessionWorktree } });
		assert.equal(failed.ok, false);
		assert.equal(failed.sessionSaved, false);
		assert.equal(failed.worktreeRecovery?.path, retained);
		assert.equal(existsSync(retained), true);
		mode = "clean";
		const noArtifact = await engine.run({ agent: "a", task: "next", isolation: "worktree", session: { file, resume: true, worktree: first.sessionWorktree } });
		assert.equal(noArtifact.ok, false);
		assert.equal(noArtifact.sessionSaved, false);
		assert.equal(noArtifact.worktreeRecovery?.path, retained);
		assert.equal(existsSync(retained), true);
		mode = "normal";
		await rm(join(repo, "unrelated.txt"));
		mode = "uncertain";
		const uncertain = await engine.run({ agent: "a", task: "uncertain", isolation: "worktree", session: { file: join(temp, "uncertain.jsonl"), resume: false } });
		assert.equal(uncertain.ok, false);
		assert.equal(uncertain.sessionSaved, false);
		assert.match(uncertain.output, /without capturing an artifact/);
		assert.doesNotMatch(uncertain.output, /ISOLATED WORKTREE ARTIFACT/);
		uncertainTree = uncertain.worktreeRecovery!.path;
		assert.equal(existsSync(uncertainTree), true);
		mode = "normal";
		const ordinary = await engine.run({ agent: "a", task: "ordinary", isolation: "worktree" });
		assert.equal(ordinary.ok, true, ordinary.error);
		assert.equal(existsSync(children[5]!), false);
	} finally {
		if (retained && existsSync(retained)) await defaultGitExec(["-C", repo, "worktree", "remove", "--force", retained]);
		if (uncertainTree && existsSync(uncertainTree)) await defaultGitExec(["-C", repo, "worktree", "remove", "--force", uncertainTree]);
		await rm(temp, { recursive: true, force: true });
	}
});

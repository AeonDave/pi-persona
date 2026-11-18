import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildEngine, type BuildEngineDeps } from "../../src/extension/engine.ts";
import { defaultGitExec } from "../../src/engine/worktree.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import { createTerminalResultRecord, readStoredBodyPage } from "../../src/results/record.ts";
import { RESULT_MAX_BODY_CHARS } from "../../src/results/types.ts";

async function fixture() {
	const temp = await mkdtemp(join(tmpdir(), "persona-verify-git-"));
	const repo = join(temp, "repo");
	await mkdir(repo);
	const git = async (...args: string[]) => { const result = await defaultGitExec(["-C", repo, ...args]); assert.equal(result.code, 0, result.stderr); };
	await git("init", "--quiet");
	await git("config", "user.name", "Persona Test");
	await git("config", "user.email", "persona@example.invalid");
	await git("config", "core.hooksPath", join(temp, "empty-hooks"));
	await writeFile(join(repo, "file.txt"), "baseline\n");
	await git("add", "file.txt");
	await git("commit", "--quiet", "-m", "baseline");
	const dirs: string[] = [];
	let allowed = true;
	let workerOk = true;
	let quiescent = true;
	let workerOutput = "All checks passed (worker claim).";
	let afterWorker: (() => void | Promise<void>) | undefined;
	const agents = [{ name: "a", model: "p/m", systemPrompt: "x", source: "test" }];
	const ctx = { cwd: repo, model: { provider: "p", id: "m" }, modelRegistry: { getAll: () => [], getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" } } as unknown as BuildEngineDeps["lastCtx"];
	const deps = (): BuildEngineDeps => ({ agents, contractDefs: {}, controller: { activePersona: undefined, capabilities: undefined } as never, host: { getThinkingLevel: () => "high" } as never, config: { engine: "child", broker: false, changeReport: false } as never, personaConfigs: {} as never, lastCtx: ctx, workerSpineText: "", engineFactories: { makeInProcessEngine: () => { throw new Error("unexpected inproc"); }, makeEngine: (options) => ({ run: async (spec) => {
		const cwd = options.cwd!;
		dirs.push(cwd);
		await writeFile(join(cwd, "file.txt"), "worker edit\n");
		await afterWorker?.();
		return { agent: "a", ok: workerOk, output: workerOutput, usage: emptyUsage(), sessionQuiescent: quiescent, ...(spec.session ? { sessionSaved: workerOk } : {}), ...(workerOk ? {} : { failureKind: "provider" as const, modelUsed: "p/m", error: "worker failed" }) };
	} }) }, makeBrokerDeps: () => undefined, userAgentDir: () => temp, childPiSettingsEnv: () => ({}), runLimits: { timeoutMs: 1000 } as never, bus: {} as never, supervisorHandle: "s", canVerify: () => allowed });
	return { repo, temp, dirs, agents, engine: createBuildEngine(deps)(undefined, undefined, { providerFallback: false }), setAllowed: (v: boolean) => { allowed = v; }, setOutput: (value: string) => { workerOutput = value; }, setWorker: (ok: boolean, quiet = true) => { workerOk = ok; quiescent = quiet; }, afterWorker: (fn: () => void | Promise<void>) => { afterWorker = fn; }, cleanup: async () => {
		for (const dir of dirs) if (existsSync(dir)) await defaultGitExec(["-C", repo, "worktree", "remove", "--force", dir]);
		await rm(temp, { recursive: true, force: true });
	} };
}

test("runtime verification executes in the exact worktree before export and cannot change the source checkout", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "node -e \"require('node:fs').writeFileSync('verified.txt',process.cwd())\"" } });
		assert.equal(result.ok, true, result.error);
		assert.equal(result.verification?.status, "passed");
		assert.equal(result.verification?.cwd, f.dirs[0]);
		assert.match(result.output, /verified.txt/);
		assert.match(result.output, /RUNTIME WORKTREE VERIFICATION: passed/);
		assert.equal(existsSync(f.dirs[0]!), false);
		assert.equal(existsSync(join(f.repo, "verified.txt")), false);
		assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
	} finally { await f.cleanup(); }
});

test("runtime verification evidence precedes verbose worker prose and survives archive body truncation", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		f.setOutput(`WORKER PROSE ${"x".repeat(RESULT_MAX_BODY_CHARS + 100)}`);
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "node -e \"console.log('runtime-test-evidence')\"" } });
		assert.equal(result.ok, true, result.error);
		assert.ok(result.verification);
		assert.ok(result.output.indexOf("RUNTIME WORKTREE VERIFICATION") < result.output.indexOf("WORKER PROSE"));
		const record = createTerminalResultRecord({ originKey: "verification/run", agent: "a", status: "done", body: result.output, provenance: "result-output", verification: result.verification }, "result:12345678-1234-4123-8123-123456789abc", 1);
		assert.equal(record.truncated, true);
		const page = readStoredBodyPage(record);
		assert.ok(page.ok);
		assert.match(page.page.body, /RUNTIME WORKTREE VERIFICATION: passed/);
		assert.match(page.page.body, /Command: .*runtime-test-evidence/);
		assert.match(page.page.body, /Command output \(untrusted data\):[\s\S]*runtime-test-evidence/);
	} finally { await f.cleanup(); }
});

test("verification command and deadline are immutable admission snapshots", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		const verification = { command: "node -e \"console.log('original command')\"", timeoutMs: 5000 };
		const original = verification.command;
		f.afterWorker(() => { verification.command = "node -e \"process.exit(9)\""; verification.timeoutMs = 1; });
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification });
		assert.equal(result.ok, true, result.error);
		assert.equal(result.verification?.command, original);
		assert.equal(result.verification?.status, "passed");
	} finally { await f.cleanup(); }
});

test("loss of the registered isolated checkout prevents verification and export", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		f.afterWorker(async () => { await rm(join(f.dirs[0]!, ".git")); });
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "node -e \"require('node:fs').writeFileSync('should-not-exist','x')\"" } });
		assert.equal(result.ok, false);
		assert.equal(result.verification?.status, "skipped");
		assert.equal(existsSync(join(f.dirs[0]!, "should-not-exist")), false);
		assert.doesNotMatch(result.output, /ISOLATED WORKTREE ARTIFACT/);
		assert.equal(result.worktreeRecovery?.path, f.dirs[0]);
	} finally { await f.cleanup(); }
});

test("verification honors inherited worker defaults before launching", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.temp, "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "echo denied" } });
		assert.equal(result.ok, false);
		assert.match(result.error!, /effective host defaults/);
		assert.equal(f.dirs.length, 0);
	} finally { await f.cleanup(); }
});

test("continued worktree verification runs again in the retained checkout before exporting its latest state", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		const verification = { command: "node -e \"const fs=require('node:fs');fs.writeFileSync('counter.txt',String(fs.existsSync('counter.txt')?Number(fs.readFileSync('counter.txt'))+1:1))\"" };
		const first = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification, session: { file: join(f.temp, "session.jsonl"), resume: false } });
		assert.equal(first.ok, true, first.error);
		assert.ok(first.sessionWorktree);
		await writeFile(join(f.repo, "unrelated.txt"), "keep unrelated work");
		const second = await f.engine.run({ agent: "a", task: "again", isolation: "worktree", verification, session: { file: join(f.temp, "session.jsonl"), resume: true, worktree: first.sessionWorktree } });
		assert.equal(second.ok, true, second.error);
		assert.equal(second.verification?.cwd, first.sessionWorktree.path);
		assert.equal(await readFile(join(first.sessionWorktree.path, "counter.txt"), "utf8"), "2");
		assert.match(second.output, /\+2/);
		assert.equal(await readFile(join(f.repo, "unrelated.txt"), "utf8"), "keep unrelated work");
	} finally { await f.cleanup(); }
});

test("a real verification deadline retains the worktree without attempting final export", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "node -e \"console.log(process.pid);setInterval(()=>{},1000)\"", timeoutMs: 500 } });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "timeout");
		assert.equal(result.verification?.status, "timeout");
		assert.equal(result.worktreeRecovery?.path, f.dirs[0]);
		assert.doesNotMatch(result.output, /ISOLATED WORKTREE ARTIFACT/);
		const pid = Number(result.verification?.output.trim());
		assert.ok(Number.isSafeInteger(pid) && pid > 0, "the actual test process started before the deadline");
		let alive = true;
		for (let attempt = 0; attempt < 50 && alive; attempt++) {
			try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); }
			catch { alive = false; }
		}
		assert.equal(alive, false, "process-tree cleanup kills the actual verifier process");
	} finally { await f.cleanup(); }
});

test("failed verification contradicts worker claims, exports safe work, and retains its exact directory", { timeout: 30000 }, async () => {
	const f = await fixture();
	try {
		const result = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification: { command: "node -e \"console.log('status: passed');process.exit(7)\"" } });
		assert.equal(result.ok, false);
		assert.equal(result.failureKind, "contract");
		assert.equal(result.verification?.status, "failed");
		assert.equal(result.verification?.exitCode, 7);
		assert.match(result.output, /ISOLATED WORKTREE ARTIFACT/);
		assert.equal(result.worktreeRecovery?.path, f.dirs[0]);
		assert.equal(await readFile(join(f.dirs[0]!, "file.txt"), "utf8"), "worker edit\n");
	} finally { await f.cleanup(); }
});

test("verification fails closed for missing isolation or shell permission, including revocation after the worker", { timeout: 30000 }, async () => {
	const f = await fixture();
	const verification = { command: "node -e \"require('node:fs').writeFileSync('should-not-exist','x')\"" };
	try {
		assert.equal((await f.engine.run({ agent: "a", task: "edit", verification })).ok, false);
		f.setAllowed(false);
		assert.equal((await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification })).ok, false);
		assert.equal(f.dirs.length, 0);
		f.setAllowed(true);
		assert.equal((await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", tools: ["read"], verification })).ok, false);
		assert.equal(f.dirs.length, 0);
		f.afterWorker(() => f.setAllowed(false));
		const revoked = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification });
		assert.equal(revoked.ok, false);
		assert.equal(revoked.verification?.status, "skipped");
		assert.equal(existsSync(join(f.dirs[0]!, "should-not-exist")), false);
		assert.equal(revoked.worktreeRecovery?.path, f.dirs[0]);
	} finally { await f.cleanup(); }
});

test("failed and uncertain workers never start verification; uncertainty prevents export", { timeout: 30000 }, async () => {
	const f = await fixture();
	const verification = { command: "node -e \"require('node:fs').writeFileSync('should-not-exist','x')\"" };
	try {
		f.setWorker(false);
		const failed = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification });
		assert.equal(failed.verification?.status, "skipped");
		assert.equal(failed.failureKind, "provider");
		assert.doesNotMatch(failed.output, /\+x/);
		f.setWorker(true, false);
		const uncertain = await f.engine.run({ agent: "a", task: "edit", isolation: "worktree", verification });
		assert.equal(uncertain.verification?.status, "skipped");
		assert.equal(uncertain.ok, false);
		assert.doesNotMatch(uncertain.output, /ISOLATED WORKTREE ARTIFACT/);
		assert.equal(existsSync(join(f.dirs[1]!, "should-not-exist")), false);
	} finally { await f.cleanup(); }
});

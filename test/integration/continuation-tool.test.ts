import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkerConversations } from "../../src/extension/conversations.ts";
import type { AgentRunSpec } from "../../src/orchestration/sdk.ts";
import type { AgentResult } from "../../src/orchestration/types.ts";
import { specOf } from "../../src/tools/delegate.ts";
import { withModelFallback } from "../../src/engine/fallback.ts";
import { registerIntercomTool, type IntercomToolDeps } from "../../src/tools/intercom-tool.ts";
import { emptyUsage } from "../../src/engine/stream.ts";

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "persona-conversation-runtime-"));
	const entries: unknown[] = [];
	const file = join(cwd, "supervisor.jsonl");
	writeFileSync(file, "supervisor");
	let persona: string | null = "engineer";
	let fingerprint = "a".repeat(64);
	let policyFails = false;
	let denied = false;
	const ctx = { cwd, sessionManager: { getSessionId: () => "owner", getSessionFile: () => file, getLeafId: () => null, getEntries: () => entries, getBranch: () => entries } } as unknown as ExtensionContext;
	let current: ExtensionContext | undefined = ctx;
	let appendFails = false;
	const pi = { appendEntry: (customType: string, data: unknown) => { if (appendFails) throw new Error("append failed"); entries.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const runtime = new WorkerConversations(pi, { currentContext: () => current, persona: () => persona,
		fingerprint: () => { if (policyFails) throw new Error("policy temporarily unavailable"); return fingerprint; },
		gate: () => denied ? "target not allowed" : undefined });
	const spec: AgentRunSpec = { agent: "scout", task: "inspect", name: "atlas", role: "audit", tools: ["read"], skills: ["review"], model: "native/model", thinking: "high" };
	const result: AgentResult = { agent: "scout", ok: true, output: "first report", modelUsed: "native/model", thinkingRequested: "high", sessionSaved: true, usage: emptyUsage() };
	const brief = { objective: "inspect", scopeRoe: "repository", position: "supervisor", constraints: "read only", requiredArtifacts: "report", stopConditions: "unsafe" };
	function start() {
		const turn = runtime.start(ctx, spec, brief);
		assert.ok(turn);
		const prepared = turn.prepare(spec);
		assert.ok(prepared.session);
		writeFileSync(prepared.session.file, "worker transcript\n");
		const receipt = turn.settle("run-1", prepared, result);
		turn.release();
		return { receipt, file: prepared.session.file };
	}
	return { cwd, ctx, runtime, spec, result, brief, start, setPersona: (s: string | null) => { persona = s; }, changeDefinition: () => { fingerprint = "b".repeat(64); }, deny: () => { denied = true; }, switchOwner: () => { current = undefined; }, failAppend: () => { appendFails = true; }, setPolicyFailure: (value: boolean) => { policyFails = value; }, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("a policy exception before a fresh turn is built releases its unused storage reservation", () => {
	const h = fixture();
	try {
		h.setPolicyFailure(true);
		const turn = h.runtime.start(h.ctx, h.spec, h.brief);
		assert.ok(turn);
		assert.equal(turn.prepare(h.spec).session, undefined, "ordinary delegation remains available without continuation storage");
		assert.deepEqual(readdirSync(h.cwd, { recursive: true }).filter((path) => String(path).endsWith(".lock")), [], "failed construction must leave no unowned lease");
	} finally { h.close(); }
});

test("a policy exception after resume acquisition releases the saved conversation for another attempt", () => {
	const h = fixture();
	try {
		h.start();
		h.setPolicyFailure(true);
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "again" }).ok, false);
		h.setPolicyFailure(false);
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "retry admission" });
		assert.ok(resumed.ok, "failed policy validation must not leave the saved worker busy");
		resumed.value.turn.release();
	} finally { h.close(); }
});

test("continuation retains worker identity, configuration and provider while preserving prior report", () => {
	const h = fixture();
	try {
		const { receipt, file } = h.start();
		assert.match(receipt.output, /resume: "run-1"/);
		assert.deepEqual(h.runtime.entries(h.ctx), [{ id: "run-1", label: "atlas", available: true }]);
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "check again" });
		assert.ok(resumed.ok);
		assert.deepEqual(resumed.value.params.brief, h.brief);
		for (const key of ["name", "role", "tools", "skills", "model", "thinking"] as const) assert.deepEqual(resumed.value.params[key], h.spec[key]);
		const second = resumed.value.turn.prepare(specOf(resumed.value.params as AgentRunSpec));
		assert.equal(second.session?.file, file);
		assert.equal(second.session?.resume, true);
		appendFileSync(file, "follow-up transcript\n");
		const report = resumed.value.turn.settle("run-2", second, { ...h.result, output: "second report" });
		resumed.value.turn.release();
		assert.match(report.output, /run-2/);
		assert.match(receipt.output, /first report/);
		assert.doesNotMatch(receipt.output, /second report/);
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "again" }).ok, false);
		assert.equal(h.runtime.list(h.ctx)[0]?.runId, "run-2");
	} finally { h.close(); }
});

test("continuation retains its verification command and rejects replacing it in a resume request", () => {
	const h = fixture();
	try {
		h.spec.verification = { command: "node check.cjs", timeoutMs: 5_000 };
		h.start();
		const override = h.runtime.resume(h.ctx, { resume: "run-1", task: "check again", verification: { command: "echo bypass" } });
		assert.equal(override.ok, false);
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "check again" });
		assert.ok(resumed.ok);
		assert.deepEqual(resumed.value.params.verification, h.spec.verification);
		assert.deepEqual(specOf(resumed.value.params as AgentRunSpec).verification, h.spec.verification);
		resumed.value.turn.release();
	} finally { h.close(); }
});

for (const change of ["persona", "target", "definition"] as const) {
	test(`continuation rejects changed ${change} before worker admission`, () => {
		const h = fixture();
		try {
			h.start();
			if (change === "persona") h.setPersona("reviewer");
			if (change === "target") h.deny();
			if (change === "definition") h.changeDefinition();
			assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "again" }).ok, false);
			assert.deepEqual(h.runtime.list(h.ctx), []);
		} finally { h.close(); }
	});
}

test("a queued continuation excludes duplicate acquisition and is not advertised as available", () => {
	const h = fixture();
	try {
		h.start();
		const first = h.runtime.resume(h.ctx, { resume: "run-1", task: "first follow-up" });
		assert.ok(first.ok);
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "duplicate" }).ok, false);
		assert.deepEqual(h.runtime.list(h.ctx), []);
		const entry = h.runtime.entries(h.ctx)[0];
		assert.equal(entry?.id, "run-1");
		assert.equal(entry?.available, false);
		assert.ok(entry?.reason);
		first.value.turn.release();
		assert.equal(h.runtime.list(h.ctx)[0]?.runId, "run-1");
	} finally { h.close(); }
});

test("an admitted worker remains unavailable until its session is quiescent", () => {
	const h = fixture();
	try {
		h.start();
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "continue" });
		assert.ok(resumed.ok);
		const spec = resumed.value.turn.prepare(specOf(resumed.value.params as AgentRunSpec));
		assert.deepEqual(h.runtime.list(h.ctx), []);
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "duplicate" }).ok, false);
		resumed.value.turn.settle("run-2", spec, { ...h.result, ok: false, sessionSaved: false, sessionQuiescent: true, failureKind: "abort" });
		resumed.value.turn.release();
		assert.equal(h.runtime.list(h.ctx)[0]?.runId, "run-1");
	} finally { h.close(); }
});

test("failed resumed turns cannot be advertised as successful continuations", () => {
	const h = fixture();
	try {
		const { file } = h.start();
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "again" });
		assert.ok(resumed.ok);
		const spec = resumed.value.turn.prepare(specOf(resumed.value.params as AgentRunSpec));
		appendFileSync(file, "failed partial turn\n");
		const failure = resumed.value.turn.settle("run-2", spec, { ...h.result, ok: false, sessionSaved: false, sessionQuiescent: true, output: "failed", failureKind: "provider" });
		resumed.value.turn.release();
		assert.doesNotMatch(failure.output, /Continue this worker/);
		assert.deepEqual(h.runtime.list(h.ctx), []);
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-2", task: "again" }).ok, false);
	} finally { h.close(); }
});

test("policy drift while queued rejects admission and releases the lease", () => {
	const h = fixture();
	try {
		h.start();
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "again" });
		assert.ok(resumed.ok);
		h.changeDefinition();
		assert.throws(() => resumed.value.turn.prepare(specOf(resumed.value.params as AgentRunSpec)), /configuration changed/i);
		resumed.value.turn.release();
		assert.equal(h.runtime.resume(h.ctx, { resume: "run-1", task: "again" }).ok, false);
	} finally { h.close(); }
});

test("provider failure in a continuation never retries the transcript on another route", async () => {
	const h = fixture();
	try {
		h.start();
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "again" });
		assert.ok(resumed.ok);
		const spec = resumed.value.turn.prepare(specOf(resumed.value.params as AgentRunSpec));
		const attempts: string[] = [];
		const engine = withModelFallback({ async run(actual) { attempts.push(actual.model ?? ""); return { ...h.result, ok: false, sessionSaved: false, sessionQuiescent: true, failureKind: "provider" as const }; } }, { models: [{ provider: "native", id: "model" }, { provider: "alternative", id: "model" }], allowCrossProviderFallback: true });
		const result = await engine.run(spec);
		assert.equal(result.ok, false);
		assert.deepEqual(attempts, ["native/model"]);
		resumed.value.turn.settle("run-2", spec, result);
		resumed.value.turn.release();
	} finally { h.close(); }
});

test("intercom exposes ready and busy conversations and forgets the selected conversation", async () => {
	const h = fixture();
	try {
		h.start();
		let tool!: { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }>; isError: boolean }> };
		const pi = { registerTool: (definition: typeof tool) => { tool = definition; } } as unknown as ExtensionAPI;
		registerIntercomTool(pi, { conversations: h.runtime } as IntercomToolDeps);
		const call = (action: string, to?: string) => tool.execute("call", { action, ...(to ? { to } : {}) }, undefined, undefined, h.ctx);
		assert.match((await call("conversations")).content[0]!.text, /run-1.*atlas.*ready to continue/);
		const resumed = h.runtime.resume(h.ctx, { resume: "run-1", task: "continue" });
		assert.ok(resumed.ok);
		assert.match((await call("conversations")).content[0]!.text, /run-1.*unavailable/);
		assert.equal((await call("forget", "run-1")).isError, true);
		resumed.value.turn.release();
		assert.equal((await call("forget", "run-1")).isError, false);
		assert.match((await call("conversations")).content[0]!.text, /No saved worker conversations/);
	} finally { h.close(); }
});

for (const failure of ["owner switch", "append failure"] as const) {
	test(`retained worktree recovery remains visible after ${failure}`, () => {
		const h = fixture();
		try {
			const turn = h.runtime.start(h.ctx, h.spec, h.brief);
			assert.ok(turn);
			const spec = turn.prepare(h.spec);
			assert.ok(spec.session);
			writeFileSync(spec.session.file, "completed transcript\n");
			const worktreePath = join(h.cwd, "retained-worktree");
			mkdirSync(worktreePath);
			if (failure === "owner switch") h.switchOwner();
			else h.failAppend();
			const result = turn.settle("run-1", spec, { ...h.result, sessionWorktree: { path: worktreePath, root: h.cwd, baseCommit: "a".repeat(40) } });
			turn.release();
			assert.notEqual(result.sessionSaved, true);
			assert.ok(result.worktreeRecovery, "retained workspace must have recovery metadata");
			assert.match(result.output, /retained-worktree/);
			assert.doesNotMatch(result.output, /Continue this worker/);
			assert.deepEqual(h.runtime.list(h.ctx), []);
		} finally { h.close(); }
	});
}

for (const phase of ["admission", "settlement"] as const) {
	test(`conversation stays on its original branch at ${phase}`, () => {
		const dir = mkdtempSync(join(tmpdir(), "persona-conversation-branch-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const common = manager.appendMessage({ role: "user", content: "common", timestamp: 1 });
			manager.appendMessage({ role: "user", content: "branch A", timestamp: 2 });
			const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionContext;
			const pi = { appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) } as unknown as ExtensionAPI;
			const runtime = new WorkerConversations(pi, { currentContext: () => ctx, persona: () => null, fingerprint: () => "a".repeat(64), gate: () => undefined });
			const spec: AgentRunSpec = { agent: "scout", task: "inspect" };
			const turn = runtime.start(ctx, spec);
			assert.ok(turn);
			const prepared = phase === "settlement" ? turn.prepare(spec) : undefined;
			if (prepared?.session) writeFileSync(prepared.session.file, "transcript\n");
			manager.branch(common);
			manager.appendMessage({ role: "user", content: "branch B", timestamp: 3 });
			if (phase === "admission") assert.throws(() => turn.prepare(spec), /branch/i);
			else {
				const result = turn.settle("run-1", prepared!, { agent: "scout", ok: true, output: "done", usage: emptyUsage(), modelUsed: "native/model", sessionSaved: true, sessionQuiescent: true });
				assert.equal(result.sessionSaved, false);
				assert.doesNotMatch(result.output, /Continue this worker/);
				assert.deepEqual(runtime.list(ctx), []);
			}
			turn.release();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}

test("ordinary progress on the original branch keeps a worker resumable", () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-conversation-advance-"));
	try {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionContext;
		const pi = { appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) } as unknown as ExtensionAPI;
		const runtime = new WorkerConversations(pi, { currentContext: () => ctx, persona: () => null, fingerprint: () => "a".repeat(64), gate: () => undefined });
		const spec: AgentRunSpec = { agent: "scout", task: "inspect" };
		const turn = runtime.start(ctx, spec);
		assert.ok(turn);
		manager.appendMessage({ role: "user", content: "continued on same branch", timestamp: 2 });
		const prepared = turn.prepare(spec);
		assert.ok(prepared.session);
		writeFileSync(prepared.session.file, "transcript\n");
		manager.appendMessage({ role: "user", content: "more progress", timestamp: 3 });
		const result = turn.settle("run-1", prepared, { agent: "scout", ok: true, output: "done", usage: emptyUsage(), modelUsed: "native/model", sessionSaved: true, sessionQuiescent: true });
		turn.release();
		assert.equal(result.sessionSaved, true);
		assert.equal(runtime.list(ctx)[0]?.runId, "run-1");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forget never writes cleanup metadata onto a different branch during worktree removal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "persona-forget-branch-"));
	const worktree = mkdtempSync(join(tmpdir(), "pi-persona-wt-"));
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
	try {
		git("-C", dir, "init", "-q");
		writeFileSync(join(dir, "base"), "data");
		git("-C", dir, "add", "base");
		git("-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
		const baseCommit = git("-C", dir, "rev-parse", "HEAD").trim();
		git("-C", dir, "worktree", "add", "--detach", worktree, "HEAD");
		const manager = SessionManager.create(dir, dir);
		const common = manager.appendMessage({ role: "user", content: "common", timestamp: 1 });
		const branchA = manager.appendMessage({ role: "user", content: "branch A", timestamp: 2 });
		const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionContext;
		const pi = { appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) } as unknown as ExtensionAPI;
		const runtime = new WorkerConversations(pi, { currentContext: () => ctx, persona: () => null, fingerprint: () => "a".repeat(64), gate: () => undefined });
		const spec: AgentRunSpec = { agent: "scout", task: "inspect" };
		const turn = runtime.start(ctx, spec)!;
		const prepared = turn.prepare(spec);
		writeFileSync(prepared.session!.file, "transcript\n");
		turn.settle("run-1", prepared, { agent: "scout", ok: true, output: "done", usage: emptyUsage(), modelUsed: "native/model", sessionSaved: true, sessionQuiescent: true, sessionWorktree: { path: worktree, root: dir, baseCommit } });
		turn.release();
		const receipt = manager.getLeafId()!;
		const forgetting = runtime.forget(ctx, "run-1");
		manager.branch(common);
		manager.appendMessage({ role: "user", content: "branch B", timestamp: 3 });
		const result = await forgetting;
		assert.equal(result.ok, false);
		assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-persona:conversation-forgotten:v1"), false);
		manager.branch(receipt);
		assert.equal((await runtime.forget(ctx, "run-1")).ok, true, `cleanup can be finalized on branch A after ${branchA}`);
	} finally { rmSync(worktree, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

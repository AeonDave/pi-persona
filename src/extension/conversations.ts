import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConversationStore } from "../conversations/store.ts";
import type { ConversationLease, ConversationRecord, ConversationResult } from "../conversations/types.ts";
import type { AgentRunSpec } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { DelegateParams, DelegationBrief } from "../tools/delegate.ts";
import { removeConversationWorktree } from "../engine/conversation-worktree.ts";
import { formatWorktreeRecovery } from "../core/worktree-recovery.ts";

function unretained(result: AgentResult, reason: string): AgentResult {
	const worktreeRecovery = result.sessionWorktree ? {
		path: result.sessionWorktree.path, baseCommit: result.sessionWorktree.baseCommit,
		reason, availability: "retained" as const,
	} : result.worktreeRecovery;
	const note = worktreeRecovery ? formatWorktreeRecovery(worktreeRecovery) : reason;
	return { ...result, sessionSaved: false, ...(worktreeRecovery ? { worktreeRecovery } : {}), output: `${result.output}\n\n[pi-persona] ${note}` };
}

export function validateResumeRequest(input: Record<string, unknown>): string | undefined {
	if (typeof input.resume !== "string" || !/^run-[a-z0-9-]{1,80}$/i.test(input.resume)) return "delegate resume requires an exact prior run id.";
	if (typeof input.task !== "string" || !input.task.trim()) return "delegate resume requires a nonempty new task.";
	if (Object.keys(input).some((key) => !["resume", "task", "brief"].includes(key))) return "delegate resume accepts only resume, task and an optional brief; configuration overrides require a new worker.";
	return undefined;
}

/** Stable hashes include sets explicitly; JSON's ordinary Set serialization would hide permissions. */
export function conversationFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => v instanceof Set ? [...v].sort() : v)).digest("hex");
}

export interface ConversationTurn {
	readonly previous: ConversationRecord | undefined;
	prepare(spec: AgentRunSpec): AgentRunSpec;
	settle(id: string, spec: AgentRunSpec, result: AgentResult): AgentResult;
	release(): void;
}

export interface ConversationRuntimeDeps {
	persona(): string | null;
	fingerprint(spec: AgentRunSpec): string;
	gate(spec: AgentRunSpec): string | undefined;
	currentContext(): ExtensionContext | undefined;
}

/** One adapter for native owner identity, saved worker records and continuation admission. */
export class WorkerConversations {
	constructor(privatePi: ExtensionAPI, privateDeps: ConversationRuntimeDeps) { this.pi = privatePi; this.deps = privateDeps; }
	private readonly pi: ExtensionAPI;
	private readonly deps: ConversationRuntimeDeps;

	private store(ctx: ExtensionContext): ConversationStore {
		const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile();
		const branchAnchor = ctx.sessionManager.getLeafId();
		return new ConversationStore({
			sessionId, sessionFile,
			entries: () => ctx.sessionManager.getEntries(), append: (type, data) => {
				const current = this.deps.currentContext();
				if (!current || current.sessionManager.getSessionId() !== sessionId || current.sessionManager.getSessionFile() !== sessionFile) throw new Error("Supervisor session changed before conversation metadata could be saved");
				if (branchAnchor !== null && !current.sessionManager.getBranch().some((entry) => entry.id === branchAnchor)) throw new Error("Supervisor branch changed before conversation metadata could be saved");
				this.pi.appendEntry(type, data);
			},
			removeWorktree: (record) => record.worktree ? removeConversationWorktree(record.worktree, record.cwd) : Promise.resolve({ ok: true }),
		});
	}

	list(ctx: ExtensionContext): ConversationRecord[] {
		try { return this.store(ctx).list(ctx.sessionManager.getBranch()).filter((r) => this.valid(ctx, r) === undefined); }
		catch { return []; }
	}

	entries(ctx: ExtensionContext): { id: string; label: string; available: boolean; reason?: string }[] {
		try {
			return this.store(ctx).listAll(ctx.sessionManager.getBranch()).map(({ record, available, reason }) => {
				const invalid = this.valid(ctx, record) ?? reason;
				return { id: record.runId, label: record.spec.name ?? record.spec.agent, available: available && !invalid, ...(invalid ? { reason: invalid } : {}) };
			});
		} catch { return []; }
	}

	forget(ctx: ExtensionContext, runId: string): Promise<ConversationResult<true>> {
		return this.store(ctx).forget(runId, ctx.sessionManager.getBranch());
	}

	resume(ctx: ExtensionContext, input: Record<string, unknown>): ConversationResult<{ params: DelegateParams; turn: ConversationTurn }> {
		const error = validateResumeRequest(input);
		if (error) return { ok: false, code: "invalid", error };
		let pendingLease: ConversationLease | undefined;
		try {
			const acquired = this.store(ctx).acquire(input.resume as string, ctx.sessionManager.getBranch());
			if (!acquired.ok) return acquired;
			const { record, lease } = acquired.value;
			pendingLease = lease;
			const invalid = this.valid(ctx, record);
			if (invalid) return { ok: false, code: "changed", error: invalid };
			const brief = input.brief as Partial<DelegationBrief> | undefined ?? record.brief;
			const spec: AgentRunSpec = { ...record.spec, model: record.model, task: input.task as string,
				...(record.thinking ? { thinking: record.thinking } : {}) };
			const turn = this.turn(ctx, lease, spec, brief, record);
			pendingLease = undefined;
			return { ok: true, value: { params: { ...spec, ...(brief ? { brief } : {}) }, turn } };
		} catch (e) { return { ok: false, code: "storage", error: `Conversation unavailable: ${String(e)}` }; }
		finally { pendingLease?.release(); }
	}

	start(ctx: ExtensionContext, spec: AgentRunSpec, brief?: Partial<DelegationBrief>): ConversationTurn | undefined {
		const unavailable = (reason: string): ConversationTurn => ({
			previous: undefined, prepare: (input) => input,
			settle: (_id, _spec, result) => unretained(result, `Continuation unavailable: ${reason}`), release: () => {},
		});
		let pendingLease: ConversationLease | undefined;
		try {
			if (!ctx.sessionManager.getSessionFile()) return undefined;
			const created = this.store(ctx).create();
			if (!created.ok) return unavailable(created.error);
			pendingLease = created.value;
			const turn = this.turn(ctx, created.value, spec, brief);
			pendingLease = undefined;
			return turn;
		} catch (error) { return unavailable(String(error)); } // persistence must not prevent an ordinary new delegation
		finally { pendingLease?.release(); }
	}

	private valid(ctx: ExtensionContext, record: ConversationRecord): string | undefined {
		if (resolve(ctx.cwd) !== resolve(record.cwd) || this.deps.persona() !== record.persona) return "The worker belongs to a different workspace or persona; start a new worker.";
		const blocked = this.deps.gate(record.spec);
		if (blocked) return blocked;
		if (this.deps.fingerprint(record.spec) !== record.fingerprint) return "Worker definition, policy, tools, spine or output contract changed; start a new worker.";
		return undefined;
	}

	private turn(ctx: ExtensionContext, lease: ConversationLease, original: AgentRunSpec, brief?: Partial<DelegationBrief>, previous?: ConversationRecord): ConversationTurn {
		const fingerprint = this.deps.fingerprint(original);
		const persona = this.deps.persona();
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const branchAnchor = ctx.sessionManager.getLeafId();
		const inOriginalBranch = (current: ExtensionContext): boolean => {
			try { return branchAnchor === null || current.sessionManager.getBranch().some((entry) => entry.id === branchAnchor); }
			catch { return false; }
		};
		let admitted = false;
		let quiescent = false;
		return {
			previous,
			prepare: (spec) => {
				const current = this.deps.currentContext();
				if (!current || current.sessionManager.getSessionId() !== sessionId || current.sessionManager.getSessionFile() !== sessionFile) throw new Error("Supervisor session changed before worker admission");
				if (!inOriginalBranch(current)) throw new Error("Supervisor branch changed before worker admission");
				if (this.deps.persona() !== persona || this.deps.fingerprint(original) !== fingerprint) throw new Error("Worker configuration changed while queued; launch again under the current policy");
				const blocked = this.deps.gate(spec);
				if (blocked) throw new Error(blocked);
				admitted = true;
				return { ...spec, session: { file: lease.file, resume: previous !== undefined, ...(previous?.worktree ? { worktree: previous.worktree } : {}) } };
			},
			settle: (id, spec, result) => {
				quiescent = result.sessionSaved === true || result.sessionQuiescent === true;
				const current = this.deps.currentContext();
				if (!result.ok || result.worktreeRecovery) return result;
				if (!result.sessionSaved || !result.modelUsed) return unretained(result, "The worker completed, but its conversation could not be retained for continuation.");
				if (current?.sessionManager.getSessionId() !== sessionId || current.sessionManager.getSessionFile() !== sessionFile) return unretained(result, "Supervisor session changed before the worker conversation could be retained.");
				if (!inOriginalBranch(current)) return unretained(result, "Supervisor branch changed before the worker conversation could be retained.");
				const { session: _session, resultRefs: _refs, peers: _peers, ...savedSpec } = spec;
				const saved = lease.commit({
					rootRunId: previous?.rootRunId ?? id, runId: id, ...(previous ? { previousRunId: previous.runId } : {}),
					cwd: ctx.cwd, persona, fingerprint, spec: savedSpec, ...(brief ? { brief } : {}), model: result.modelUsed,
					...(result.thinkingRequested ? { thinking: result.thinkingRequested } : {}),
					...(result.sessionWorktree ? { worktree: result.sessionWorktree } : {}),
				});
				if (!saved.ok) return unretained(result, `Worker conversation could not be retained: ${saved.error}`);
				return { ...result, output: `${result.output}\n\n[pi-persona] Continue this worker with delegate { resume: "${id}", task: "<follow-up>" }.` };
			},
			release: () => { if (!admitted || quiescent) lease.release(); },
		};
	}
}

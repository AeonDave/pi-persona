import type { ThinkingLevel } from "../core/types.ts";
import type { ConversationWorktree } from "../core/worktree-recovery.ts";
import type { AgentRunSpec } from "../orchestration/sdk.ts";
import type { DelegationBrief } from "../tools/delegate.ts";
import type { ConversationHistory } from "./history.ts";
import type { WorkerSession } from "../engine/worker-session.ts";

export type ConversationSpec = Omit<AgentRunSpec, "peers" | "resultRefs" | "session">;
export interface ConversationCommit {
	rootRunId: string;
	runId: string;
	previousRunId?: string;
	cwd: string;
	persona: string | null;
	fingerprint: string;
	spec: ConversationSpec;
	brief?: Partial<DelegationBrief>;
	model: string;
	thinking?: ThinkingLevel;
	updatedAt?: number;
	worktree?: ConversationWorktree;
}
export interface ConversationRecord extends ConversationCommit {
	key: string;
	owner: string;
	transcriptHash: string;
	updatedAt: number;
}
export type ConversationResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };
export interface ConversationLease {
	readonly key: string;
	readonly file: string;
	setExternalWriter: NonNullable<WorkerSession["setExternalWriter"]>;
	commit(fields: ConversationCommit): ConversationResult<ConversationRecord>;
	release(): void;
}
export interface ConversationStoreDeps {
	sessionId: string;
	sessionFile: string | undefined;
	entries: () => readonly unknown[];
	nativeHistory?: ConversationHistory;
	append: (type: string, data: unknown) => void;
	now?: () => number;
	removeWorktree?: (record: ConversationRecord) => Promise<{ ok: true } | { ok: false; error: string }>;
}
export interface ConversationListing { record: ConversationRecord; available: boolean; reason?: string }

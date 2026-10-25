/** Exact metadata for one engine attempt; display hints are never participant identities. */
import type { ThinkingLevel } from "../core/types.ts";

export interface AgentAttemptIdentity {
	readonly agent: string;
	readonly role?: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
}

/** Copy primitives only: no task, tool grants, result references or mutable caller object. */
export function agentAttemptIdentity(spec: AgentAttemptIdentity): AgentAttemptIdentity {
	return Object.freeze({ agent: spec.agent, ...(spec.role !== undefined ? { role: spec.role } : {}),
		...(spec.model !== undefined ? { model: spec.model } : {}), ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}) });
}

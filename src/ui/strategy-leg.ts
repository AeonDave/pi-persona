/** Model intent for live strategy rows, resolved from exact attempt identity and frozen run settings. */
import { isThinkingLevel, type ThinkingLevel } from "../core/types.ts";
import type { AgentAttemptIdentity } from "../orchestration/agent-attempt.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { participantKey } from "../persona/model-participants.ts";

export interface StrategyModels {
	readonly assigned: Readonly<Record<string, string>>;
	readonly agents: Readonly<Record<string, string>>;
	readonly sessionModel?: string;
}

export function snapshotStrategyModels(input: { assigned?: Record<string, string>; agents: readonly { name: string; model?: string }[]; sessionModel?: string }): StrategyModels {
	return Object.freeze({ assigned: Object.freeze({ ...input.assigned }),
		agents: Object.freeze(Object.fromEntries(input.agents.flatMap((a) => a.model ? [[a.name, a.model]] : []))),
		...(input.sessionModel ? { sessionModel: input.sessionModel } : {}) });
}

export interface StrategyLegMetadata {
	agent: string;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	thinkingEffective: ThinkingLevel | undefined;
}

/** A bare observed id preserves a known provider only when it exactly names the same requested id. */
function observedModel(observed: string | undefined, requested: string | undefined): string | undefined {
	const value = observed?.trim();
	if (!value) return requested;
	if (!value.includes("/") && requested?.includes("/") && requested.slice(requested.indexOf("/") + 1) === value) return requested;
	return value;
}

export function strategyLegMetadata(identity: AgentAttemptIdentity, models: StrategyModels, result?: AgentResult): StrategyLegMetadata {
	const requested = identity.model ?? models.assigned[participantKey(identity.agent, identity.role)]
		?? models.assigned[identity.agent] ?? models.agents[identity.agent] ?? models.sessionModel;
	return { agent: identity.agent, model: observedModel(result?.modelUsed, requested),
		thinking: isThinkingLevel(result?.thinkingRequested) ? result.thinkingRequested : identity.thinking,
		thinkingEffective: isThinkingLevel(result?.thinkingEffective) ? result.thinkingEffective : undefined };
}

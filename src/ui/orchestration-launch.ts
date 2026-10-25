/** Persisted orchestration launch requests. Rendering never consults live persona or model settings. */
import { resolveLegThinking } from "../core/leg-thinking.ts";
import type { ThinkingLevel } from "../core/types.ts";
import type { ModelParticipant, ModelSource } from "../persona/model-participants.ts";
import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";

export interface OrchestrationLaunchParticipant {
	key: string;
	label: string;
	agent: string;
	model?: string;
	modelSource: ModelSource;
	thinkingRequested?: ThinkingLevel;
	setupPending: boolean;
	param?: string;
	phase?: string;
}

export interface OrchestrationLaunchSnapshot {
	participants: OrchestrationLaunchParticipant[];
	unavailable?: true;
}

export function snapshotOrchestrationParticipants(
	participants: readonly ModelParticipant[],
	opts: { agentThinking(agent: string): ThinkingLevel | undefined; childThinking: unknown; pendingKeys: ReadonlySet<string> },
): OrchestrationLaunchSnapshot {
	return { participants: participants.map((p) => {
		const agentThinking = opts.agentThinking(p.agent);
		const thinkingRequested = resolveLegThinking(p, agentThinking ? { thinking: agentThinking } : {}, opts.childThinking);
		return { key: p.key, label: p.label, agent: p.agent, modelSource: p.source, setupPending: !p.assigned && opts.pendingKeys.has(p.key),
			...(p.model ? { model: p.model } : {}), ...(thinkingRequested ? { thinkingRequested } : {}), ...(p.param ? { param: p.param } : {}) };
	}) };
}

/** Three individually bounded rows collapsed; expansion retains every participant and full model ref. */
export function orchestrationLaunchLines(snapshot: OrchestrationLaunchSnapshot | undefined, expanded: boolean): string[] {
	if (!snapshot || snapshot.unavailable) return ["Launch metadata unavailable"];
	const rows = expanded ? snapshot.participants : snapshot.participants.slice(0, 3);
	const lines = rows.map((p) => {
		const clean = (value: string, maxChars: number): string => expanded ? sanitizeTerminalText(value) : compactInlineText(value, { maxChars });
		const label = clean(`${p.phase ? `${p.phase} / ` : ""}${p.label}${p.param ? ` [${p.param}]` : ""}`, 48);
		const model = p.model ? clean(p.model, 64) : "unknown";
		const modelText = p.setupPending ? `model pending (current default ${model}; setup may change)` : `requested model ${model}`;
		return `  ${label} · ${modelText} · requested effort ${p.thinkingRequested ?? "unknown"}`;
	});
	if (!expanded && snapshot.participants.length > rows.length) lines.push(`  +${snapshot.participants.length - rows.length} more · expand for launch details`);
	return lines;
}

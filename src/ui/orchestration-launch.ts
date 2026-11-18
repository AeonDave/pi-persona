/** Persisted orchestration launch requests. Rendering never consults live persona or model settings. */
import { resolveLegThinking } from "../core/leg-thinking.ts";
import type { ThinkingLevel } from "../core/types.ts";
import type { ModelParticipant, ModelSource } from "../persona/model-participants.ts";
import { shortModel } from "../tools/delegate.ts";
import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";
import { hiddenLaunchRequestHint, launchRequestLines, snapshotLaunchRequest, type LaunchRequest } from "./launch-request.ts";
import { modelEffortText } from "./model-effort.ts";
import type { KeybindingHints } from "@earendil-works/pi-coding-agent";

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
	request?: LaunchRequest;
	unavailable?: true;
}

/** Freeze caller inputs independently of participant lookup; a display failure cannot lose the task. */
export function withOrchestrationRequest(snapshot: OrchestrationLaunchSnapshot | undefined, request: LaunchRequest): OrchestrationLaunchSnapshot {
	return { ...(snapshot ?? { participants: [], unavailable: true }),
		participants: snapshot?.participants.map((participant) => ({ ...participant })) ?? [],
		request: snapshotLaunchRequest(request),
	};
}

export function snapshotOrchestrationParticipants(
	participants: readonly ModelParticipant[],
	opts: { agentThinking(agent: string): ThinkingLevel | undefined; childThinking: unknown; pendingKeys: ReadonlySet<string>; request?: LaunchRequest },
): OrchestrationLaunchSnapshot {
	return { participants: participants.map((p) => {
		const agentThinking = opts.agentThinking(p.agent);
		const thinkingRequested = resolveLegThinking(p, agentThinking ? { thinking: agentThinking } : {}, opts.childThinking);
		return { key: p.key, label: p.label, agent: p.agent, modelSource: p.source, setupPending: !p.assigned && opts.pendingKeys.has(p.key),
			...(p.model ? { model: p.model } : {}), ...(thinkingRequested ? { thinkingRequested } : {}), ...(p.param ? { param: p.param } : {}) };
	}), ...(opts.request ? { request: snapshotLaunchRequest(opts.request) } : {}) };
}

/** The delegate launch grammar, one row per participant: `<member> · <model> · <effort>`. Collapsed
 *  shows three bounded rows with the short model, and a model the operator has yet to pick reads
 *  `model pending`; expansion keeps every participant, the full model ref and the pending
 *  explanation. Unknown model or effort is omitted ({@link modelEffortText}). */
export function orchestrationLaunchLines(snapshot: OrchestrationLaunchSnapshot | undefined, expanded: boolean, hints?: Pick<KeybindingHints, "keyHint">): string[] {
	if (!snapshot) return ["Launch metadata unavailable"];
	const rows = expanded ? snapshot.participants : snapshot.participants.slice(0, 3);
	const lines = snapshot.unavailable ? ["Launch metadata unavailable"] : rows.map((p) => {
		const clean = (value: string, maxChars: number): string => expanded ? sanitizeTerminalText(value) : compactInlineText(value, { maxChars });
		const label = clean(`${p.phase ? `${p.phase} / ` : ""}${p.label}${p.param ? ` [${p.param}]` : ""}`, 48);
		const model = p.model ? clean(expanded ? p.model : shortModel(p.model), 64) : "";
		const modelText = !p.setupPending ? model : expanded && model ? `model pending (current default ${model}; setup may change)` : "model pending";
		return `  ${[label, modelEffortText(modelText, p.thinkingRequested)].filter(Boolean).join(" · ")}`;
	});
	if (!expanded && snapshot.participants.length > rows.length) lines.push(`  +${snapshot.participants.length - rows.length} more · expand for launch details`);
	if (snapshot.request) {
		if (expanded) lines.push(...launchRequestLines(snapshot.request));
		else lines.push(`  ${hiddenLaunchRequestHint(snapshot.request, hints)}`);
	}
	return lines;
}

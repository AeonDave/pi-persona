/**
 * Persona delegation/tool gating — pure. The `tool_call` hook consults the
 * persona's resolved `EffectiveCapabilities` (built once on activation) so every
 * tool call / delegate target passes the same unified, deny-wins gate (I4).
 * Delegate target extraction reads structured params (`agent` / `tasks[].agent`),
 * never fragile text parsing.
 */

import { canCallTool, canDelegateTo, type EffectiveCapabilities } from "../core/capabilities.ts";

/** Pull the delegate target agent names out of a delegate tool call's input. */
export function extractDelegateTargets(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const o = input as Record<string, unknown>;
	const targets: string[] = [];
	if (typeof o.agent === "string") targets.push(o.agent);
	if (Array.isArray(o.tasks)) {
		for (const t of o.tasks) {
			if (t && typeof t === "object" && typeof (t as Record<string, unknown>).agent === "string") {
				targets.push((t as Record<string, unknown>).agent as string);
			}
		}
	}
	return targets;
}

export interface GateResult {
	block: true;
	reason: string;
}

/** Decide whether a tool call is blocked by the active capabilities; undefined = allow. */
export function gateToolCall(
	caps: EffectiveCapabilities,
	personaLabel: string,
	toolName: string,
	input: unknown,
	delegateTool = "delegate",
): GateResult | undefined {
	if (!canCallTool(caps, toolName)) {
		return { block: true, reason: `Persona "${personaLabel}" may not use tool: ${toolName}.` };
	}
	if (toolName !== delegateTool) return undefined;

	const blocked = extractDelegateTargets(input).filter((t) => !canDelegateTo(caps, t));
	if (blocked.length > 0) {
		return { block: true, reason: `Persona "${personaLabel}" may not delegate to: ${blocked.join(", ")}.` };
	}
	return undefined;
}

/**
 * Persona delegation/tool gating — pure. Because the `delegate` tool has
 * structured params, target extraction reads `agent` / `tasks[].agent` directly
 * (no fragile text parsing, unlike the old persona over pi-subagents). The
 * extension's `tool_call` hook calls `gateToolCall` and returns its result.
 */

import { isAllowed } from "../core/permissions.ts";
import type { Persona } from "./persona.ts";

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

/** Decide whether a tool call is blocked by the active persona; undefined = allow. */
export function gateToolCall(
	persona: Persona,
	toolName: string,
	input: unknown,
	delegateDefaultAllow: boolean,
	delegateTool = "delegate",
): GateResult | undefined {
	if (persona.tools && !isAllowed(toolName, persona.tools)) {
		return { block: true, reason: `Persona "${persona.label}" may not use tool: ${toolName}.` };
	}
	if (toolName !== delegateTool) return undefined;

	const blocked = extractDelegateTargets(input).filter((t) => !isAllowed(t, persona.delegate, delegateDefaultAllow));
	if (blocked.length > 0) {
		return { block: true, reason: `Persona "${persona.label}" may not delegate to: ${blocked.join(", ")}.` };
	}
	return undefined;
}

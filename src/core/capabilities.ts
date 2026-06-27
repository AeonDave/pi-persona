/**
 * EffectiveCapabilities — the single, runtime-enforced capability gate.
 *
 * Pure module. Unifies the persona/agent glob layers into one resolved object that
 * every tool call and delegate must pass (guardrails I4: capabilities enforced at call
 * time, never prompt-only). Run *limits* are a separate concern, enforced by the
 * engine/SDK via {@link RunLimits} — not part of this call-time tool/delegate gate.
 */

import { isAllowed, type Permission } from "./permissions.ts";

export interface RunLimits {
	maxChildren: number;
	maxDepth: number;
	maxConcurrency: number;
	timeoutMs: number;
	budgetTokens: number;
}

export interface CapabilityPermissions {
	tools?: Permission;
	delegate?: Permission;
}

export interface CapabilityInputs {
	allToolNames: string[];
	knownAgents: string[];
	permissions: CapabilityPermissions;
	/** The tool name used to delegate (default `delegate`). */
	delegateTool?: string;
	/** Meaning of an absent `delegate` block (default `true` = sees everyone). */
	delegateDefaultAllow?: boolean;
}

export interface EffectiveCapabilities {
	tools: ReadonlySet<string>;
	delegateTargets: ReadonlySet<string>;
}

const DEFAULT_DELEGATE_TOOL = "delegate";

/** A name is *explicitly* denied iff a `deny` block exists and matches it. */
function explicitlyDenied(name: string, perm: Permission | undefined): boolean {
	return perm?.deny !== undefined && !isAllowed(name, { deny: perm.deny }, true);
}

export function resolveCapabilities(input: CapabilityInputs): EffectiveCapabilities {
	const delegateTool = input.delegateTool ?? DEFAULT_DELEGATE_TOOL;
	const delegateDefaultAllow = input.delegateDefaultAllow ?? true;
	const toolsPerm = input.permissions.tools;

	const tools = new Set(input.allToolNames.filter((n) => isAllowed(n, toolsPerm, true)));
	// Restricting `tools` must NOT silently drop delegation: keep the delegate tool
	// under an allowlist unless the persona explicitly denied it.
	if (input.allToolNames.includes(delegateTool) && !explicitlyDenied(delegateTool, toolsPerm)) {
		tools.add(delegateTool);
	}

	// Fan-out authorization is structural: a persona can spawn iff it holds the delegate
	// tool. Its delegate targets are only meaningful when it can.
	const canSpawn = tools.has(delegateTool);
	const delegateTargets = new Set(
		canSpawn ? input.knownAgents.filter((a) => isAllowed(a, input.permissions.delegate, delegateDefaultAllow)) : [],
	);

	return { tools, delegateTargets };
}

/** Whether the persona may fan out — derived from holding the delegate tool. */
export function canFanOut(caps: EffectiveCapabilities, delegateTool = DEFAULT_DELEGATE_TOOL): boolean {
	return caps.tools.has(delegateTool);
}

export function canCallTool(caps: EffectiveCapabilities, toolName: string): boolean {
	return caps.tools.has(toolName);
}

export function canDelegateTo(caps: EffectiveCapabilities, agent: string): boolean {
	return caps.delegateTargets.has(agent);
}

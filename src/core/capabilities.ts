/**
 * EffectiveCapabilities — the single, runtime-enforced capability gate.
 *
 * Pure module. Unifies the persona/agent/settings glob layers into one resolved
 * object that every tool call, delegate, and bus/transport action must pass
 * (guardrails I4: capabilities enforced at call time, never prompt-only).
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
	skills?: Permission;
}

export interface CapabilityInputs {
	allToolNames: string[];
	knownAgents: string[];
	knownSkills?: string[];
	permissions: CapabilityPermissions;
	limits: RunLimits;
	/** The tool name used to delegate (default `delegate`). */
	delegateTool?: string;
	/** Meaning of an absent `delegate` block (default `true` = sees everyone). */
	delegateDefaultAllow?: boolean;
	canUseBus?: boolean;
	canUseProcessTransport?: boolean;
}

export interface EffectiveCapabilities {
	tools: ReadonlySet<string>;
	delegateTargets: ReadonlySet<string>;
	skills: ReadonlySet<string>;
	canSpawn: boolean;
	canUseBus: boolean;
	canUseProcessTransport: boolean;
	limits: RunLimits;
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

	const canSpawn = tools.has(delegateTool);
	const delegateTargets = new Set(
		canSpawn
			? input.knownAgents.filter((a) => isAllowed(a, input.permissions.delegate, delegateDefaultAllow))
			: [],
	);

	const skills = new Set((input.knownSkills ?? []).filter((s) => isAllowed(s, input.permissions.skills, true)));

	return {
		tools,
		delegateTargets,
		skills,
		canSpawn,
		canUseBus: input.canUseBus ?? false,
		canUseProcessTransport: input.canUseProcessTransport ?? true,
		limits: input.limits,
	};
}

export function canCallTool(caps: EffectiveCapabilities, toolName: string): boolean {
	return caps.tools.has(toolName);
}

export function canDelegateTo(caps: EffectiveCapabilities, agent: string): boolean {
	return caps.delegateTargets.has(agent);
}

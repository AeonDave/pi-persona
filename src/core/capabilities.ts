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
	/** The semantic bus (intercom / contact_peer). ON unless the persona EXPLICITLY denies
	 *  the `intercom` tool — a persona that opted out of the bus also opts its children out
	 *  of sibling peer messaging. An allowlist that merely omits intercom is NOT a denial. */
	canUseBus: boolean;
	/** The persona's raw tool allow/deny — kept so the gate can evaluate a tool by NAME against the
	 *  persona's ACTUAL rules, not only the activation-time `tools` snapshot (which misses tools
	 *  registered — or MCP-reconnected — AFTER activation; MCP servers connect async and re-register
	 *  their tools on every reconnect, which would otherwise fail-closed against the stale snapshot). */
	toolsPerm?: Permission;
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

	const canUseBus = !explicitlyDenied("intercom", toolsPerm);
	return { tools, delegateTargets, canUseBus, ...(toolsPerm !== undefined ? { toolsPerm } : {}) };
}

/** Whether the persona may fan out — derived from holding the delegate tool. */
export function canFanOut(caps: EffectiveCapabilities, delegateTool = DEFAULT_DELEGATE_TOOL): boolean {
	return caps.tools.has(delegateTool);
}

export const EXOCOM_TOOL_NAMES = ["exocom_list", "exocom_send", "exocom_name", "exocom_claim", "exocom_ask", "exocom_answer", "exocom_decline", "exocom_wait", "exocom_release", "exocom_progress"] as const;
const EXOCOM_TOOLS: ReadonlySet<string> = new Set(EXOCOM_TOOL_NAMES);

export function canCallTool(caps: EffectiveCapabilities, toolName: string): boolean {
	// Bus revocation must win even after these dynamically registered tools have entered
	// `caps.tools` on a later persona activation. Checking the ordinary set first would make
	// an allow -> deny switch keep the external bus callable.
	if (EXOCOM_TOOLS.has(toolName)) return caps.canUseBus && !explicitlyDenied(toolName, caps.toolsPerm);
	// Evaluate the persona's ACTUAL allow/deny against the NAME — not only the activation-time
	// `caps.tools` snapshot. The snapshot is built from the tools registered AT activation, so it
	// fails closed on any tool that registers later: an MCP server connects asynchronously and
	// re-registers ALL its tools on every reconnect, so any unrestricted persona that used
	// `mcpwn_execute_command` a moment ago is suddenly told it "may not use" it after a reconnect.
	// Checking the persona's rule by name fixes that (no allowlist ⇒ any tool; an allow/deny still
	// governs regardless of registration timing). `caps.tools` still covers the `delegate`
	// special-case (kept under a restrictive allowlist even though the allowlist never names it).
	if (isAllowed(toolName, caps.toolsPerm, true)) return true;
	return caps.tools.has(toolName);
}

export function canDelegateTo(caps: EffectiveCapabilities, agent: string): boolean {
	return caps.delegateTargets.has(agent);
}

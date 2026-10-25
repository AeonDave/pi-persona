/**
 * The frozen `read_result` admission rule (flow reference handoff, contract 4) — ONE helper
 * shared by BOTH engine backends, so the child-process and in-process paths can never drift.
 *
 * effective tools = spec.tools ?? cfg.tools. An explicit `[]` denies. A nonempty allowlist
 * must already include `read` OR `read_result` (the grant builds on a leg that can read —
 * it never widens a write-only specialist into a reader). Any deny (agent `excludeTools`,
 * wildcards included) matching either name denies. The parent's `canUseBus` capability must
 * be true for reference mode at all; explicit parent denies always win. Only after a grant:
 * the literal `read_result` joins a nonempty allowlist; an absent allowlist stays absent
 * (session defaults + the injected custom tool).
 */

import { isAllowed } from "../core/permissions.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { emptyUsage } from "./stream.ts";

/** The literal, never-renamed tool a reference-handoff leg reads archived results through. */
export const RESULT_READ_TOOL = "read_result";

export interface ResultToolAdmission {
	specTools: readonly string[] | undefined;
	cfgTools: readonly string[] | undefined;
	/** The agent's own deny list (glob patterns allowed — the same matcher Pi's permission
	 *  layer uses, so a `read*` deny here means what it means everywhere else). */
	excludeTools: readonly string[] | undefined;
	/** The persona-level bus capability (`EffectiveCapabilities.canUseBus`). */
	canUseBus: boolean;
}

export type ResultToolGrant =
	| { ok: false; error: string }
	/** `tools` is the effective allowlist to run the leg with: undefined = an absent
	 *  allowlist stays absent (session default + custom-tool injection). */
	| { ok: true; tools: string[] | undefined };

export function admitResultReadTool(input: ResultToolAdmission): ResultToolGrant {
	if (!input.canUseBus) {
		return { ok: false, error: "reference handoff requires the bus capability (this persona denies it)" };
	}
	const tools = input.specTools ?? input.cfgTools;
	if (tools !== undefined && tools.length === 0) {
		return { ok: false, error: "reference handoff requires the read tool; this leg's tool allowlist is empty" };
	}
	// Denies are evaluated by NAME against both spellings, wildcards included, before any
	// allowlist reasoning — an explicit deny always wins over the grant below.
	const deny = { deny: [...(input.excludeTools ?? [])] };
	if (!isAllowed("read", deny) || !isAllowed(RESULT_READ_TOOL, deny)) {
		return { ok: false, error: "reference handoff requires the read tool; read/read_result is denied for this leg" };
	}
	if (tools !== undefined && !tools.includes("read") && !tools.includes(RESULT_READ_TOOL)) {
		return { ok: false, error: `reference handoff requires the read or ${RESULT_READ_TOOL} tool; the allowlist names neither` };
	}
	if (tools === undefined) return { ok: true, tools: undefined };
	return { ok: true, tools: [...new Set([...tools, RESULT_READ_TOOL])] };
}

/** A reference-handoff preflight rejection: ZERO usage (nothing ran), terminal for the leg,
 *  listing what is missing so the caller can report it honestly. */
export function referenceHandoffFailure(agent: string, error: string): AgentResult {
	return { agent, output: "", usage: emptyUsage(), ok: false, error: `[${agent}] ${error}`, failureKind: "contract" };
}

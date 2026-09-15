/**
 * Run-spec preflight failures shared by BOTH engine backends (child adapter + in-process).
 * A spec that names an agent or an output contract that is not installed must fail before
 * anything spawns, and the message must let the caller self-correct: it names what IS
 * installed. One wording, one cap, so the two engines can never drift apart again.
 */

import type { AgentResult } from "../orchestration/types.ts";
import { emptyUsage } from "./stream.ts";

/** Names shown in a self-correcting hint before the list is elided. */
const HINT_CAP = 12;

/** `" — installed agents: a, b, …"`; empty when nothing is installed (no misleading hint). */
export function installedHint(kind: "agents" | "contracts", names: string[]): string {
	if (names.length === 0) return "";
	const shown = names.slice(0, HINT_CAP).join(", ");
	return ` — installed ${kind}: ${shown}${names.length > HINT_CAP ? ", …" : ""}`;
}

export function unknownAgentFailure(agent: string, installed: string[]): AgentResult {
	return {
		agent,
		output: "",
		usage: emptyUsage(),
		ok: false,
		error: `[${agent}] unknown agent (not found in registry)${installedHint("agents", installed)}`,
		failureKind: "unknown-agent",
	};
}

export function unknownContractFailure(agent: string, requested: string, installed: string[]): AgentResult {
	return {
		agent,
		output: "",
		usage: emptyUsage(),
		ok: false,
		error: `[${agent}] output contract "${requested}" not found${installedHint("contracts", installed)}`,
		failureKind: "contract",
	};
}

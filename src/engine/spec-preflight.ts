/**
 * Run-spec preflight failures shared by BOTH engine backends (child adapter + in-process).
 * A spec that names an agent or an output contract that is not installed must fail before
 * anything spawns, and the message must let the caller self-correct: it names what IS
 * installed. One wording, one cap, so the two engines can never drift apart again.
 */

import { cappedList } from "../core/format.ts";
import type { AgentResult, FailureKind } from "../orchestration/types.ts";
import { emptyUsage } from "./stream.ts";

/** Names shown in a self-correcting hint before the list is elided. */
const HINT_CAP = 12;

/** `" — installed agents: a, b, …"`; empty when nothing is installed (no misleading hint). */
export function installedHint(kind: "agents" | "contracts", names: string[]): string {
	if (names.length === 0) return "";
	return ` — installed ${kind}: ${cappedList(names, HINT_CAP)}`;
}

/** The result skeleton both preflight rejections share; only the error text and failureKind
 *  differ between "unknown agent" and "unknown contract". */
function failure(agent: string, error: string, failureKind: FailureKind): AgentResult {
	return { agent, output: "", usage: emptyUsage(), ok: false, error, failureKind };
}

export function unknownAgentFailure(agent: string, installed: string[]): AgentResult {
	return failure(agent, `[${agent}] unknown agent (not found in registry)${installedHint("agents", installed)}`, "unknown-agent");
}

export function unknownContractFailure(agent: string, requested: string, installed: string[]): AgentResult {
	return failure(agent, `[${agent}] output contract "${requested}" not found${installedHint("contracts", installed)}`, "contract");
}

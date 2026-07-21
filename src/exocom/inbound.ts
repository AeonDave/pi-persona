/**
 * Pure inbound-delivery decision for exocom — isolates every guardrail (hop cap, dedup,
 * per-sender budget, inject truncation) plus the fence/attribute step from all I/O, so the
 * whole chain is unit-testable without a live plane (test/unit/exocom/inbound.test.ts).
 *
 * `fence`/`attribute` are injected rather than imported directly: `extension.ts` wires the
 * real `fenceUntrusted`/`attributeInbound` (src/core/fence.ts) at the call site. Attribution
 * MUST come from the caller's `resolvedLabel` (the registry-resolved identity) — this module
 * never reads `msg.from_name`, which is the envelope's own self-report and not to be trusted
 * (a peer could otherwise spoof its sender for attribution purposes).
 */
import { truncateForInject, type ExocomMessage } from "./envelope.ts";
import type { SeenMessages, SenderBudget } from "./guards.ts";
import { EXOCOM } from "./limits.ts";

export interface InboundDeps {
	budget: SenderBudget;
	seen: SeenMessages;
	injectMaxBytes: number;
	fence: (t: string) => string;
	attribute: (label: string, t: string) => string;
}

export type InboundDecision = { deliver: string } | { drop: "budget" | "dup" | "hops" };

/** Apply the guardrails IN ORDER — hop cap, dedup, budget, truncate, fence+attribute — and
 *  return either the ready-to-deliver follow-up text or a drop reason. */
export function buildInboundDelivery(msg: ExocomMessage, resolvedLabel: string, deps: InboundDeps): InboundDecision {
	if (msg.hops > EXOCOM.MAX_HOPS) return { drop: "hops" };
	if (deps.seen.seenBefore(msg.from_session, msg.msg_id)) return { drop: "dup" };
	if (!deps.budget.allow(msg.from_session, Buffer.byteLength(msg.text, "utf8"))) return { drop: "budget" };
	const { text } = truncateForInject(msg.text, deps.injectMaxBytes);
	return { deliver: deps.attribute(resolvedLabel, deps.fence(text)) };
}

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
import { fencePeer } from "../core/fence.ts";

export interface InboundDeps {
	budget: SenderBudget;
	seen: SeenMessages;
	injectMaxBytes: number;
	fence: (t: string) => string;
	attribute: (label: string, t: string) => string;
}

export type InboundDecision = { deliver: string } | { duplicate: true } | { drop: "budget" | "hops" };

function routingToken(value: string): string {
	return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "invalid";
}

function headerLabel(value: string, fallback: string): string {
	const clean = value
		.normalize("NFKC")
		.replace(/[\r\n\t\u0000-\u001F\u007F-\u009F]+/g, " ")
		.replace(/[^A-Za-z0-9 ._@#()\/+:-]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 96);
	return clean || fallback;
}

/** Apply the guardrails IN ORDER — hop cap, dedup, budget, truncate, fence+attribute — and
 *  return either the ready-to-deliver follow-up text or a drop reason. */
export function buildInboundDelivery(msg: ExocomMessage, resolvedLabel: string, deps: InboundDeps): InboundDecision {
	if (!Number.isInteger(msg.hops) || msg.hops < 0 || msg.hops > EXOCOM.MAX_HOPS) return { drop: "hops" };
	if (deps.seen.seenBefore(msg.from_session, msg.msg_id)) return { duplicate: true };
	if (!deps.budget.allow(msg.from_session, Buffer.byteLength(msg.text, "utf8"))) return { drop: "budget" };
	const { text } = truncateForInject(msg.text, deps.injectMaxBytes);
	const msgId = routingToken(msg.msg_id);
	const label = headerLabel(resolvedLabel, "unknown");
	const target = headerLabel(label.replace(/\s+\([^)]*\)$/, ""), "peer");
  const kind = msg.in_reply_to === undefined ? "message" : "reply";
  const peerBlock = fencePeer(deps.fence(text));
  const quotedBody = peerBlock.slice(peerBlock.indexOf("\n") + 1);
  const reply = `Reply: exocom_send({ target:"${target}", message:"...", in_reply_to:"${msgId}" })`;
  return {
    deliver: `[${label}] — ${kind}\nPeer data · untrusted equal-status collaborator:\n${quotedBody}\n${reply}`,
  };
}

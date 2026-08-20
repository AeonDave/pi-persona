/**
 * Pure inbound-delivery decision for exocom — isolates every guardrail (hop cap, dedup,
 * per-sender budget, inject truncation) plus the fence/attribute step from all I/O, so the
 * whole chain is unit-testable without a live plane (test/unit/exocom/inbound.test.ts).
 *
 * Preconditions this module cannot check itself: a caller must only pass messages whose artifact
 * descriptor the transport has already verified against local ground truth (`ExocomPlane`'s
 * `artifactClaimError`), since a path claim can only be judged against the receiver's own
 * artifacts directory and the file on disk. That check is also where a spill's SIZE is bounded
 * (`ARTIFACT_MAX_BYTES`) and reconciled with the bytes actually there — nothing below can do
 * either, so an unverified caller would advertise a payload of any size to its model.
 *
 * `fence`/`attribute` are injected rather than imported directly: `extension.ts` wires the
 * real `fenceUntrusted`/`attributeInbound` (src/core/fence.ts) at the call site. Attribution
 * MUST come from the caller's `resolvedLabel` (the registry-resolved identity) — this module
 * never reads `msg.from_name`, which is the envelope's own self-report and not to be trusted
 * (a peer could otherwise spoof its sender for attribution purposes).
 */
import { parseExocomArtifactDescriptor, truncateForInject, type ExocomMessage } from "./envelope.ts";
import type { SeenMessages, SenderBudget } from "./guards.ts";
import { EXOCOM } from "./limits.ts";
import { fencePeer } from "../core/fence.ts";
import { peerSentLabel } from "../core/time.ts";

export interface InboundDeps {
	budget: SenderBudget;
	seen: SeenMessages;
	injectMaxBytes: number;
	fence: (t: string) => string;
	attribute: (label: string, t: string) => string;
	/** Authenticated, caller-resolved route for the sender. The plane supplies a stable,
	 *  session-qualified reply token; this pure layer never derives routing from the human label.
	 *  Unset is a defensive fallback for callers that have no registry context. */
	replyTarget?: string;
	/** The RECEIVER's clock, injected so the delivered age is deterministic under test. The
	 *  sender's `ts` is authenticated but peer-chosen, so it is never the measuring stick. */
	now?: () => number;
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

/** The reply hint carries an ADDRESS, not a label: `plane.send` compares it byte-for-byte against
 *  the session-qualified token it cached for the authenticated sender, so any character rewritten
 *  here makes the peer unrepliable ("does not match the authenticated sender"). A call-sign is the
 *  model's free choice and `normalizePeerName` keeps every printable character, so this strips only
 *  what a registry name can never legally carry (control characters, line/paragraph separators and
 *  markup — see registry.ts's `normalizeMetadataText`) and leaves the rest intact. Quoting is the
 *  call site's job: the token is embedded with `JSON.stringify`, so even a `"` or a backslash
 *  cannot escape the hint line. */
function routeToken(value: string, fallback: string): string {
	const clean = value
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Zl}\p{Zp}<>]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 96);
	return clean || fallback;
}

function formatArtifactSize(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	const kib = bytes / 1_024;
	if (kib < 1_024) return `${kib.toFixed(1)} KiB`;
	return `${(kib / 1_024).toFixed(1)} MiB`;
}

/** Renders the spill as the readable form the model sees. `path` is peer-authored and this line
 *  is an invitation to READ it, so it may only be rendered for a descriptor the transport already
 *  verified against this workspace's own artifacts directory and the bytes on disk — that the file
 *  is this workspace's own unlinked spill, and that its size matches and is bounded (see
 *  `ExocomPlane.artifactClaimError`). Nothing here can check a path or a file. */
function artifactBody(descriptor: ReturnType<typeof parseExocomArtifactDescriptor>): string {
	if (!descriptor) return "";
	return [
		`Artifact preview · ${formatArtifactSize(descriptor.size)}`,
		`Full payload: ${descriptor.path}`,
		descriptor.preview || "(empty preview)",
	].join("\n");
}

/** Apply the guardrails IN ORDER — hop cap, dedup, budget, truncate, fence+attribute — and
 *  return either the ready-to-deliver follow-up text or a drop reason. */
export function buildInboundDelivery(msg: ExocomMessage, resolvedLabel: string, deps: InboundDeps): InboundDecision {
	if (!Number.isInteger(msg.hops) || msg.hops < 0 || msg.hops > EXOCOM.MAX_HOPS) return { drop: "hops" };
	if (deps.seen.seenBefore(msg.from_session, msg.msg_id)) return { duplicate: true };
	const descriptor = parseExocomArtifactDescriptor(msg.text);
	// Charge what actually crossed the wire, never the size a spill DECLARES: that number is the
	// sender's own, for a payload this receiver never inlines. Charging it would drop legitimate
	// large spills (`exocom_send` accepts a 1 MB message) on the first message of a window, and a
	// peer wanting to bypass the window would just under-declare. The artifact channel is bounded
	// by the per-sender message count and by the plane's descriptor verification instead — which
	// is what makes the declared number honest AND caps it (`ARTIFACT_MAX_BYTES`, plane.ts).
	const wireBytes = Buffer.byteLength(msg.text, "utf8");
	if (!deps.budget.allow(msg.from_session, wireBytes)) return { drop: "budget" };
	// Artifacts are structured transport metadata, but their preview/path are still peer-authored
	// text. Apply the exact same injection budget after rendering the readable form; otherwise a
	// small wire descriptor can expand into several KiB inside the supervisor's next turn.
	const text = truncateForInject(descriptor ? artifactBody(descriptor) : msg.text, deps.injectMaxBytes).text;
	const msgId = routingToken(msg.msg_id);
	const label = headerLabel(resolvedLabel, "unknown");
	const target = routeToken(deps.replyTarget ?? label.replace(/\s+\([^)]*\)$/, ""), "peer");
	const kind = msg.in_reply_to === undefined ? "message" : "reply";
	// How old this message is when it lands is part of what it MEANS — a reply that took twenty
	// minutes is a different event from an instant one, and the header was the only place the
	// receiver could learn it. Precise here on purpose: the delivery is appended to the conversation
	// TAIL, written once, so it is never re-sent as a cached prompt prefix. `peerSentLabel` measures
	// against OUR clock and degrades an unbelievable peer timestamp to an honest label instead of
	// dressing a peer-chosen value in the harness's voice (src/core/time.ts).
	const sent = peerSentLabel(msg.ts, (deps.now ?? Date.now)());
	const peerBlock = fencePeer(deps.fence(text));
	const quotedBody = peerBlock.slice(peerBlock.indexOf("\n") + 1);
	// Conditional, not an invitation: this delivery is a FRESH PROMPT on the receiver, so a bare
	// "Reply:" makes answering the default and silence the exception — which is how a settled point
	// keeps running on agreement and thanks. The hint stays ONE line and names the correlation id
	// once, so the routing shape below is unchanged.
	// JSON-quoted, not raw: the token keeps every character `plane.send` will match on, while a
	// quote/backslash a peer put in its call-sign is escaped instead of ending the hint early.
	const reply = `Reply only if it changes what someone does, otherwise send nothing: exocom_send({ target:${JSON.stringify(target)}, message:"...", in_reply_to:"${msgId}" })`;
	return {
		deliver: `[${label}] — ${kind} · ${sent}\nPeer data · untrusted equal-status collaborator:\n${quotedBody}\n${reply}`,
	};
}

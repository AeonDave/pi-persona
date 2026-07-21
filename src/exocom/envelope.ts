/** exocom wire envelopes + validators + truncation. Pure. */
export interface AgentCard { name: string; persona: string; model: string; context_pct: number; inbox: number; }
export interface ExocomMessage {
	kind: "message"; msg_id: string; from_session: string; from_endpoint: string; from_name: string;
	text: string; in_reply_to?: string; hops: number; ts: string;
}
export interface ExocomPing { kind: "ping"; msg_id: string; from_session: string; from_endpoint: string; }
export interface ExocomPong { kind: "pong"; msg_id: string; card: AgentCard; }
export interface ExocomBye { kind: "bye"; from_session: string; }
export interface ExocomAck { kind: "ack"; msg_id: string; }
export interface ExocomNack { kind: "nack"; msg_id: string; error: string; }
export type ExocomFrame = ExocomMessage | ExocomPing | ExocomPong | ExocomBye | ExocomAck | ExocomNack;

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Fail-closed structural validation of an inbound frame (R5). */
export function isExocomFrame(v: unknown): v is ExocomFrame {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	switch (o.kind) {
		case "message":
			return str(o.msg_id) && str(o.from_session) && str(o.from_endpoint) && str(o.from_name)
				&& str(o.text) && num(o.hops) && str(o.ts) && (o.in_reply_to === undefined || str(o.in_reply_to));
		case "ping": return str(o.msg_id) && str(o.from_session) && str(o.from_endpoint);
		case "pong": return str(o.msg_id) && !!o.card && typeof o.card === "object";
		case "bye": return str(o.from_session);
		case "ack": return str(o.msg_id);
		case "nack": return str(o.msg_id) && str(o.error);
		default: return false;
	}
}

export function nextHops(current: number): number { return current + 1; }

const NOTICE = "\n\n…[exocom: truncated — read the artifact or ask the sender for the rest]";
/** Head-truncate to a UTF-8 byte budget, adding a notice when cut (R1). */
export function truncateForInject(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
	// back off to a valid UTF-8 boundary
	let end = buf.length;
	while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
	return { text: buf.subarray(0, end).toString("utf8") + NOTICE, truncated: true };
}

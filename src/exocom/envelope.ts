/** exocom wire envelopes + validators + truncation. Pure. */
export interface AgentCard { name: string; persona: string; model: string; context_pct: number; inbox: number; }
export interface ExocomMessage {
	kind: "message"; msg_id: string; from_session: string; from_endpoint: string; from_name: string;
	text: string; in_reply_to?: string; hops: number; ts: string; signature?: string;
}
/** The only structured text payload the receiver interprets specially. The marker and exact
 * field set keep arbitrary peer-authored JSON as ordinary untrusted message text. */
export interface ExocomArtifactDescriptor {
	kind: "exocom_artifact";
	preview: string;
	path: string;
	size: number;
}
export interface ExocomBye { kind: "bye"; from_session: string; from_endpoint?: string; signature?: string; }
export interface ExocomAck { kind: "ack"; msg_id: string; from_session?: string; signature?: string; }
export interface ExocomNack { kind: "nack"; msg_id: string; error: string; from_session?: string; signature?: string; }
export type ExocomFrame = ExocomMessage | ExocomBye | ExocomAck | ExocomNack;

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bounded = (v: unknown, max: number): v is string => str(v) && v.length > 0 && v.length <= max;
const token = (v: unknown): v is string => bounded(v, 128) && /^[A-Za-z0-9._:-]+$/.test(v);
const optionalBounded = (v: unknown, max: number): boolean => v === undefined || bounded(v, max);

/** Fail-closed structural validation of an inbound frame (R5). */
export function isExocomFrame(v: unknown): v is ExocomFrame {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	switch (o.kind) {
		case "message":
			return token(o.msg_id) && token(o.from_session) && bounded(o.from_endpoint, 1_024) && bounded(o.from_name, 256)
				&& str(o.text) && Number.isInteger(o.hops) && num(o.hops) && o.hops >= 0 && bounded(o.ts, 128)
				&& (o.in_reply_to === undefined || token(o.in_reply_to)) && optionalBounded(o.signature, 512);
		case "bye":
			return token(o.from_session) && optionalBounded(o.from_endpoint, 1_024) && optionalBounded(o.signature, 512);
		case "ack":
			return token(o.msg_id) && optionalBounded(o.from_session, 128) && optionalBounded(o.signature, 512);
		case "nack":
			return token(o.msg_id) && bounded(o.error, 512) && optionalBounded(o.from_session, 128) && optionalBounded(o.signature, 512);
		default: return false;
	}
}

/** Stable representation signed by an exocom instance. The signature field itself is excluded. */
export function frameSigningPayload(frame: ExocomFrame): string {
	switch (frame.kind) {
		case "message":
			return JSON.stringify([frame.kind, frame.msg_id, frame.from_session, frame.from_endpoint, frame.from_name,
				frame.text, frame.in_reply_to ?? null, frame.hops, frame.ts]);
		case "bye": return JSON.stringify([frame.kind, frame.from_session, frame.from_endpoint ?? null]);
		case "ack": return JSON.stringify([frame.kind, frame.msg_id, frame.from_session ?? null]);
		case "nack": return JSON.stringify([frame.kind, frame.msg_id, frame.error, frame.from_session ?? null]);
	}
}

export function nextHops(current: number): number { return current + 1; }

const NOTICE = "\n\n…[exocom: truncated — ask the sender for the rest]";
/** Head-truncate to a UTF-8 byte budget, adding a notice when cut (R1). */
export function truncateForInject(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const budget = Math.max(0, Math.floor(maxBytes));
	const chunks: string[] = [];
	let used = 0;
	for (const codePoint of text) {
		const bytes = Buffer.byteLength(codePoint, "utf8");
		if (used + bytes > budget) break;
		chunks.push(codePoint);
		used += bytes;
	}
	return { text: chunks.join("") + NOTICE, truncated: true };
}

/**
 * Parse the descriptor emitted by ExocomPlane.payloadFor(). Deliberately fail closed:
 * unmarked/arbitrary JSON remains ordinary peer text, and malformed descriptors never
 * become an instruction to read an attacker-chosen path as an artifact.
 */
export function parseExocomArtifactDescriptor(text: string): ExocomArtifactDescriptor | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.join(",") !== "kind,path,preview,size") return undefined;
	if (record.kind !== "exocom_artifact" || typeof record.preview !== "string" || typeof record.path !== "string") return undefined;
	if (record.preview.length > 4_096 || record.path.length === 0 || record.path.length > 4_096) return undefined;
	if (/[\u0000-\u001F\u007F-\u009F]/.test(record.path)) return undefined;
	if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size <= 0) return undefined;
	return {
		kind: "exocom_artifact",
		preview: record.preview,
		path: record.path,
		size: record.size,
	};
}

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

/** Semantic collaboration frames — ack/nack stay TRANSPORT. */
export interface ExocomClaim {
	kind: "claim"; work_key: string; from_session: string; from_name: string;
	write_set: string[]; slice: string; msg_id: string; ts: string; signature?: string;
}
export interface ExocomAsk {
	kind: "ask"; ask_id: string; work_key: string; from_session: string; from_name: string;
	to_session: string; question: string; msg_id: string; ts: string; signature?: string;
}
export interface ExocomAnswer {
	kind: "answer"; ask_id: string; work_key: string; from_session: string; from_name: string;
	ok: boolean; evidence: string; msg_id: string; ts: string; signature?: string;
}
export interface ExocomProgress {
	kind: "progress"; work_key: string; from_session: string; from_name: string;
	note: string; msg_id: string; ts: string; signature?: string;
}
export interface ExocomRelease {
	kind: "release"; work_key: string; from_session: string; from_name: string;
	msg_id: string; ts: string; signature?: string;
}
export type ExocomSemanticFrame = ExocomClaim | ExocomAsk | ExocomAnswer | ExocomProgress | ExocomRelease;
export type ExocomFrame = ExocomMessage | ExocomBye | ExocomAck | ExocomNack | ExocomSemanticFrame;

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bounded = (v: unknown, max: number): v is string => str(v) && v.length > 0 && v.length <= max;
const token = (v: unknown): v is string => bounded(v, 128) && /^[A-Za-z0-9._:-]+$/.test(v);
const optionalBounded = (v: unknown, max: number): boolean => v === undefined || bounded(v, max);
const metadata = (v: unknown, max: number): v is string =>
	bounded(v, max) && !/[\p{Cc}\p{Zl}\p{Zp}<>]/u.test(v);
const timestamp = (v: unknown): v is string =>
	bounded(v, 128)
	&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)
	&& Number.isFinite(Date.parse(v));
const writeSet = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length <= 64 && v.every((p) => str(p) && p.length > 0 && p.length <= 256);

export function isSemanticFrame(v: unknown): v is ExocomSemanticFrame {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	switch (o.kind) {
		case "claim":
			return token(o.work_key) && token(o.from_session) && metadata(o.from_name, 256)
				&& writeSet(o.write_set) && bounded(o.slice, 256) && token(o.msg_id) && timestamp(o.ts)
				&& optionalBounded(o.signature, 512);
		case "ask":
			return token(o.ask_id) && token(o.work_key) && token(o.from_session) && metadata(o.from_name, 256)
				&& token(o.to_session) && o.to_session !== "*" && bounded(o.question, 4_096)
				&& token(o.msg_id) && timestamp(o.ts) && optionalBounded(o.signature, 512);
		case "answer":
			return token(o.ask_id) && token(o.work_key) && token(o.from_session) && metadata(o.from_name, 256)
				&& typeof o.ok === "boolean" && bounded(o.evidence, 8_192)
				&& token(o.msg_id) && timestamp(o.ts) && optionalBounded(o.signature, 512);
		case "progress":
			return token(o.work_key) && token(o.from_session) && metadata(o.from_name, 256)
				&& bounded(o.note, 4_096) && token(o.msg_id) && timestamp(o.ts)
				&& optionalBounded(o.signature, 512);
		case "release":
			return token(o.work_key) && token(o.from_session) && metadata(o.from_name, 256)
				&& token(o.msg_id) && timestamp(o.ts) && optionalBounded(o.signature, 512);
		default:
			return false;
	}
}

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
		case "claim":
		case "ask":
		case "answer":
		case "progress":
		case "release":
			return isSemanticFrame(v);
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
		case "claim":
			return JSON.stringify([frame.kind, frame.msg_id, frame.work_key, frame.from_session, frame.from_name,
				frame.write_set, frame.slice, frame.ts]);
		case "ask":
			return JSON.stringify([frame.kind, frame.msg_id, frame.ask_id, frame.work_key, frame.from_session, frame.from_name,
				frame.to_session, frame.question, frame.ts]);
		case "answer":
			return JSON.stringify([frame.kind, frame.msg_id, frame.ask_id, frame.work_key, frame.from_session, frame.from_name,
				frame.ok, frame.evidence, frame.ts]);
		case "progress":
			return JSON.stringify([frame.kind, frame.msg_id, frame.work_key, frame.from_session, frame.from_name,
				frame.note, frame.ts]);
		case "release":
			return JSON.stringify([frame.kind, frame.msg_id, frame.work_key, frame.from_session, frame.from_name, frame.ts]);
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

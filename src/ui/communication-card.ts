import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "./presentation.ts";
import { neutralizeMonitorUnicode } from "../core/monitor-output.ts";

export type CommunicationPlane = "intercom" | "exocom";
export interface CommunicationMessage { from?: string; text: string; id?: string; kind?: string }
export interface CommunicationCard { plane: CommunicationPlane; messages: CommunicationMessage[]; omitted?: number; truncated?: boolean }
export interface CommunicationCardDetails { communication: CommunicationCard }

const MAX_MESSAGES = 64;
const MAX_BODY = 8_000;
const MAX_TOTAL_BODY = 16_000;

/** A bounded display snapshot; the model-facing fenced message remains the delivery source. */
export function buildCommunicationCardDetails(plane: CommunicationPlane, messages: readonly CommunicationMessage[]): CommunicationCardDetails {
	let remaining = MAX_TOTAL_BODY;
	let truncated = false;
	const projected: CommunicationMessage[] = [];
	for (const message of messages.slice(0, MAX_MESSAGES)) {
		if (remaining <= 0) break;
		const body = sanitizeTerminalText(message.text);
		const limit = Math.min(MAX_BODY, remaining);
		const clipped = body.length > limit;
		truncated ||= clipped;
		const text = clipped ? body.slice(0, limit) : body;
		remaining -= text.length;
		projected.push({
			...(message.from ? { from: compactInlineText(neutralizeMonitorUnicode(message.from), { maxChars: 120 }) || "unknown" } : {}),
			text,
			...(message.id ? { id: compactInlineText(message.id, { maxChars: 120 }) } : {}),
			...(message.kind ? { kind: compactInlineText(message.kind, { maxChars: 40 }) } : {}),
		});
	}
	return { communication: { plane, messages: projected, ...(messages.length > projected.length ? { omitted: messages.length - projected.length } : {}), ...(truncated ? { truncated: true } : {}) } };
}

/** Reject malformed saved metadata; never infer attribution from model-facing prose. */
export function parseCommunicationCardDetails(value: unknown): CommunicationCard | undefined {
	if (!value || typeof value !== "object" || !("communication" in value)) return undefined;
	const data = value.communication;
	if (!data || typeof data !== "object" || !("plane" in data) || !("messages" in data)) return undefined;
	if (data.plane !== "intercom" && data.plane !== "exocom") return undefined;
	if (!Array.isArray(data.messages) || data.messages.length > MAX_MESSAGES) return undefined;
	if (!data.messages.every((message: unknown) => message && typeof message === "object" && (!("from" in message) || typeof message.from === "string") && "text" in message && typeof message.text === "string" && (!("id" in message) || typeof message.id === "string") && (!("kind" in message) || typeof message.kind === "string"))) return undefined;
	const parsed = buildCommunicationCardDetails(data.plane, data.messages as CommunicationMessage[]).communication;
	if ("omitted" in data && typeof data.omitted === "number" && Number.isSafeInteger(data.omitted) && data.omitted > 0) parsed.omitted = Math.min(data.omitted, 999);
	if ("truncated" in data && data.truncated === true) parsed.truncated = true;
	return parsed;
}

function formatCommunicationCard(card: CommunicationCard): string {
	const messages = card.messages.map((message) => {
		const text = compactInlineText(neutralizeMonitorUnicode(message.text), { maxChars: 100 });
		if (!message.from) return text;
		return `from ${message.from}:\n${text}`;
	});
	return [...messages, ...(card.omitted ? [`… ${card.omitted} more message${card.omitted === 1 ? "" : "s"}`] : []), ...(card.truncated ? ["… message text truncated; expand for the delivered source"] : [])].join("\n\n");
}

export function communicationPreview(card: CommunicationCard, width: number): { text: string; truncated: boolean } {
	const overflow = Boolean(card.omitted || card.truncated);
	const result = compactVisibleText(formatCommunicationCard(card), { maxLines: overflow ? 3 : 4, maxLineChars: Math.min(width, 100) });
	const flattened = card.messages.some((message) => compactInlineText(neutralizeMonitorUnicode(message.text), { maxChars: 100 }) !== message.text);
	return { text: `${result.text}${overflow ? "\n… source limited; expand" : ""}`, truncated: result.truncated || overflow || flattened };
}

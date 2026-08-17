/**
 * `intercom` — the SUPERVISOR-side tool of the communication plane (the mirror of the
 * child's `contact_supervisor`). Pure core: maps an action over the {@link InProcessBus}
 * and formats a readable result; the extension wraps it in a `pi.registerTool` so the
 * supervisor can, while async children run:
 *   - `list`  — who is reachable (running children + peers)
 *   - `inbox` — read (drain) what children have reported / asked
 *   - `reply` — answer a child's blocking `need_decision`/`interview_request` by id
 *   - `send`  — push a one-way note to a running child
 *
 * Pure (takes the bus + self handle), so it is unit-tested without a live model.
 */

import type { Envelope, InProcessBus } from "../bus/inproc.ts";
import { sanitizeDisplayLabel } from "../core/display-label.ts";

export interface IntercomParams {
	action: "list" | "inbox" | "reply" | "send";
	/** `send` target child handle. */
	to?: string;
	/** `reply` target — the message id of the child's pending ask. */
	askId?: string;
	/** `send`/`reply` body. */
	message?: string;
}

export interface IntercomDetails {
	action: string;
	peers?: string[];
	messages?: Envelope[];
	totalPeers?: number;
	omittedPeers?: number;
	ok: boolean;
}

export interface IntercomOutcome {
	text: string;
	details: IntercomDetails;
}

/** Automatic intercom payload limits. Explicit `result` retrieval is the escape hatch for detail. */
export const MAX_INBOX_MESSAGE_CHARS = 2_000;
export const MAX_INBOX_BATCH_CHARS = 16_000;
export const MAX_INTERCOM_MESSAGE_CHARS = 8_000;
export const MAX_INTERCOM_REF_CHARS = 160;
export const MAX_INTERCOM_LIST_PEERS = 64;

export interface InboxFormatOptions {
	maxMessageChars?: number;
	maxBatchChars?: number;
}

function clipBody(value: string, maxChars: number): { text: string; omitted: number } {
	if (value.length <= maxChars) return { text: value, omitted: 0 };
	const marker = `[… ${value.length - maxChars} characters omitted; request the full message by id …]`;
	if (maxChars <= marker.length) return { text: marker.slice(0, Math.max(0, maxChars)), omitted: value.length };
	const content = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(content / 2);
	const tail = Math.max(0, content - head);
	return { text: `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`, omitted: value.length - maxChars };
}

/** One bounded readable line per inbox message; decision/interview lines always show sender + id. */
export function formatInbox(messages: Envelope[], opts?: InboxFormatOptions): string {
	if (messages.length === 0) return "(no new messages from sub-agents)";
	const maxMessageChars = Math.max(128, opts?.maxMessageChars ?? MAX_INBOX_MESSAGE_CHARS);
	const maxBatchChars = Math.max(512, opts?.maxBatchChars ?? MAX_INBOX_BATCH_CHARS);
	// Reserve a small footer so the batch can state how much was omitted without pushing the
	// rendered response over its hard bound. Every message gets an equal slot: one verbose child
	// cannot consume the whole inbox and hide later reply ids.
	const slot = Math.max(128, Math.floor((maxBatchChars - 96) / messages.length));
	let omittedChars = 0;
	const lines = messages.map((m) => {
		const from = sanitizeDisplayLabel(m.from, "peer", 40);
		const kind = sanitizeDisplayLabel(m.kind, "message", 24);
		const id = sanitizeDisplayLabel(m.id, "message", 40);
		const tag = m.expectsReply ? `${kind} · reply with id ${id}` : kind;
		const prefix = `• [${from}] (${tag}): `;
		const body = clipBody(m.text, Math.min(maxMessageChars, Math.max(0, slot - prefix.length)));
		omittedChars += body.omitted;
		return `${prefix}${body.text}`;
	});
	const footer = omittedChars > 0 ? `\n… ${omittedChars} message characters omitted from this inbox view; use the message id for full detail.` : "";
	const rendered = `${lines.join("\n")}${footer}`;
	if (rendered.length <= maxBatchChars) return rendered;
	// This is only reachable with unusually long metadata; preserve the first and last lines while
	// keeping the sender/id and omission signal visible at a predictable size.
	const marker = `\n… inbox batch truncated at ${maxBatchChars} characters; ${messages.length} message(s) present, use ids for detail.`;
	const content = Math.max(0, maxBatchChars - marker.length);
	return `${rendered.slice(0, Math.ceil(content * 0.65))}${marker}${rendered.slice(-Math.floor(content * 0.35))}`.slice(0, maxBatchChars);
}

export function runIntercom(params: IntercomParams, bus: InProcessBus, self: string): IntercomOutcome {
	switch (params.action) {
		case "list": {
			const peers = bus.participants().filter((p) => p !== self);
			const listed = peers.slice(0, MAX_INTERCOM_LIST_PEERS);
			const omittedPeers = Math.max(0, peers.length - listed.length);
			const omission = omittedPeers > 0 ? `\n… ${omittedPeers} more reachable sub-agents omitted from this bounded view.` : "";
			return {
				text: peers.length > 0
					? `Reachable sub-agents (${peers.length}):\n${listed.map((p) => `• ${sanitizeDisplayLabel(p, "peer")}`).join("\n")}${omission}`
					: "(no sub-agents are currently reachable)",
				details: {
					action: "list",
					peers: listed,
					totalPeers: peers.length,
					...(omittedPeers > 0 ? { omittedPeers } : {}),
					ok: true,
				},
			};
		}
		case "inbox": {
			const messages = bus.take(self);
			return { text: formatInbox(messages), details: { action: "inbox", messages, ok: true } };
		}
		case "reply": {
			if (!params.askId || params.message === undefined) {
				return { text: "intercom reply needs { askId, message }.", details: { action: "reply", ok: false } };
			}
			if (params.askId.length > MAX_INTERCOM_REF_CHARS) {
				return { text: `intercom reply askId exceeds the ${MAX_INTERCOM_REF_CHARS}-character limit.`, details: { action: "reply", ok: false } };
			}
			if (params.message.length > MAX_INTERCOM_MESSAGE_CHARS) {
				return { text: `intercom reply message exceeds the ${MAX_INTERCOM_MESSAGE_CHARS}-character limit.`, details: { action: "reply", ok: false } };
			}
			const replied = bus.reply(params.askId, params.message);
			const displayAskId = sanitizeDisplayLabel(params.askId, "ask");
			return replied
				? { text: `Replied to ${displayAskId}.`, details: { action: "reply", ok: true } }
				: {
						text: `No pending ask with id "${displayAskId}" — it may have timed out or already been answered (check "inbox").`,
						details: { action: "reply", ok: false },
					};
		}
		case "send": {
			if (!params.to || params.message === undefined) {
				return { text: "intercom send needs { to, message }.", details: { action: "send", ok: false } };
			}
			if (params.to.length > MAX_INTERCOM_REF_CHARS) {
				return { text: `intercom send target exceeds the ${MAX_INTERCOM_REF_CHARS}-character limit.`, details: { action: "send", ok: false } };
			}
			if (params.message.length > MAX_INTERCOM_MESSAGE_CHARS) {
				return { text: `intercom send message exceeds the ${MAX_INTERCOM_MESSAGE_CHARS}-character limit.`, details: { action: "send", ok: false } };
			}
			const delivered = bus.send(self, params.to, params.message, "progress");
			const displayPeer = sanitizeDisplayLabel(params.to, "peer");
			return delivered
				? { text: `Sent to ${displayPeer}.`, details: { action: "send", ok: true } }
				: { text: `Unknown peer "${displayPeer}" — nobody by that handle is registered.`, details: { action: "send", ok: false } };
		}
	}
}

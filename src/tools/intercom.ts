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
	ok: boolean;
}

export interface IntercomOutcome {
	text: string;
	details: IntercomDetails;
}

/** One readable line per inbox message; decision/interview lines show the id to reply to. */
export function formatInbox(messages: Envelope[]): string {
	if (messages.length === 0) return "(no new messages from sub-agents)";
	return messages
		.map((m) => {
			const tag = m.expectsReply ? `${m.kind} · reply with id ${m.id}` : m.kind;
			return `• [${m.from}] (${tag}): ${m.text}`;
		})
		.join("\n");
}

export function runIntercom(params: IntercomParams, bus: InProcessBus, self: string): IntercomOutcome {
	switch (params.action) {
		case "list": {
			const peers = bus.participants().filter((p) => p !== self);
			return {
				text: peers.length > 0 ? `Reachable sub-agents:\n${peers.map((p) => `• ${p}`).join("\n")}` : "(no sub-agents are currently reachable)",
				details: { action: "list", peers, ok: true },
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
			bus.reply(params.askId, params.message);
			return { text: `Replied to ${params.askId}.`, details: { action: "reply", ok: true } };
		}
		case "send": {
			if (!params.to || params.message === undefined) {
				return { text: "intercom send needs { to, message }.", details: { action: "send", ok: false } };
			}
			const delivered = bus.send(self, params.to, params.message, "progress");
			return delivered
				? { text: `Sent to ${params.to}.`, details: { action: "send", ok: true } }
				: { text: `Unknown peer "${params.to}" — nobody by that handle is registered.`, details: { action: "send", ok: false } };
		}
	}
}

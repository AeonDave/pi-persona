/**
 * Slimmed wire-frame catalog + validators (spec B6) — comtac's protocol trimmed to the
 * frames pi-persona actually needs: register/send/reply/list/bye (client→host) and
 * registered/deliver/steer/peers/replied/error (host→client). Mirrors comtac's
 * `messages.ts` validation STYLE (structural per-field checks, one explicit assert per
 * case) but drops presence/sessions/attachments/broadcasts entirely (YAGNI here).
 *
 * Pure module: no Pi imports, unit-tested.
 */

import type { MsgKind } from "../inproc.ts";

export type Frame =
	| { t: "register"; handle: string; label?: string; group?: string; peers?: boolean }
	| { t: "registered"; handle: string }
	| { t: "send"; to: string; kind: MsgKind; text: string; msgId: string; expectsReply: boolean }
	| { t: "deliver"; from: string; fromLabel?: string; kind: MsgKind; text: string; msgId: string; expectsReply: boolean }
	| { t: "reply"; askId: string; text: string }
	| { t: "replied"; askId: string; text: string }
	| { t: "steer"; text: string }
	| { t: "list"; reqId: string }
	| { t: "peers"; reqId: string; peers: Array<{ handle: string; label: string }> }
	| { t: "bye" }
	| { t: "error"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMsgKind(value: unknown): value is MsgKind {
	return value === "progress" || value === "decision" || value === "interview";
}

function isPeerEntry(value: unknown): value is { handle: string; label: string } {
	return isRecord(value) && typeof value.handle === "string" && typeof value.label === "string";
}

export function isFrame(value: unknown): value is Frame {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case "register": {
			if (typeof value.handle !== "string") return false;
			if (value.label !== undefined && typeof value.label !== "string") return false;
			if (value.group !== undefined && typeof value.group !== "string") return false;
			return value.peers === undefined || typeof value.peers === "boolean";
		}
		case "registered":
			return typeof value.handle === "string";
		case "send":
			return (
				typeof value.to === "string" &&
				isMsgKind(value.kind) &&
				typeof value.text === "string" &&
				typeof value.msgId === "string" &&
				typeof value.expectsReply === "boolean"
			);
		case "deliver": {
			if (typeof value.from !== "string") return false;
			if (value.fromLabel !== undefined && typeof value.fromLabel !== "string") return false;
			return (
				isMsgKind(value.kind) &&
				typeof value.text === "string" &&
				typeof value.msgId === "string" &&
				typeof value.expectsReply === "boolean"
			);
		}
		case "reply":
			return typeof value.askId === "string" && typeof value.text === "string";
		case "replied":
			return typeof value.askId === "string" && typeof value.text === "string";
		case "steer":
			return typeof value.text === "string";
		case "list":
			return typeof value.reqId === "string";
		case "peers":
			return typeof value.reqId === "string" && Array.isArray(value.peers) && value.peers.every(isPeerEntry);
		case "bye":
			return true;
		case "error":
			return typeof value.reason === "string";
		default:
			return false;
	}
}

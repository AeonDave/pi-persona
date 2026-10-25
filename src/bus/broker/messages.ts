/**
 * Slimmed wire-frame catalog + validators (spec B6) — comtac's protocol trimmed to the
 * frames pi-persona actually needs: register/send/cancel/reply/list/bye (client→host) and
 * registered/sent/deliver/steer/peers/replied/error (host→client). Mirrors comtac's
 * `messages.ts` validation STYLE (structural per-field checks, one explicit assert per
 * case) but drops presence/sessions/attachments/broadcasts entirely (YAGNI here).
 *
 * Authenticated result_read/result_read_reply/result_read_cancel frames extend the same
 * connection with a closed bounded page contract. No archive summaries or client grants.
 * Pure module: no Pi imports, unit-tested.
 */

import type { MsgKind } from "../inproc.ts";
import { closedRecord, isReadReply, isReadRequest, type ReadReply, type ResultReadRequest } from "../result-reader.ts";

export function isReaderToken(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export type Frame =
	| { t: "register"; handle: string; label?: string; group?: string; peers?: boolean; readerToken?: string }
	| { t: "registered"; handle: string; readerToken?: string }
	| ({ t: "result_read"; reqId: string } & ResultReadRequest)
	| { t: "result_read_reply"; reqId: string; result: ReadReply }
	| { t: "result_read_cancel"; reqId: string }
	| { t: "send"; to: string; kind: MsgKind; text: string; msgId: string; expectsReply: boolean }
	| { t: "sent"; msgId: string; delivered: boolean }
	| { t: "cancel"; msgId: string }
	| { t: "deliver"; from: string; fromLabel?: string; kind: MsgKind; text: string; msgId: string; expectsReply: boolean }
	| { t: "reply"; askId: string; text: string }
	| { t: "replied"; askId: string; text: string }
	| { t: "steer"; text: string }
	| { t: "list"; reqId: string }
	| { t: "peers"; reqId: string; peers: Array<{ handle: string; label: string }> }
	| { t: "bye" }
	| { t: "error"; reason: string; msgId?: string };

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
		case "result_read": {
			if (!closedRecord(value, ["t", "reqId", "ref", "offset", "limit"]) || !isRequestId(value.reqId)) return false;
			const { t: _t, reqId: _id, ...request } = value;
			return isReadRequest(request);
		}
		case "result_read_reply":
			return closedRecord(value, ["t", "reqId", "result"]) && isRequestId(value.reqId) && isReadReply(value.result);
		case "result_read_cancel":
			return closedRecord(value, ["t", "reqId"]) && isRequestId(value.reqId);
		case "register": {
			if (!closedRecord(value, ["t", "handle", "label", "group", "peers", "readerToken"])) return false;
			if ("readerToken" in value && !isReaderToken(value.readerToken)) return false;
			if (typeof value.handle !== "string" || value.handle.length === 0 || value.handle.length > 256) return false;
			if (value.label !== undefined && typeof value.label !== "string") return false;
			if (value.group !== undefined && typeof value.group !== "string") return false;
			return value.peers === undefined || typeof value.peers === "boolean";
		}
		case "registered":
			return closedRecord(value, ["t", "handle", "readerToken"]) && typeof value.handle === "string"
				&& value.handle.length > 0 && value.handle.length <= 256
				&& (!("readerToken" in value) || isReaderToken(value.readerToken));
		case "send":
			return (
				typeof value.to === "string" &&
				isMsgKind(value.kind) &&
				typeof value.text === "string" &&
				typeof value.msgId === "string" &&
				typeof value.expectsReply === "boolean"
			);
		case "cancel":
			return typeof value.msgId === "string";
		case "sent":
			return closedRecord(value, ["t", "msgId", "delivered"]) && typeof value.msgId === "string" && typeof value.delivered === "boolean";
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
			return typeof value.reason === "string" && (value.msgId === undefined || typeof value.msgId === "string");
		default:
			return false;
	}
}

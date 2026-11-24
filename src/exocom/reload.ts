/** Bounded, branch-scoped handoff for postcards accepted before a Pi reload. */
import type { PresentedNotice } from "../extension/shared.ts";
import { validReloadInboundContext, type InboundContext } from "./plane.ts";
import { EXOCOM_INBOX_MAX } from "../extension/shared.ts";
import { EXOCOM } from "./limits.ts";

export const EXOCOM_RELOAD_ENTRY = "pi-persona:exocom-reload:v1";
const TTL_MS = EXOCOM.SEEN_TTL_MS;
// The fenced payload and card both carry the body; JSON can expand controls sixfold.
const MAX_ITEM_BYTES = 128 * 1024;
const MAX_SNAPSHOT_BYTES = EXOCOM_INBOX_MAX * MAX_ITEM_BYTES;

// Pi retains its SessionManager across /reload, including a fresh extension module load.
// Keep only the owner's one-use snapshot ID here; the bounded payload stays in native history.
const reloadKey = Symbol.for("pi-persona:exocom-reload-owners:v1");
const runtime = globalThis as typeof globalThis & { [reloadKey]?: WeakMap<object, string> };
const reloadOwners = runtime[reloadKey] ??= new WeakMap<object, string>();

export function authorizeReload(manager: object, snapshotId: string): void {
	reloadOwners.set(manager, snapshotId);
}

export function takeReloadId(manager: object): string | undefined {
	const id = reloadOwners.get(manager);
	reloadOwners.delete(manager);
	return id;
}

export interface ReloadNotice extends PresentedNotice {
	receipt: { sender: string; id: string };
	context: InboundContext;
}
export interface ReloadSnapshot {
	kind: "snapshot";
	id: string;
	sessionId: string;
	scope: string;
	agentDir: string;
	createdAt: number;
	items: ReloadNotice[];
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function token(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function validItem(value: unknown): value is ReloadNotice {
	if (!object(value) || typeof value.text !== "string" || !object(value.message) || !object(value.receipt) || !object(value.context)) return false;
	const { message, receipt, context } = value;
	if (!token(receipt.sender) || !token(receipt.id) || !validReloadInboundContext(context) || context.msg_id !== receipt.id
		|| context.entry.session_id !== receipt.sender
		|| typeof message.text !== "string" || message.id !== receipt.id || (message.kind !== "message" && message.kind !== "reply")
		|| (message.from !== undefined && typeof message.from !== "string")) return false;
	return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_ITEM_BYTES;
}

export function createReloadSnapshot(id: string, sessionId: string, scope: string, agentDir: string, createdAt: number, items: ReloadNotice[]): ReloadSnapshot | undefined {
	if (![id, sessionId, scope, agentDir].every(token) || !Number.isFinite(createdAt) || items.length === 0 || items.length > EXOCOM_INBOX_MAX) return undefined;
	const keys = new Set<string>();
	for (const item of items) {
		if (!validItem(item)) return undefined;
		const key = JSON.stringify([item.receipt.sender, item.receipt.id]);
		if (keys.has(key)) return undefined;
		keys.add(key);
	}
	const snapshot: ReloadSnapshot = { kind: "snapshot", id, sessionId, scope, agentDir, createdAt, items };
	return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_SNAPSHOT_BYTES ? snapshot : undefined;
}

function entryData(value: unknown): Record<string, unknown> | undefined {
	return object(value) && value.type === "custom" && value.customType === EXOCOM_RELOAD_ENTRY && object(value.data) ? value.data : undefined;
}

/** Return all unconsumed snapshot IDs in this session, including other branches, for invalidation. */
export function unconsumedReloadIds(entries: readonly unknown[], sessionId: string): string[] {
	const ids = new Set<string>();
	const consumed = new Set<string>();
	for (const entry of entries) {
		const data = entryData(entry);
		if (!data || data.sessionId !== sessionId || !token(data.id)) continue;
		if (data.kind === "snapshot") ids.add(data.id);
		if (data.kind === "consumed") consumed.add(data.id);
	}
	return [...ids].filter((id) => !consumed.has(id));
}

export function findReloadSnapshot(branch: readonly unknown[], entries: readonly unknown[], sessionId: string, scope: string, agentDir: string, now: number, snapshotId: string): ReloadSnapshot | undefined {
	const outstanding = new Set(unconsumedReloadIds(entries, sessionId));
	for (let i = branch.length - 1; i >= 0; i--) {
		const data = entryData(branch[i]);
		if (!data || data.kind !== "snapshot" || data.sessionId !== sessionId || data.id !== snapshotId || !outstanding.has(snapshotId)) continue;
		if (data.scope !== scope || data.agentDir !== agentDir || typeof data.createdAt !== "number" || now < data.createdAt || now - data.createdAt > TTL_MS || !Array.isArray(data.items)) return undefined;
		return createReloadSnapshot(snapshotId, sessionId, scope, agentDir, data.createdAt, data.items as ReloadNotice[]);
	}
	return undefined;
}

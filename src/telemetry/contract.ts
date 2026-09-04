/** Vendor-neutral telemetry wire contract with a common lifecycle vocabulary. */
export const TELEMETRY_VERSION = 2 as const;
export const TELEMETRY_EVENT_NAME = "pi:telemetry" as const;
export const LEGACY_TELEMETRY_EVENT_NAME = "pi-persona:telemetry" as const;
export const LEGACY_TELEMETRY_VERSION = 1 as const;
export const TELEMETRY_PRODUCER_ID = "pi-persona" as const;
export const TELEMETRY_PRODUCER_VERSION = "1.13.0" as const;

export type InstanceStatus = "active" | "idle" | "stopped" | "stale" | (string & {});
export type AgentKind = "subagent" | "delegate" | "council" | "flow" | "phase" | (string & {});
export type AgentStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped" | (string & {});
export type MessageChannel = "intercom" | "exocom" | (string & {});
export type MessageStatus = "queued" | "delivered" | "replied" | "rejected" | "failed" | (string & {});

export interface InstanceDescriptor {
	displayName: string;
	status: InstanceStatus;
	/** Optional producer metadata. The common lifecycle does not require a persona or model. */
	persona?: string;
	model?: string;
	pid?: number;
	contextPercent?: number;
	/** pi-persona adapter capability; other producers omit it. */
	exocomEnabled?: boolean;
	color?: string;
}

export interface AgentDescriptor {
	id: string;
	label: string;
	kind: AgentKind;
	status: AgentStatus;
	parentId?: string;
	agent?: string;
	persona?: string;
	model?: string;
}

export interface ToolDescriptor {
	callId: string;
	agentId: string;
	name: string;
	status: "running" | "done" | "failed" | (string & {});
	durationMs?: number;
}

export interface MessageDescriptor {
	id: string;
	channel: MessageChannel;
	from: string;
	to: string;
	kind: string;
	status: MessageStatus;
	expectsReply: boolean;
	size: number;
	replyTo?: string;
}

export interface PeerDescriptor {
	sessionId: string;
	displayName: string;
	persona: string;
	model: string;
	contextPercent: number;
	status: "online" | "idle";
	color?: string;
	sent: number;
	received: number;
}

export type KnownTelemetryEventType =
	| "instance.started" | "instance.updated" | "instance.heartbeat" | "instance.stopped"
	| "agent.added" | "agent.updated" | "agent.removed" | "agent.cleared"
	| "tool.started" | "tool.finished"
	| "message.sent" | "message.received" | "message.replied" | "peers.snapshot";
/** Namespaced values from other producers are valid v2 events. */
export type TelemetryEventType = KnownTelemetryEventType | (string & {});

export interface TelemetryPayloadByType {
	"instance.started": InstanceDescriptor;
	"instance.updated": Partial<InstanceDescriptor>;
	"instance.heartbeat": Partial<InstanceDescriptor>;
	"instance.stopped": { reason: string };
	"agent.added": AgentDescriptor;
	"agent.updated": { id: string; patch: Partial<AgentDescriptor> };
	"agent.removed": { id: string; status?: AgentStatus };
	"agent.cleared": Record<string, never>;
	"tool.started": ToolDescriptor;
	"tool.finished": ToolDescriptor;
	"message.sent": MessageDescriptor;
	"message.received": MessageDescriptor;
	"message.replied": MessageDescriptor;
	"peers.snapshot": { peers: PeerDescriptor[] };
}

export type TelemetryPayload<T extends TelemetryEventType> = T extends keyof TelemetryPayloadByType ? TelemetryPayloadByType[T] : Record<string, unknown>;

export interface GenericTelemetryEvent {
	version: typeof TELEMETRY_VERSION;
	producerId: string;
	producerVersion: string;
	id: string;
	seq: number;
	ts: number;
	sessionId: string;
	workspaceId: string;
	type: string;
	payload: Record<string, unknown>;
}

export type KnownTelemetryEvent = { [K in KnownTelemetryEventType]: { version: typeof TELEMETRY_VERSION; producerId: string; producerVersion: string; id: string; seq: number; ts: number; sessionId: string; workspaceId: string; type: K; payload: TelemetryPayloadByType[K] } }[KnownTelemetryEventType];
export type TelemetryEvent<T extends TelemetryEventType = TelemetryEventType> = T extends KnownTelemetryEventType
	? { version: typeof TELEMETRY_VERSION; producerId: string; producerVersion: string; id: string; seq: number; ts: number; sessionId: string; workspaceId: string; type: T; payload: TelemetryPayload<T> }
	: GenericTelemetryEvent;

const KNOWN_TYPES = new Set<KnownTelemetryEventType>([
	"instance.started", "instance.updated", "instance.heartbeat", "instance.stopped",
	"agent.added", "agent.updated", "agent.removed", "agent.cleared",
	"tool.started", "tool.finished", "message.sent", "message.received", "message.replied", "peers.snapshot",
]);
const SAFE_ID = /^[A-Za-z0-9._:@/-]+$/;
const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const WORKSPACE_ID = /^[a-f0-9]{24}$/;
const SENSITIVE_KEY = /(?:task|prompt|args?|command|path|query|url|cwd|output|detail|content|message|secret|token|password|authorization|headers?|api.?key|credential|private.?key)/i;

/** Drop raw prompts, arguments, activity, output and credential-shaped fields at the sink boundary. */
export function sanitizeTelemetryPayload(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[depth bounded]";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeTelemetryPayload(item, depth + 1));
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value).slice(0, 256)) {
		if (SENSITIVE_KEY.test(key) || item === undefined) continue;
		const safe = sanitizeTelemetryPayload(item, depth + 1);
		if (safe !== undefined) out[key] = safe;
	}
	return out;
}

const KNOWN_FIELDS: Record<string, readonly string[]> = {
	"instance.started": ["displayName", "persona", "model", "status", "pid", "contextPercent", "exocomEnabled", "color"],
	"instance.updated": ["displayName", "persona", "model", "status", "pid", "contextPercent", "exocomEnabled", "color"],
	"instance.heartbeat": ["displayName", "persona", "model", "status", "pid", "contextPercent", "exocomEnabled", "color"],
	"instance.stopped": ["reason"], "agent.added": ["id", "label", "kind", "status", "parentId", "agent", "persona", "model"],
	"agent.updated": ["id", "patch"], "agent.removed": ["id", "status"], "agent.cleared": [],
	"tool.started": ["callId", "agentId", "name", "status"], "tool.finished": ["callId", "agentId", "name", "status", "durationMs"],
	"message.sent": ["id", "channel", "from", "to", "kind", "status", "expectsReply", "size", "replyTo"],
	"message.received": ["id", "channel", "from", "to", "kind", "status", "expectsReply", "size", "replyTo"],
	"message.replied": ["id", "channel", "from", "to", "kind", "status", "expectsReply", "size", "replyTo"],
	"peers.snapshot": ["peers"],
};

/** Producer-side projection is deliberately closed: future producers must publish a reviewed event schema. */
export function projectTelemetryPayload(type: string, value: unknown): Record<string, unknown> {
	const safe = sanitizeTelemetryPayload(value);
	if (!safe || typeof safe !== "object" || Array.isArray(safe)) return {};
	const fields = KNOWN_FIELDS[type];
	if (!fields) return {};
	const projected = Object.fromEntries(fields.filter((field) => field in safe).map((field) => [field, (safe as Record<string, unknown>)[field]]));
	if (type === "agent.updated" && projected.patch && typeof projected.patch === "object" && !Array.isArray(projected.patch)) {
		const allowed = ["label", "kind", "status", "parentId", "agent", "persona", "model"];
		projected.patch = Object.fromEntries(allowed.filter((field) => field in (projected.patch as Record<string, unknown>)).map((field) => [field, (projected.patch as Record<string, unknown>)[field]]));
	}
	return projected;
}

export function isKnownTelemetryEvent(event: TelemetryEvent): event is KnownTelemetryEvent {
	return KNOWN_TYPES.has(event.type as KnownTelemetryEventType);
}

function objectPayload(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringField(payload: Record<string, unknown>, key: string, required = true): boolean {
	if (payload[key] === undefined) return !required;
	return typeof payload[key] === "string" && (required ? (payload[key] as string).length > 0 : true) && (payload[key] as string).length <= 1_024;
}
function numberField(payload: Record<string, unknown>, key: string, opts: { integer?: boolean; min?: number; max?: number } = {}): boolean {
	if (payload[key] === undefined) return true;
	if (typeof payload[key] !== "number" || !Number.isFinite(payload[key])) return false;
	if (opts.integer && !Number.isSafeInteger(payload[key])) return false;
	return (opts.min === undefined || payload[key] >= opts.min) && (opts.max === undefined || payload[key] <= opts.max);
}
function validKnownPayload(type: string, payload: Record<string, unknown>): boolean {
	if (type === "instance.updated" || type === "instance.heartbeat") return Object.keys(payload).every((key) => ["displayName", "persona", "model", "status", "exocomEnabled", "color", "pid", "contextPercent"].includes(key)) && ["displayName", "status"].every((key) => payload[key] === undefined || stringField(payload, key)) && ["persona", "model", "color"].every((key) => payload[key] === undefined || stringField(payload, key, false)) && (payload.exocomEnabled === undefined || typeof payload.exocomEnabled === "boolean") && numberField(payload, "pid", { integer: true, min: 0 }) && numberField(payload, "contextPercent", { min: 0, max: 100 });
	if (type === "agent.cleared") return true;
	if (type === "instance.started") return stringField(payload, "displayName") && stringField(payload, "status") && ["persona", "model", "color"].every((key) => payload[key] === undefined || stringField(payload, key, false)) && numberField(payload, "pid", { integer: true, min: 0 }) && numberField(payload, "contextPercent", { min: 0, max: 100 }) && (payload.exocomEnabled === undefined || typeof payload.exocomEnabled === "boolean");
	if (type === "instance.stopped") return stringField(payload, "reason");
	if (type === "agent.added") return stringField(payload, "id") && stringField(payload, "label") && stringField(payload, "kind") && stringField(payload, "status") && ["parentId", "agent", "persona", "model"].every((key) => payload[key] === undefined || stringField(payload, key, false));
	if (type === "agent.updated") {
		const patch = objectPayload(payload.patch);
		return stringField(payload, "id") && patch !== undefined && Object.entries(patch).every(([key, value]) => ["label", "kind", "status", "parentId", "agent", "persona", "model"].includes(key) ? typeof value === "string" : false);
	}
	if (type === "agent.removed") return stringField(payload, "id") && (payload.status === undefined || ["done", "failed", "stopped"].includes(payload.status as string));
	if (type === "tool.started") return stringField(payload, "callId") && stringField(payload, "agentId") && stringField(payload, "name") && payload.status === "running";
	if (type === "tool.finished") return stringField(payload, "callId") && stringField(payload, "agentId") && stringField(payload, "name") && ["done", "failed"].includes(payload.status as string) && numberField(payload, "durationMs", { min: 0 });
	if (type === "message.sent" || type === "message.received" || type === "message.replied") return stringField(payload, "id") && stringField(payload, "channel") && stringField(payload, "from") && stringField(payload, "to") && stringField(payload, "kind") && stringField(payload, "status") && typeof payload.expectsReply === "boolean" && numberField(payload, "size", { integer: true, min: 0 }) && (payload.replyTo === undefined || stringField(payload, "replyTo"));
	if (type === "peers.snapshot") return Array.isArray(payload.peers) && payload.peers.every((peer) => { const p = objectPayload(peer); return p !== undefined && stringField(p, "sessionId") && stringField(p, "displayName") && stringField(p, "persona", false) && stringField(p, "model", false) && numberField(p, "contextPercent", { min: 0, max: 100 }) && typeof p.status === "string" && numberField(p, "sent", { integer: true, min: 0 }) && numberField(p, "received", { integer: true, min: 0 }); });
	return true;
}
function containsNonFinite(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value);
	if (Array.isArray(value)) return value.some(containsNonFinite);
	if (value && typeof value === "object") return Object.values(value).some(containsNonFinite);
	return false;
}

function validIdentity(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_ID.test(value);
}

export function parseTelemetryEvent(value: unknown): TelemetryEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const e = value as Record<string, unknown>;
	const legacy = e.version === LEGACY_TELEMETRY_VERSION;
	if (!legacy && e.version !== TELEMETRY_VERSION) return undefined;
	if (!validIdentity(e.id, 256) || !Number.isSafeInteger(e.seq) || (e.seq as number) < 1) return undefined;
	if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts < 0) return undefined;
	if (!validIdentity(e.sessionId, 128) || typeof e.workspaceId !== "string" || !WORKSPACE_ID.test(e.workspaceId)) return undefined;
	if (typeof e.type !== "string" || e.type.length === 0 || e.type.length > 160 || !TYPE_NAME.test(e.type) || !e.payload || typeof e.payload !== "object" || Array.isArray(e.payload)) return undefined;
	if (legacy && !KNOWN_TYPES.has(e.type as KnownTelemetryEventType)) return undefined;
	const producerId = legacy ? TELEMETRY_PRODUCER_ID : e.producerId;
	const producerVersion = legacy ? "legacy-v1" : e.producerVersion;
	if (!validIdentity(producerId, 96) || !validIdentity(producerVersion, 64)) return undefined;
	if (KNOWN_TYPES.has(e.type as KnownTelemetryEventType) && containsNonFinite(e.payload)) return undefined;
	const payload = KNOWN_TYPES.has(e.type as KnownTelemetryEventType) ? projectTelemetryPayload(e.type, e.payload) : {};
	if (KNOWN_TYPES.has(e.type as KnownTelemetryEventType) && !validKnownPayload(e.type, payload)) return undefined;
	return {
		version: TELEMETRY_VERSION,
		producerId,
		producerVersion,
		id: e.id,
		seq: e.seq,
		ts: e.ts,
		sessionId: e.sessionId,
		workspaceId: e.workspaceId,
		type: e.type,
		payload,
	} as TelemetryEvent;
}

import { appendFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
	TELEMETRY_PRODUCER_ID,
	TELEMETRY_PRODUCER_VERSION,
	TELEMETRY_VERSION,
	type KnownTelemetryEventType,
	projectTelemetryPayload,
	type AgentDescriptor,
	type InstanceDescriptor,
	type TelemetryEvent,
	type TelemetryPayload,
} from "./contract.ts";
import { telemetrySessionFileKey, telemetryWorkspaceId } from "./paths.ts";

export interface TelemetryProducerOptions {
	agentDir: string;
	cwd: string;
	sessionId: string;
	producerId?: string;
	producerVersion?: string;
	emit: (event: TelemetryEvent) => void;
	now?: () => number;
	heartbeatMs?: number;
	heartbeat?: () => Partial<InstanceDescriptor>;
	onError?: (error: unknown) => void;
	maxFileBytes?: number;
}

/** Richer caller input. Prompt/activity/output fields are accepted only so the sink can drop them. */
export type TelemetryAgentInput = AgentDescriptor & { task?: string; detail?: string; output?: string };

const DEFAULT_HEARTBEAT_MS = 5_000;
const STRING_LIMIT = 512;
const ARRAY_LIMIT = 256;
const MAX_DEPTH = 8;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

const TERMINAL_AGENT_STATUSES = new Set(["done", "failed", "stopped"]);

/** The replay seeds, split by what compaction is allowed to shed. `droppable` holds the seeds that
 *  scale with LIVE WORK rather than with the cap — one group per live agent (its `added` plus the
 *  updates that still describe it) and one per unfinished tool — ordered oldest first. Everything
 *  else is a fixed handful of instance anchors and is never shed. */
interface ReplaySeeds {
	keep: Set<number>;
	droppable: readonly (readonly number[])[];
}

/** Identify the minimum original records needed to rebuild current live state after log compaction.
 * Recent history alone is insufficient when a long-running agent/tool began before the retained tail. */
function replaySeedIndexes(lines: readonly string[]): ReplaySeeds {
	type LiveAgent = { added: number; fields: Map<string, number> };
	const keep = new Set<number>();
	const instanceFields = new Map<string, number>();
	const agents = new Map<string, LiveAgent>();
	const tools = new Map<string, number>();
	let firstInstance = -1;
	let latestInstance = -1;
	let latestStop = -1;
	let latestPeers = -1;
	for (let index = 0; index < lines.length; index += 1) {
		let event: { type?: unknown; payload?: unknown };
		try { event = JSON.parse(lines[index] ?? "") as { type?: unknown; payload?: unknown }; }
		catch { continue; }
		const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
			? event.payload as Record<string, unknown>
			: {};
		if (event.type === "instance.started") {
			if (firstInstance < 0) firstInstance = index;
			latestInstance = index;
			instanceFields.clear();
			continue;
		}
		if (event.type === "instance.updated" || event.type === "instance.heartbeat") {
			for (const field of Object.keys(payload)) instanceFields.set(field, index);
			continue;
		}
		if (event.type === "instance.stopped") { latestStop = index; continue; }
		if (event.type === "peers.snapshot") { latestPeers = index; continue; }
		if (event.type === "agent.added") {
			const id = typeof payload.id === "string" ? payload.id : undefined;
			if (!id) continue;
			if (typeof payload.status === "string" && TERMINAL_AGENT_STATUSES.has(payload.status)) agents.delete(id);
			else agents.set(id, { added: index, fields: new Map() });
			continue;
		}
		if (event.type === "agent.updated") {
			const id = typeof payload.id === "string" ? payload.id : undefined;
			const patch = payload.patch && typeof payload.patch === "object" && !Array.isArray(payload.patch)
				? payload.patch as Record<string, unknown>
				: undefined;
			const active = id ? agents.get(id) : undefined;
			if (!id || !patch || !active) continue;
			if (typeof patch.status === "string" && TERMINAL_AGENT_STATUSES.has(patch.status)) { agents.delete(id); continue; }
			for (const field of Object.keys(patch)) active.fields.set(field, index);
			continue;
		}
		if (event.type === "agent.removed") {
			if (typeof payload.id === "string") agents.delete(payload.id);
			continue;
		}
		if (event.type === "agent.cleared") { agents.clear(); continue; }
		if (event.type === "tool.started") {
			if (typeof payload.callId === "string") tools.set(payload.callId, index);
			continue;
		}
		if (event.type === "tool.finished" && typeof payload.callId === "string") tools.delete(payload.callId);
	}
	if (firstInstance >= 0) keep.add(firstInstance);
	else if (lines.length > 0) keep.add(0);
	if (latestInstance >= 0) keep.add(latestInstance);
	if (latestStop >= 0) keep.add(latestStop);
	if (latestPeers >= 0) keep.add(latestPeers);
	for (const index of instanceFields.values()) keep.add(index);
	// Snapshot the anchors before the live seeds join them: a log with no instance.started falls back
	// to line 0, which may itself be a live tool or agent, and shedding it would take the anchor too.
	const pinned = new Set(keep);
	const droppable: number[][] = [];
	const shedGroup = (indexes: number[]) => {
		// Dedupe first: an agent's `fields` map is keyed by FIELD NAME, so one `agent.updated`
		// patching N fields contributes N references to the SAME line. Sized once per reference the
		// budget below over-estimates the group and sheds live agents whose seeds actually fit.
		const group = [...new Set(indexes)].filter((index) => !pinned.has(index));
		if (group.length > 0) droppable.push(group);
	};
	for (const agent of agents.values()) {
		keep.add(agent.added);
		for (const index of agent.fields.values()) keep.add(index);
		// One group per agent: its field updates are worthless without the `added` that introduced
		// it, so the budget below sheds the whole agent or none of it — never orphan patches.
		shedGroup([agent.added, ...agent.fields.values()]);
	}
	for (const index of tools.values()) { keep.add(index); shedGroup([index]); }
	// Oldest live work first: the newest agents and tools are the ones a consumer is still watching.
	// The instance anchors and field seeds stay out of this list — there is one per instance field, a
	// count fixed by the descriptor's shape, so they never grow the seed set past the cap on their own.
	droppable.sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0));
	return { keep, droppable };
}

async function appendBounded(file: string, line: string, maxBytes: number): Promise<void> {
	await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
	const size = (await stat(file)).size;
	if (size <= maxBytes) return;
	const contents = await readFile(file);
	const targetBytes = Math.max(128, Math.floor(maxBytes / 2));
	// Keep the immutable instance anchor so replay after compaction still has stream identity.
	// The cap is soft for one complete event (and the anchor) rather than truncating JSONL records.
	const lines = contents.toString("utf8").split("\n").filter((item) => item.length > 0);
	const { keep: kept, droppable } = replaySeedIndexes(lines);
	const lineBytes = (index: number) => Buffer.byteLength(lines[index] ?? "") + 1;
	let keptBytes = [...kept].reduce((total, index) => total + lineBytes(index), 0);
	// Bound the live-work seeds against the target BEFORE writing them. They scale with the number of
	// live agents and unfinished tools, not with the cap, so left alone they outgrow maxBytes on their
	// own: the file then never comes back under the cap, every later append pays another full read +
	// rewrite, and the loop below can retain nothing but the newest record. Shedding the stalest seed
	// costs one agent's reconstruction, which is far cheaper than erasing the log. The instance
	// anchors sit outside this budget so a live agent still replays under a cap a few records wide.
	let liveSeedBytes = droppable.reduce((total, group) => total + group.reduce((sum, index) => sum + lineBytes(index), 0), 0);
	for (const group of droppable) {
		if (liveSeedBytes <= targetBytes) break;
		for (const index of group) {
			if (!kept.delete(index)) continue;
			keptBytes -= lineBytes(index);
			liveSeedBytes -= lineBytes(index);
		}
	}
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (kept.has(index)) continue;
		const candidateBytes = lineBytes(index);
		if (keptBytes + candidateBytes > targetBytes) {
			// Always retain the newest complete event even when one record is larger than the soft cap.
			if (index === lines.length - 1) { kept.add(index); keptBytes += candidateBytes; }
			break;
		}
		kept.add(index);
		keptBytes += candidateBytes;
	}
	const retained = [...kept].sort((left, right) => left - right).map((index) => lines[index]).join("\n") + "\n";
	const temp = `${file}.trim-${process.pid}-${Date.now()}`;
	const backup = `${file}.previous`;
	await writeFile(temp, retained, { encoding: "utf8", mode: 0o600 });
	try {
		await unlink(backup).catch(() => undefined);
		await rename(file, backup);
		await rename(temp, file);
		await unlink(backup);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		await rename(backup, file).catch(() => undefined);
		throw error;
	}
}

function boundedText(value: string, max = STRING_LIMIT): string {
	return Array.from(value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, " ").replace(/\s+/g, " ").trim())
		.slice(0, max)
		.join("");
}

function sanitizeValue(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return "[depth bounded]";
	if (typeof value === "string") return boundedText(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, ARRAY_LIMIT).map((item) => sanitizeValue(item, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, ARRAY_LIMIT)) {
			if (item !== undefined) out[boundedText(key, 80)] = sanitizeValue(item, depth + 1);
		}
		return out;
	}
	return undefined;
}

/** The last persisted sequence, plus whether the log ends mid-record — a crash between an append's
 *  open and its write leaves the final line unterminated, and the next append fuses onto it. */
function lastSequence(file: string): { seq: number; needsNewline: boolean } {
	try {
		const contents = readFileSync(file, "utf8");
		const needsNewline = contents.length > 0 && !contents.endsWith("\n");
		const lines = contents.trimEnd().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as { seq?: unknown };
				if (Number.isSafeInteger(parsed.seq) && (parsed.seq as number) >= 1) return { seq: parsed.seq as number, needsNewline };
			} catch {
				/* a torn final line is ignored; scan backwards to the last valid event */
			}
		}
		return { seq: 0, needsNewline };
	} catch {
		/* first activation for this session */
	}
	return { seq: 0, needsNewline: false };
}

function sanitizeInstance(value: InstanceDescriptor): InstanceDescriptor {
	return {
		displayName: boundedText(value.displayName, 80) || "pi",
		status: boundedText(value.status, 64) || "active",
		...(value.persona !== undefined ? { persona: boundedText(value.persona, 64) } : {}),
		...(value.model !== undefined ? { model: boundedText(value.model, 160) } : {}),
		...(value.pid !== undefined ? { pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : 0 } : {}),
		...(value.contextPercent !== undefined ? { contextPercent: Math.max(0, Math.min(100, Number(value.contextPercent) || 0)) } : {}),
		...(value.exocomEnabled !== undefined ? { exocomEnabled: value.exocomEnabled } : {}),
		...(value.color && /^#[0-9A-Fa-f]{3,8}$/.test(value.color) ? { color: value.color } : {}),
	};
}

function sanitizeAgent(value: TelemetryAgentInput): AgentDescriptor {
	return {
		id: boundedText(value.id, 160),
		label: boundedText(value.label, 160) || "agent",
		kind: boundedText(value.kind, 64) || "subagent",
		status: boundedText(value.status, 64) || "running",
		...(value.parentId ? { parentId: boundedText(value.parentId, 160) } : {}),
		...(value.agent ? { agent: boundedText(value.agent, 80) } : {}),
		...(value.persona ? { persona: boundedText(value.persona, 80) } : {}),
		...(value.model ? { model: boundedText(value.model, 160) } : {}),
	};
}

function sanitizeAgentPatch(value: Partial<TelemetryAgentInput>): Partial<AgentDescriptor> {
	return {
		...(value.label !== undefined ? { label: boundedText(value.label, 160) || "agent" } : {}),
		...(value.kind !== undefined ? { kind: boundedText(value.kind, 64) || "subagent" } : {}),
		...(value.status !== undefined ? { status: boundedText(value.status, 64) || "running" } : {}),
		...(value.parentId !== undefined ? { parentId: boundedText(value.parentId, 160) } : {}),
		...(value.agent !== undefined ? { agent: boundedText(value.agent, 80) } : {}),
		...(value.persona !== undefined ? { persona: boundedText(value.persona, 80) } : {}),
		...(value.model !== undefined ? { model: boundedText(value.model, 160) } : {}),
	};
}

function producerSegment(value: string | undefined, fallback: string): string {
	const safe = value?.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
	return safe || fallback;
}

export class TelemetryProducer {
	readonly workspaceId: string;
	readonly filePath: string;
	private readonly options: TelemetryProducerOptions;
	private seq: number;
	private writeChain: Promise<void> = Promise.resolve();
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private instance: InstanceDescriptor | undefined;
	private stopped = false;
	readonly producerId: string;
	readonly producerVersion: string;

	constructor(options: TelemetryProducerOptions) {
		this.options = options;
		this.producerId = producerSegment(options.producerId, TELEMETRY_PRODUCER_ID);
		this.producerVersion = producerSegment(options.producerVersion, TELEMETRY_PRODUCER_VERSION);
		if (options.maxFileBytes !== undefined && (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 512)) throw new RangeError("maxFileBytes must be at least 512");
		this.workspaceId = telemetryWorkspaceId(options.cwd);
		const dir = join(options.agentDir, "telemetry", "v2", this.workspaceId, this.producerId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fileKey = telemetrySessionFileKey(options.sessionId);
		this.filePath = join(dir, `${fileKey}.jsonl`);
		const backup = `${this.filePath}.previous`;
		if (!existsSync(this.filePath) && existsSync(backup)) {
			try { renameSync(backup, this.filePath); } catch { /* a concurrent activation will retry on its own */ }
		} else if (existsSync(this.filePath) && existsSync(backup)) {
			try { unlinkSync(backup); } catch { /* best effort */ }
		}
		try {
			for (const name of readdirSync(dir)) if (name.startsWith(`${fileKey}.jsonl.trim-`)) unlinkSync(join(dir, name));
		} catch { /* best effort cleanup of interrupted compaction scratch files */ }
		const { seq, needsNewline } = lastSequence(this.filePath);
		this.seq = seq;
		// Close a torn tail ONCE, before the first append: otherwise the next record is concatenated
		// onto the partial bytes and BOTH are unreadable, so a consumer replaying the file sees only
		// a sequence gap — a tool started before the crash stays "running" forever.
		if (needsNewline) {
			try { appendFileSync(this.filePath, "\n", { encoding: "utf8", mode: 0o600 }); } catch { /* the write chain reports a real append failure */ }
		}
	}

	start(instance: InstanceDescriptor): void {
		if (this.instance || this.stopped) return;
		this.instance = sanitizeInstance(instance);
		this.publish("instance.started", this.instance);
		const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		if (heartbeatMs > 0) {
			this.heartbeatTimer = setInterval(() => {
				const dynamic = this.options.heartbeat?.() ?? {};
				this.publish("instance.heartbeat", dynamic);
			}, heartbeatMs);
			this.heartbeatTimer.unref?.();
		}
	}

	publish<T extends KnownTelemetryEventType>(type: T, payload: TelemetryPayload<T>): TelemetryEvent<T> | undefined {
		if (this.stopped) return undefined;
		this.seq += 1;
		const event = {
			version: TELEMETRY_VERSION,
			producerId: this.producerId,
			producerVersion: this.producerVersion,
			id: `${this.producerId}:${this.options.sessionId}:${this.seq}`,
			seq: this.seq,
			ts: this.options.now?.() ?? Date.now(),
			sessionId: this.options.sessionId,
			workspaceId: this.workspaceId,
			type,
			payload: projectTelemetryPayload(type, sanitizeValue(payload)) as TelemetryPayload<T>,
		} as TelemetryEvent<T>;
		try {
			this.options.emit(event as TelemetryEvent);
		} catch (error) {
			this.options.onError?.(error);
		}
		const line = `${JSON.stringify(event)}\n`;
		this.writeChain = this.writeChain
			.catch(() => undefined)
			.then(() => appendBounded(this.filePath, line, this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES))
			.catch((error) => { this.options.onError?.(error); });
		return event;
	}

	publishAgentAdded(agent: TelemetryAgentInput): TelemetryEvent<"agent.added"> | undefined {
		return this.publish("agent.added", sanitizeAgent(agent));
	}

	publishAgentUpdated(id: string, patch: Partial<TelemetryAgentInput>): TelemetryEvent<"agent.updated"> | undefined {
		return this.publish("agent.updated", { id: boundedText(id, 160), patch: sanitizeAgentPatch(patch) });
	}

	async flush(): Promise<void> {
		await this.writeChain;
	}

	async stop(reason?: string): Promise<void> {
		if (this.stopped) return;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.publish("instance.stopped", { reason: reason ? boundedText(reason, 120) : "shutdown" });
		this.stopped = true;
		await this.flush();
	}
}

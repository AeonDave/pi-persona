import { appendFile, lstat, mkdir, opendir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
	retentionMs?: number;
}

/** Richer caller input. Prompt/activity/output fields are accepted only so the sink can drop them. */
export type TelemetryAgentInput = AgentDescriptor & { task?: string; detail?: string; output?: string };

const DEFAULT_HEARTBEAT_MS = 5_000;
const STRING_LIMIT = 512;
const ARRAY_LIMIT = 256;
const MAX_DEPTH = 8;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class TelemetryAdmissionError extends Error {
	constructor(message: string) { super(message); this.name = "TelemetryAdmissionError"; }
}

const markerName = (kind: "writer" | "prune") => `${kind}-${process.pid}-${randomUUID()}`;
const markerPattern = /^(writer|prune)-(\d+)-([0-9a-f-]{36})$/;
const workspacePattern = /^[0-9a-f]{24}$/;

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

function validProducerId(value: string): boolean {
	return value !== "." && value !== ".." && /^[A-Za-z0-9._-]{1,96}$/.test(value);
}

function producerSegment(value: string | undefined, fallback: string): string {
	const safe = value?.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
	return safe && validProducerId(safe) ? safe : fallback;
}

function pidState(pid: number): "alive" | "dead" | "unknown" {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	if (pid === process.pid) return "alive";
	try { process.kill(pid, 0); return "alive"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** The supplied agent directory is trusted; linked descendants of its canonical root are not. */
function namespaceParts(root: string, path: string): string[] {
	const parts: string[] = [];
	for (let current = path; current !== root; current = dirname(current)) {
		if (dirname(current) === current) throw new TelemetryAdmissionError("Unsafe telemetry namespace");
		parts.unshift(current);
	}
	return parts;
}

function ensureDirectoriesSync(root: string, path: string, created: string[]): void {
	for (const part of namespaceParts(root, path)) {
		try { mkdirSync(part, { mode: 0o700 }); created.push(part); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (!lstatSync(part).isDirectory()) throw new TelemetryAdmissionError("Unsafe linked telemetry directory");
	}
}

/** Roll back only directories created by this admission attempt, from leaf to root. */
function removeCreatedDirectoriesSync(created: readonly string[], onError?: (error: unknown) => void): void {
	for (let index = created.length - 1; index >= 0; index -= 1) {
		try { rmdirSync(created[index]!); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") reportRetentionError(onError, error);
		}
	}
}

async function safeDirectories(root: string, path: string): Promise<boolean> {
	for (const part of namespaceParts(root, path)) {
		try { if (!(await lstat(part)).isDirectory()) return false; }
		catch (error) { if (isMissing(error)) return false; throw error; }
	}
	return true;
}

function assertSafeArtifactSync(file: string): void {
	try {
		const info = lstatSync(file);
		if (!info.isFile() || info.nlink !== 1) throw new TelemetryAdmissionError("Unsafe linked telemetry artifact");
	} catch (error) { if (!isMissing(error)) throw error; }
}

function assertNoPruneClaimsSync(dir: string): void {
	for (const name of readdirSync(dir)) {
		const match = markerPattern.exec(name);
		if (!match) throw new TelemetryAdmissionError("Unknown telemetry lease marker");
		const marker = join(dir, name);
		let info;
		try { info = lstatSync(marker); } catch (error) { if (isMissing(error)) continue; throw error; }
		if (!info.isFile() || info.nlink !== 1 || info.size !== 0) throw new TelemetryAdmissionError("Unsafe telemetry lease marker");
		if (match[1] === "prune") {
			if (pidState(Number(match[2])) !== "dead") throw new TelemetryAdmissionError("Active telemetry prune claim");
			try { unlinkSync(marker); } catch (error) { if (!isMissing(error)) throw error; }
		}
	}
}

type RetentionErrorSink = ((error: unknown) => void) | undefined;
function reportRetentionError(sink: RetentionErrorSink, error: unknown): void {
	try { sink?.(error); } catch { /* diagnostics must not break the host session */ }
}

const retentionJobs = new Map<string, Promise<void>>();
function scheduleTelemetryRetention(agentDir: string, producerId: string, retentionMs: number, onError: RetentionErrorSink): Promise<void> {
	const key = `${resolve(agentDir)}\0${producerId}`;
	const existing = retentionJobs.get(key);
	if (existing) return existing;
	const job = flushTelemetryRetention(agentDir, producerId, retentionMs, Date.now(), onError)
		.catch((error) => reportRetentionError(onError, error))
		.finally(() => retentionJobs.delete(key));
	retentionJobs.set(key, job);
	return job;
}

async function removeEmptyDir(dir: string): Promise<void> {
	try { await rmdir(dir); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

const artifactPattern = /^([0-9a-f]{16})\.jsonl(?:\.previous|\.trim-\d+-\d+)?$/;
const leaseDirPattern = /^([0-9a-f]{16})\.jsonl\.leases$/;

async function oldArtifacts(dir: string, session: string, cutoff: number): Promise<string[] | undefined> {
	const group = (await readdir(dir)).filter((name) => artifactPattern.exec(name)?.[1] === session);
	for (const name of group) {
		let info;
		try { info = await lstat(join(dir, name)); }
		catch (error) { if (isMissing(error)) return undefined; throw error; }
		if (!info.isFile() || info.nlink !== 1 || info.mtimeMs >= cutoff) return undefined;
	}
	return group;
}

async function hasProtectedWriter(leaseDir: string, ownClaim: string): Promise<boolean> {
	for (const name of await readdir(leaseDir)) {
		if (name === basename(ownClaim)) continue;
		const match = markerPattern.exec(name);
		if (!match) return true;
		const path = join(leaseDir, name);
		let info;
		try { info = await lstat(path); } catch (error) { if (isMissing(error)) continue; throw error; }
		if (!info.isFile() || info.nlink !== 1 || info.size !== 0) return true;
		const state = pidState(Number(match[2]));
		if (state === "unknown" || (match[1] === "writer" && state === "alive")) return true;
		if (state === "dead") {
			try { await unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
		}
	}
	return false;
}

/** Cooperative same-host retention; unknown/linked objects and live writer leases are retained.
 * Pre-protocol processes are protected only by recent writes, not by these leases. */
export async function flushTelemetryRetention(
	agentDir: string, producerId: string, retentionMs: number, now = Date.now(), onError?: (error: unknown) => void,
): Promise<void> {
	if (!validProducerId(producerId)) throw new RangeError("Unsafe telemetry producerId");
	if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new RangeError("retentionMs must be a safe integer >= 0");
	if (retentionMs === 0) return;
	let base: string;
	try { base = await realpath(agentDir); } catch (error) { if (isMissing(error)) return; throw error; }
	const root = join(base, "telemetry", "v2");
	if (!(await safeDirectories(base, root))) return;
	for await (const entry of await opendir(root)) {
		if (!workspacePattern.test(entry.name) || !entry.isDirectory()) continue;
		const workspaceDir = join(root, entry.name);
		const producerDir = join(workspaceDir, producerId);
		try {
			if (!(await safeDirectories(base, producerDir))) continue;
			const sessions = new Set((await readdir(producerDir)).flatMap((name) => {
				const session = artifactPattern.exec(name)?.[1] ?? leaseDirPattern.exec(name)?.[1];
				return session ? [session] : [];
			}));
			for (const session of sessions) {
				const leaseDir = join(producerDir, `${session}.jsonl.leases`);
				let claim: string | undefined;
				try {
					if (await oldArtifacts(producerDir, session, now - retentionMs) === undefined) continue;
					try { await mkdir(leaseDir, { mode: 0o700 }); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
					if (!(await safeDirectories(base, leaseDir))) continue;
					claim = join(leaseDir, markerName("prune"));
					await writeFile(claim, "", { flag: "wx", mode: 0o600 });
					if (await hasProtectedWriter(leaseDir, claim)) continue;
					// Re-enumerate AFTER the claim: a fresh backup/scratch retains the whole group.
					const group = await oldArtifacts(producerDir, session, now - retentionMs);
					if (!group || !(await safeDirectories(base, producerDir))) continue;
					for (const name of group) {
						try { await unlink(join(producerDir, name)); }
						catch (error) { if (!isMissing(error)) throw error; }
					}
				} catch (error) { if (!isMissing(error)) reportRetentionError(onError, error); }
				finally {
					if (claim) {
						try { await unlink(claim); } catch (error) { if (!isMissing(error)) reportRetentionError(onError, error); }
						try { await removeEmptyDir(leaseDir); } catch (error) { reportRetentionError(onError, error); }
					}
				}
			}
			await removeEmptyDir(producerDir);
			await removeEmptyDir(workspaceDir);
		} catch (error) { if (!isMissing(error)) reportRetentionError(onError, error); }
	}
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
	private leasePath: string;
	private retentionSweep: Promise<void> = Promise.resolve();
	readonly producerId: string;
	readonly producerVersion: string;

	constructor(options: TelemetryProducerOptions) {
		this.options = options;
		this.producerId = producerSegment(options.producerId, TELEMETRY_PRODUCER_ID);
		this.producerVersion = producerSegment(options.producerVersion, TELEMETRY_PRODUCER_VERSION);
		if (options.maxFileBytes !== undefined && (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 512)) throw new RangeError("maxFileBytes must be at least 512");
		const retentionMs = options.retentionMs ?? DEFAULT_TELEMETRY_RETENTION_MS;
		if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new RangeError("retentionMs must be a safe integer >= 0");
		this.workspaceId = telemetryWorkspaceId(options.cwd);
		mkdirSync(options.agentDir, { recursive: true, mode: 0o700 });
		const base = realpathSync(options.agentDir);
		const dir = join(base, "telemetry", "v2", this.workspaceId, this.producerId);
		const fileKey = telemetrySessionFileKey(options.sessionId);
		this.filePath = join(dir, `${fileKey}.jsonl`);
		const leaseDir = `${this.filePath}.leases`;
		this.leasePath = join(leaseDir, markerName("writer"));
		const createdDirectories: string[] = [];
		let leaseCreated = false;
		try {
			ensureDirectoriesSync(base, dir, createdDirectories);
			ensureDirectoriesSync(base, leaseDir, createdDirectories);
			const fd = openSync(this.leasePath, "wx", 0o600);
			leaseCreated = true;
			closeSync(fd);
			assertNoPruneClaimsSync(leaseDir);
			for (const name of readdirSync(dir)) {
				if (artifactPattern.exec(name)?.[1] === fileKey) assertSafeArtifactSync(join(dir, name));
			}
		} catch (error) {
			if (leaseCreated) {
				try { unlinkSync(this.leasePath); } catch { /* remove only our unique marker */ }
			}
			removeCreatedDirectoriesSync(createdDirectories, options.onError);
			throw new TelemetryAdmissionError(`Cannot acquire telemetry writer lease: ${error instanceof Error ? error.message : String(error)}`);
		}
		const backup = `${this.filePath}.previous`;
		if (!existsSync(this.filePath) && existsSync(backup)) {
			try { renameSync(backup, this.filePath); } catch { /* a concurrent activation will retry on its own */ }
		} else if (existsSync(this.filePath) && existsSync(backup)) {
			try { unlinkSync(backup); } catch { /* best effort */ }
		}
		try {
			for (const name of readdirSync(dir)) if (artifactPattern.exec(name)?.[1] === fileKey && name.includes(".trim-")) unlinkSync(join(dir, name));
		} catch { /* best effort cleanup of interrupted compaction scratch files */ }
		const { seq, needsNewline } = lastSequence(this.filePath);
		this.seq = seq;
		// Close a torn tail ONCE, before the first append: otherwise the next record is concatenated
		// onto the partial bytes and BOTH are unreadable, so a consumer replaying the file sees only
		// a sequence gap — a tool started before the crash stays "running" forever.
		if (needsNewline) {
			try { appendFileSync(this.filePath, "\n", { encoding: "utf8", mode: 0o600 }); } catch { /* the write chain reports a real append failure */ }
		}
		if (retentionMs > 0) this.retentionSweep = scheduleTelemetryRetention(base, this.producerId, retentionMs, options.onError);
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

	async flushRetention(): Promise<void> { await this.retentionSweep; }

	async stop(reason?: string): Promise<void> {
		if (this.stopped) return;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.publish("instance.stopped", { reason: reason ? boundedText(reason, 120) : "shutdown" });
		this.stopped = true;
		try {
			await this.flush();
			// Retention is shared background maintenance, not part of this writer's lifetime.
			// Keep the lease through terminal writes, but do not delay host shutdown/reload
			// on a sweep of unrelated sessions. flushRetention() remains an explicit join.
		} finally {
			try { await unlink(this.leasePath); } catch (error) { if (!isMissing(error)) reportRetentionError(this.options.onError, error); }
			try { await removeEmptyDir(dirname(this.leasePath)); } catch (error) { reportRetentionError(this.options.onError, error); }
		}
	}
}

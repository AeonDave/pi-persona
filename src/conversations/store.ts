import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isThinkingLevel } from "../core/types.ts";
import { parseVerification } from "../core/worktree-verification.ts";
import type { ConversationCommit, ConversationLease, ConversationListing, ConversationRecord, ConversationResult, ConversationStoreDeps } from "./types.ts";

export const CONVERSATION_ENTRY = "pi-persona:conversation:v1";
export const CONVERSATION_FORGOTTEN_ENTRY = "pi-persona:conversation-forgotten:v1";
export const CONVERSATION_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const CONVERSATION_MAX_LINEAGES = 64;
export const CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN = /^run-[a-z0-9-]{1,80}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const SPEC_KEYS = new Set(["agent", "task", "name", "model", "thinking", "tools", "skills", "role", "outputContract", "isolation", "verification", "mcp", "timeoutMs", "writeSet"]);
const fail = <T>(code: string, error: string): ConversationResult<T> => ({ ok: false, code, error });

function regularPath(path: string): boolean {
	let current = parse(path).root;
	for (const part of path.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
		current = join(current, part);
		try { if (lstatSync(current).isSymbolicLink()) return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return true;
}

function validRecord(value: unknown, owner: string): value is ConversationRecord {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_METADATA_BYTES) return false;
		const r = value as ConversationRecord;
		if (r.owner !== owner || !UUID.test(r.key) || !RUN.test(r.rootRunId) || !RUN.test(r.runId)
			|| (r.previousRunId !== undefined && !RUN.test(r.previousRunId)) || !isAbsolute(r.cwd)
			|| !(r.persona === null || (typeof r.persona === "string" && r.persona.length <= 256))
			|| !HASH.test(r.fingerprint) || !HASH.test(r.transcriptHash) || !Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0
			|| typeof r.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(r.model) || r.model.length > 512
			|| (r.thinking !== undefined && !isThinkingLevel(r.thinking))) return false;
		if (!r.spec || typeof r.spec !== "object" || Array.isArray(r.spec) || typeof r.spec.agent !== "string" || !r.spec.agent || typeof r.spec.task !== "string") return false;
		if (Object.keys(r.spec).some((key) => !SPEC_KEYS.has(key))) return false;
		for (const key of ["tools", "skills", "writeSet"] as const) {
			const v = r.spec[key];
			if (v !== undefined && (!Array.isArray(v) || v.length > 128 || v.some((item) => typeof item !== "string" || item.length > 4096))) return false;
		}
		for (const key of ["name", "model", "role", "outputContract"] as const) if (r.spec[key] !== undefined && typeof r.spec[key] !== "string") return false;
		if (r.spec.thinking !== undefined && !isThinkingLevel(r.spec.thinking)) return false;
		if (r.spec.isolation !== undefined && r.spec.isolation !== "none" && r.spec.isolation !== "worktree") return false;
		if (r.spec.verification !== undefined && !parseVerification(r.spec.verification).ok) return false;
		if (r.spec.mcp !== undefined && typeof r.spec.mcp !== "boolean") return false;
		if (r.spec.timeoutMs !== undefined && (typeof r.spec.timeoutMs !== "number" || !Number.isFinite(r.spec.timeoutMs))) return false;
		if (r.worktree && (!isAbsolute(r.worktree.path) || !isAbsolute(r.worktree.root) || !/^[a-f0-9]{40,64}$/i.test(r.worktree.baseCommit))) return false;
		return true;
	} catch { return false; }
}

/** Session-owned transcript index. Paths are derived from opaque keys, never from callers. */
export class ConversationStore {
	private readonly deps: ConversationStoreDeps;
	private readonly owner: string;
	private readonly directory: string | undefined;
	constructor(deps: ConversationStoreDeps) {
		this.deps = { ...deps };
		const parent = deps.sessionFile && isAbsolute(deps.sessionFile) ? resolve(deps.sessionFile) : undefined;
		const canonical = parent && existsSync(parent) ? realpathSync(parent) : parent;
		this.owner = createHash("sha256").update(`${canonical ?? ""}\0${deps.sessionId}`).digest("hex");
		this.directory = parent && deps.sessionId ? join(dirname(parent), "persona-workers", this.owner) : undefined;
	}

	create(): ConversationResult<ConversationLease> {
		try {
			const prepared = this.prepare();
			if (!prepared.ok) return prepared;
			const guard = this.lock("admission");
			if (!guard.ok) return guard;
			try {
				const quota = this.quota();
				if (quota.count >= CONVERSATION_MAX_LINEAGES || quota.bytes >= CONVERSATION_MAX_TOTAL_BYTES) return fail("quota", "Conversation storage quota exhausted");
				const key = randomUUID();
				return this.makeLease(key);
			} finally { guard.value(); }
		} catch (e) { return fail("storage", String(e)); }
	}

	acquire(runId: string, branchEntries?: readonly unknown[]): ConversationResult<{ record: ConversationRecord; lease: ConversationLease }> {
		let pendingLease: ConversationLease | undefined;
		try {
			const prepared = this.prepare();
			if (!prepared.ok) return prepared;
			const all = this.records(this.deps.entries());
			const selected = all.findLast((r) => r.runId === runId);
			if (!selected) return fail("unavailable", "Conversation is unavailable in this session");
			const latest = all.findLast((r) => r.key === selected.key);
			if (!latest || latest.runId !== runId) return fail("stale", "A later turn already continued this conversation");
			if (this.forgotten(this.deps.entries()).has(selected.key) || existsSync(join(this.directory!, `${selected.key}.forgotten`))) return fail("unavailable", "Conversation has been forgotten");
			if (branchEntries && !this.records(branchEntries).some((r) => r.key === selected.key && r.runId === runId)) return fail("branch", "Conversation is not available on this session branch");
			if (this.expired(latest)) return fail("expired", "Conversation retention has expired");
			const lease = this.makeLease(latest.key, latest);
			if (!lease.ok) return lease;
			pendingLease = lease.value;
			// Re-read after the lock: another owner may have settled while we were acquiring it.
			const check = this.records(this.deps.entries()).findLast((r) => r.key === latest.key);
			if (!check || check.runId !== latest.runId) return fail("stale", "Conversation changed during admission");
			if (!this.usableFile(lease.value.file) || this.hashFile(lease.value.file) !== latest.transcriptHash) return fail("unavailable", "Conversation transcript is missing, incomplete or changed since settlement");
			pendingLease = undefined; // The successful caller now owns the lease and its writer lifecycle.
			return { ok: true, value: { record: latest, lease: lease.value } };
		} catch (e) { return fail("storage", String(e)); }
		finally { pendingLease?.release(); }
	}

	list(branchEntries?: readonly unknown[]): ConversationRecord[] {
		return this.listAll(branchEntries).filter((item) => item.available).map((item) => item.record);
	}

	listAll(branchEntries?: readonly unknown[]): ConversationListing[] {
		try {
			if (!this.directory) return [];
			const entries = this.deps.entries();
			const all = this.records(entries), forgotten = this.forgotten(entries);
			const branch = branchEntries ? this.records(branchEntries) : all;
			const latest = new Map<string, ConversationRecord>();
			for (const record of all) latest.set(record.key, record);
			const out: ConversationListing[] = [];
			for (const r of latest.values()) {
				if (!branch.some((b) => b.key === r.key && b.runId === r.runId)) continue;
				const file = join(this.directory, `${r.key}.jsonl`);
				const pendingMarker = existsSync(join(this.directory, `${r.key}.forgotten`));
				if (forgotten.has(r.key) || pendingMarker) {
					if (existsSync(file) || pendingMarker) out.push({ record: structuredClone(r), available: false, reason: "cleanup-pending" });
					continue;
				}
				let reason: string | undefined;
				if (this.lockIsBusy(join(this.directory, `${r.key}.lock`))) reason = "busy";
				else if (this.expired(r)) reason = "expired";
				else {
					try { if (!this.usableFile(file) || this.hashFile(file) !== r.transcriptHash) reason = "transcript-unavailable"; }
					catch { reason = "transcript-unavailable"; }
				}
				out.push({ record: structuredClone(r), available: reason === undefined, ...(reason === undefined ? {} : { reason }) });
			}
			return out.slice(-CONVERSATION_MAX_LINEAGES);
		} catch { return []; }
	}

	/** Explicit, operator-requested cleanup; callback owns worktree verification/removal. */
	async forget(runId: string, branchEntries?: readonly unknown[]): Promise<ConversationResult<true>> {
		try {
			const prepared = this.prepare();
			if (!prepared.ok) return prepared;
			const entries = this.deps.entries(), all = this.records(entries);
			const selected = all.findLast((r) => r.runId === runId);
			if (!selected) return fail("unavailable", "Conversation is unavailable in this session");
			if (all.findLast((r) => r.key === selected.key)?.runId !== runId) return fail("stale", "A later conversation turn exists");
			if (branchEntries && !this.records(branchEntries).some((r) => r.key === selected.key && r.runId === runId)) return fail("branch", "Conversation is not available on this session branch");
			const locked = this.lock(selected.key);
			if (!locked.ok) return locked;
			try {
				const file = join(this.directory!, `${selected.key}.jsonl`);
				const marker = join(this.directory!, `${selected.key}.forgotten`);
				if (existsSync(file) && (!regularPath(file) || !lstatSync(file).isFile())) return fail("unsafe-path", "Transcript path is unsafe");
				if (existsSync(marker) && (!regularPath(marker) || !lstatSync(marker).isFile())) return fail("unsafe-path", "Conversation cleanup marker is unsafe");
				const current = this.deps.entries();
				if (this.records(current).findLast((r) => r.key === selected.key)?.runId !== runId) return fail("stale", "Conversation changed during admission");
				const recorded = this.forgotten(current).has(selected.key);
				let markerState = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
				if (markerState !== undefined && markerState !== "pending" && markerState !== "cleaned") return fail("cleanup", "Conversation cleanup state is invalid");
				if (!recorded && markerState === undefined) { writeFileSync(marker, "pending", { flag: "wx", mode: 0o600 }); markerState = "pending"; }
				if (!recorded && markerState !== "cleaned" && selected.worktree) {
					if (!this.deps.removeWorktree) { unlinkSync(marker); return fail("cleanup", "Worktree cleanup is unavailable"); }
					const cleaned = await this.deps.removeWorktree(structuredClone(selected));
					if (!cleaned.ok) { unlinkSync(marker); return fail("cleanup", cleaned.error); }
				}
				if (!existsSync(marker)) writeFileSync(marker, "cleaned", { flag: "wx", mode: 0o600 });
				else if (markerState !== "cleaned") writeFileSync(marker, "cleaned", { flag: "w", mode: 0o600 });
				if (!recorded) this.deps.append(CONVERSATION_FORGOTTEN_ENTRY, { owner: this.owner, key: selected.key, runId });
				if (existsSync(file)) {
					if (!regularPath(file) || !lstatSync(file).isFile()) return fail("unsafe-path", "Transcript path changed during cleanup");
					unlinkSync(file);
				}
				unlinkSync(marker);
				return { ok: true, value: true };
			} finally { locked.value(); }
		} catch (error) { return fail("storage", String(error)); }
	}

	private forgotten(entries: readonly unknown[]): Set<string> {
		const out = new Set<string>();
		for (const raw of entries) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
			if (entry.type !== "custom" || entry.customType !== CONVERSATION_FORGOTTEN_ENTRY) continue;
			const data = entry.data as { owner?: unknown; key?: unknown; runId?: unknown } | null;
			if (data && typeof data.owner === "string" && data.owner !== this.owner) continue;
			if (!data || data.owner !== this.owner || typeof data.key !== "string" || !UUID.test(data.key) || typeof data.runId !== "string" || !RUN.test(data.runId)) throw new Error("Corrupt forgotten conversation history");
			out.add(data.key);
		}
		return out;
	}

	private records(entries: readonly unknown[]): ConversationRecord[] {
		const out: ConversationRecord[] = [];
		const seenRuns = new Set<string>();
		const latest = new Map<string, ConversationRecord>();
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
			if (e.type !== "custom" || e.customType !== CONVERSATION_ENTRY) continue;
			if (e.data && typeof e.data === "object" && typeof (e.data as { owner?: unknown }).owner === "string" && (e.data as { owner: string }).owner !== this.owner) continue;
			if (!validRecord(e.data, this.owner)) throw new Error("Corrupt conversation history");
			const record = structuredClone(e.data), previous = latest.get(record.key);
			if (seenRuns.has(record.runId) || (previous ? record.rootRunId !== previous.rootRunId || record.previousRunId !== previous.runId : record.rootRunId !== record.runId || record.previousRunId !== undefined)) throw new Error("Ambiguous conversation history");
			seenRuns.add(record.runId);
			latest.set(record.key, record);
			out.push(record);
		}
		return out;
	}
	private expired(record: ConversationRecord): boolean { return (this.deps.now?.() ?? Date.now()) - record.updatedAt > CONVERSATION_RETENTION_MS; }
	private prepare(): ConversationResult<true> {
		if (!this.directory) return fail("sessionless", "A persistent supervisor session is required");
		if (!regularPath(this.directory)) return fail("unsafe-path", "Conversation storage contains a symbolic link");
		mkdirSync(this.directory, { recursive: true });
		if (!regularPath(this.directory) || !statSync(this.directory).isDirectory()) return fail("unsafe-path", "Conversation storage directory is unsafe");
		return { ok: true, value: true };
	}
	private usableFile(file: string): boolean {
		try { const s = lstatSync(file); return regularPath(file) && s.isFile() && s.size > 0 && s.size <= CONVERSATION_MAX_FILE_BYTES; }
		catch { return false; }
	}
	private hashFile(file: string): string {
		const fd = openSync(file, "r");
		try {
			const before = fstatSync(fd);
			if (!before.isFile() || before.size < 1 || before.size > CONVERSATION_MAX_FILE_BYTES) throw new Error("Invalid conversation transcript size");
			const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
			let total = 0;
			for (;;) {
				const n = readSync(fd, buffer, 0, buffer.length, null);
				if (!n) break;
				total += n;
				if (total > CONVERSATION_MAX_FILE_BYTES) throw new Error("Conversation transcript exceeded quota during reading");
				hash.update(buffer.subarray(0, n));
			}
			const after = fstatSync(fd);
			if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Conversation transcript changed during reading");
			return hash.digest("hex");
		} finally { closeSync(fd); }
	}
	private quota(): { count: number; bytes: number } {
		let count = 0, bytes = 0;
		for (const name of readdirSync(this.directory!)) {
			if (!/^[0-9a-f-]+\.(?:jsonl|lock)$/i.test(name)) continue;
			const s = lstatSync(join(this.directory!, name));
			if (s.isSymbolicLink() || !s.isFile()) throw new Error("Unsafe conversation storage entry");
			if (name.endsWith(".jsonl")) { count++; bytes += s.size; }
			else if (!existsSync(join(this.directory!, name.replace(/\.lock$/, ".jsonl")))) count++;
		}
		return { count, bytes };
	}
	/** Listing is read-only: only a positively identified dead owner is recoverable. */
	private lockIsBusy(path: string): boolean {
		try {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return true;
			const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
			if (!Number.isSafeInteger(data.pid) || !data.pid || data.pid < 1) return true;
			try { process.kill(data.pid, 0); return true; }
			catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
		} catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
	}
	private lock(name: string): ConversationResult<() => void> {
		const path = join(this.directory!, `${name}.lock`);
		const token = randomUUID();
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(path, "wx", 0o600);
				try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
				return { ok: true, value: () => { try { if (!lstatSync(path).isSymbolicLink() && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path); } catch { /* already released */ } } };
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail("storage", String(e));
				try {
					const info = lstatSync(path);
					if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return fail("busy", "Conversation lock is invalid");
					const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
					if (!Number.isSafeInteger(data.pid) || !data.pid || data.pid < 1) return fail("busy", "Conversation lock owner is unknown");
					try { process.kill(data.pid, 0); return fail("busy", "Conversation is already in use"); }
					catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") return fail("busy", "Conversation lock owner cannot be verified"); }
					const again = lstatSync(path);
					if (again.ino !== info.ino || again.mtimeMs !== info.mtimeMs || again.size !== info.size) return fail("busy", "Conversation lock changed");
					unlinkSync(path);
				} catch { return fail("busy", "Conversation lock cannot be verified"); }
			}
		}
		return fail("busy", "Conversation is already in use");
	}
	private makeLease(key: string, previous?: ConversationRecord): ConversationResult<ConversationLease> {
		const locked = this.lock(key);
		if (!locked.ok) return locked;
		const file = join(this.directory!, `${key}.jsonl`);
		let released = false, committed = false;
		const lease: ConversationLease = {
			key, file,
			release: () => {
				if (released) return;
				try {
					// Unsettled fresh attempts have no index entry through which forget could reach
					// them. The caller releases only after the writer has stopped.
					if (!previous && !committed && !this.records(this.deps.entries()).some((r) => r.key === key)
						&& existsSync(file) && regularPath(file) && lstatSync(file).isFile()) unlinkSync(file);
				} catch { /* A path or ownership that cannot be verified is retained. */ }
				finally { released = true; locked.value(); }
			},
			commit: (fields: ConversationCommit) => {
				if (released || committed) return fail("lease", "Conversation lease is no longer writable");
				try {
					if (!this.usableFile(file)) return fail("unavailable", "Conversation transcript missing or exceeds per-conversation quota");
					const record: ConversationRecord = { ...fields, key, owner: this.owner, transcriptHash: this.hashFile(file), updatedAt: this.deps.now?.() ?? Date.now() };
					if (!validRecord(record, this.owner) || (previous ? record.rootRunId !== previous.rootRunId || record.previousRunId !== previous.runId : record.rootRunId !== record.runId || record.previousRunId !== undefined)) return fail("invalid", "Invalid conversation metadata or lineage");
					const guard = this.lock("admission");
					if (!guard.ok) return guard;
					try {
						if (this.quota().bytes > CONVERSATION_MAX_TOTAL_BYTES) return fail("quota", "Conversation total storage quota exceeded");
						const records = this.records(this.deps.entries());
						if (records.some((r) => r.runId === record.runId)) return fail("conflict", "Conversation run id already exists");
						if (previous && records.findLast((r) => r.key === key)?.runId !== previous.runId) return fail("stale", "Conversation changed during the turn");
						this.deps.append(CONVERSATION_ENTRY, structuredClone(record));
						committed = true;
						return { ok: true, value: structuredClone(record) };
					} finally { guard.value(); }
				} catch (e) { return fail("storage", String(e)); }
			},
		};
		return { ok: true, value: lease };
	}
}

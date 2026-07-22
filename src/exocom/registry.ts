/** exocom workspace registry — one JSON file per live instance. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { agentsDir, registryPath } from "./paths.ts";

export interface RegistryEntry {
	/** `name` is display-only — NOT unique, NOT a lookup key. The registry FILE is keyed by
	 *  `session_id` (via `sessionKey`), so two instances launched under the SAME persona name
	 *  persist as two distinct files; a shared name is disambiguated only at display time
	 *  (see plane.ts's `listPeers()` → "elite"/"elite#2"). */
	session_id: string; name: string; persona: string; purpose: string; color: string; model: string;
	pid: number; endpoint: string; cwd: string; context_pct: number; inbox: number;
	heartbeat_at: string;
	public_key?: string;
}

const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g;
const HAS_CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/;

export function normalizeMetadataText(value: unknown, max: number, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	const clean = value.normalize("NFKC").replace(CONTROL_OR_MARKUP, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, max).join("") || fallback;
}

export function normalizePeerName(value: unknown): string {
	return normalizeMetadataText(value, 48, "peer").replace(/[*#\[\]{}]/g, "-");
}

function opaqueString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > max || HAS_CONTROL_OR_MARKUP.test(value)) return undefined;
	return value;
}

export function normalizeRegistryEntry(value: unknown): RegistryEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const e = value as Record<string, unknown>;
	const sessionId = opaqueString(e.session_id, 128);
	const endpoint = opaqueString(e.endpoint, 1_024);
	const heartbeatAt = opaqueString(e.heartbeat_at, 128);
	if (!sessionId || !/^[A-Za-z0-9._:-]+$/.test(sessionId) || !endpoint || !heartbeatAt || !Number.isFinite(Date.parse(heartbeatAt))) return undefined;
	if (!Number.isInteger(e.pid) || (e.pid as number) <= 0) return undefined;
	const contextPct = typeof e.context_pct === "number" && Number.isFinite(e.context_pct) ? Math.max(0, Math.min(100, e.context_pct)) : 0;
	const inbox = typeof e.inbox === "number" && Number.isFinite(e.inbox) ? Math.max(0, Math.min(1_000_000, Math.floor(e.inbox))) : 0;
	const publicKey = opaqueString(e.public_key, 256);
	return {
		session_id: sessionId,
		name: normalizePeerName(e.name),
		persona: normalizeMetadataText(e.persona, 64),
		purpose: normalizeMetadataText(e.purpose, 240),
		color: typeof e.color === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(e.color) ? e.color : "#36F9F6",
		model: normalizeMetadataText(e.model, 160, "unknown"),
		pid: e.pid as number,
		endpoint,
		cwd: normalizeMetadataText(e.cwd, 1_024),
		context_pct: contextPct,
		inbox,
		heartbeat_at: new Date(Date.parse(heartbeatAt)).toISOString(),
		...(publicKey && /^[A-Za-z0-9+/]+={0,2}$/.test(publicKey) ? { public_key: publicKey } : {}),
	};
}

export function registryEntryFixture(over: Partial<RegistryEntry>): RegistryEntry {
	return { session_id: "s", name: "n", persona: "", purpose: "", color: "#36F9F6", model: "m",
		pid: 0, endpoint: "/e", cwd: "/", context_pct: 0, inbox: 0,
		heartbeat_at: new Date(0).toISOString(), ...over };
}

/** Short, fs-safe registry key for a session_id (mirrors paths.ts's `workspaceHash`). Keying the
 *  registry FILE by this — rather than by the display `name` — makes two instances launched
 *  under the SAME persona name collision-proof BY CONSTRUCTION: distinct session_ids always land
 *  in distinct files, so there is no name-collision window to atomically claim/suffix (the old
 *  `claimEntry` existed only because the name itself was the file key). */
export function sessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function writeEntry(agentDir: string, hash: string, entry: RegistryEntry): void {
	let safe = normalizeRegistryEntry(entry);
	if (!safe) throw new Error("exocom registry: invalid entry");
	const dir = agentsDir(agentDir, hash);
	mkdirSync(dir, { recursive: true });
	const final = registryPath(agentDir, hash, sessionKey(safe.session_id));
	if (!safe.public_key && existsSync(final)) {
		try {
			const existing = normalizeRegistryEntry(JSON.parse(readFileSync(final, "utf8")));
			if (existing?.session_id === safe.session_id && existing.public_key) {
				safe = { ...safe, public_key: existing.public_key };
			}
		} catch { /* a malformed previous entry contributes no authentication state */ }
	}
	const tmp = `${final}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, final);
	} catch (err) {
		try { unlinkSync(tmp); } catch { /* best-effort */ }
		throw err;
	}
}

export function readAll(agentDir: string, hash: string): RegistryEntry[] {
	const dir = agentsDir(agentDir, hash);
	if (!existsSync(dir)) return [];
	const out: RegistryEntry[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const e = normalizeRegistryEntry(JSON.parse(readFileSync(registryPath(agentDir, hash, f.slice(0, -5)), "utf8")));
			if (e && f.slice(0, -5) === sessionKey(e.session_id)) out.push(e);
		} catch { /* skip malformed */ }
	}
	return out;
}

export function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Remove dead-pid AND stale-heartbeat entries; return the live set (R7). */
export function prune(
	agentDir: string, hash: string,
	opts: { now: number; staleMs: number; isAlive?: (pid: number) => boolean },
): RegistryEntry[] {
	const alive = opts.isAlive ?? isAlive;
	const live: RegistryEntry[] = [];
	for (const e of readAll(agentDir, hash)) {
		const heartbeat = Date.parse(e.heartbeat_at);
		const stale = !Number.isFinite(heartbeat) || opts.now - heartbeat > opts.staleMs;
		if (alive(e.pid) && !stale) { live.push(e); continue; }
		removeEntry(agentDir, hash, e.session_id);
	}
	return live;
}

export function removeEntry(agentDir: string, hash: string, sessionId: string): void {
	try { unlinkSync(registryPath(agentDir, hash, sessionKey(sessionId))); } catch { /* best-effort */ }
}

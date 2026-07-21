/** exocom workspace registry — one JSON file per live instance. */
import { createHash } from "node:crypto";
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
	const dir = agentsDir(agentDir, hash);
	mkdirSync(dir, { recursive: true });
	const final = registryPath(agentDir, hash, sessionKey(entry.session_id));
	const tmp = `${final}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
	renameSync(tmp, final);
}

export function readAll(agentDir: string, hash: string): RegistryEntry[] {
	const dir = agentsDir(agentDir, hash);
	if (!existsSync(dir)) return [];
	const out: RegistryEntry[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			const e = JSON.parse(readFileSync(registryPath(agentDir, hash, f.slice(0, -5)), "utf8")) as RegistryEntry;
			if (typeof e?.session_id === "string" && typeof e.name === "string") out.push(e);
		} catch { /* skip malformed */ }
	}
	return out;
}

export function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove dead-pid AND stale-heartbeat entries; return the live set (R7). */
export function prune(
	agentDir: string, hash: string,
	opts: { now: number; staleMs: number; isAlive?: (pid: number) => boolean },
): RegistryEntry[] {
	const alive = opts.isAlive ?? isAlive;
	const live: RegistryEntry[] = [];
	for (const e of readAll(agentDir, hash)) {
		const stale = opts.now - Date.parse(e.heartbeat_at) > opts.staleMs;
		if (alive(e.pid) && !stale) { live.push(e); continue; }
		removeEntry(agentDir, hash, e.session_id);
	}
	return live;
}

export function removeEntry(agentDir: string, hash: string, sessionId: string): void {
	try { unlinkSync(registryPath(agentDir, hash, sessionKey(sessionId))); } catch { /* best-effort */ }
}

import { unlinkSync } from "node:fs";
import { registryPath } from "../../src/exocom/paths.ts";
import { sessionKey, type RegistryEntry } from "../../src/exocom/registry.ts";

/** A complete, valid registry entry with test defaults; override only what the test cares about. */
export function registryEntryFixture(over: Partial<RegistryEntry>): RegistryEntry {
	return { session_id: "s", name: "n", persona: "", purpose: "", color: "#36F9F6", model: "m",
		pid: 0, endpoint: "/e", cwd: "/", context_pct: 0, inbox: 0,
		heartbeat_at: new Date(0).toISOString(), ...over };
}

/** Simulate a registry entry vanishing underneath its owner (eviction, prune or a crash cleanup). */
export function deleteRegistryFile(agentDir: string, hash: string, sessionId: string): void {
	try { unlinkSync(registryPath(agentDir, hash, sessionKey(sessionId))); } catch { /* already absent */ }
}

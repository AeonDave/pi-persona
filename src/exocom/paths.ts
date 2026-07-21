/** exocom path layout — workspace-scoped registry + per-instance endpoint. Pure. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export function workspaceHash(projectRoot: string): string {
	return createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 24);
}
export function exocomRoot(agentDir: string, hash: string): string {
	return join(agentDir, "pi-persona", "exocom", hash);
}
export function agentsDir(agentDir: string, hash: string): string {
	return join(exocomRoot(agentDir, hash), "agents");
}
export function registryPath(agentDir: string, hash: string, key: string): string {
	return join(agentsDir(agentDir, hash), `${key}.json`);
}
export function socketPath(agentDir: string, hash: string, sessionId: string): string {
	return join(exocomRoot(agentDir, hash), "sockets", `${sessionId}.sock`);
}
export function endpoint(agentDir: string, hash: string, sessionId: string, platform: NodeJS.Platform): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-exocom-${sessionId}`;
	return socketPath(agentDir, hash, sessionId);
}

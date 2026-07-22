/** exocom path layout — workspace-scoped registry + per-instance endpoint. Pure. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function shortHash(value: string, length = 16): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function workspaceHash(projectRoot: string): string {
	const resolved = resolve(projectRoot);
	const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
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
export function socketPath(_agentDir: string, hash: string, sessionId: string): string {
	// sockaddr_un is only 104 bytes on macOS and 108 on Linux. Keep both directory and
	// filename fixed-size, outside a potentially long ~/.pi path.
	return join(tmpdir(), `pi-exocom-${shortHash(hash)}`, `${shortHash(sessionId, 20)}.sock`);
}
export function endpoint(agentDir: string, hash: string, sessionId: string, platform: NodeJS.Platform): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-exocom-${shortHash(hash)}-${shortHash(sessionId, 20)}`;
	return socketPath(agentDir, hash, sessionId);
}

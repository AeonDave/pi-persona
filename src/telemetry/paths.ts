import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Stable workspace scope shared by every telemetry producer, independent of plugin storage. */
export function telemetryWorkspaceId(cwd: string): string {
	const resolved = resolve(cwd);
	const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/** Opaque filename component; the original session id remains only inside validated envelopes. */
export function telemetrySessionFileKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

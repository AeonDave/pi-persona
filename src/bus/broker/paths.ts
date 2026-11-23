/**
 * Session-scoped broker endpoint — the supervisor hosts one bus PER SESSION, so two
 * concurrent supervisors never share it (spec B1). Windows uses a named pipe; every other
 * platform a Unix domain socket in a per-user private directory under the temp dir, whose
 * fixed-size hashed names keep the path inside `sun_path` for any home or session id.
 * Pure (home/platform/tmp injectable).
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { shortHash } from "../endpoint.ts";

export function sanitizeSegment(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function brokerEndpoint(sessionId: string, home: string = homedir(), platform: NodeJS.Platform = process.platform, tmp: string = tmpdir()): string {
	const sid = sanitizeSegment(sessionId) || "default";
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-${sanitizeSegment(home)}-${sid}`;
	return join(tmp, `pi-broker-${shortHash(home, 12)}`, `${shortHash(sid, 16)}.sock`);
}

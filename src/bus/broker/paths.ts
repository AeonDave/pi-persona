/**
 * Session-scoped broker endpoint — the supervisor hosts one bus PER SESSION, so two
 * concurrent supervisors never share it (spec B1). Windows uses a named pipe, every other
 * platform a Unix domain socket under the user's Pi dir. Pure (home/platform injectable).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function sanitizeSegment(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function brokerEndpoint(sessionId: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
	const sid = sanitizeSegment(sessionId) || "default";
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-${sanitizeSegment(home)}-${sid}`;
	return join(home, ".pi", "agent", "pi-persona", `broker-${sid}.sock`);
}

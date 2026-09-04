/**
 * Session-scoped broker endpoint — the supervisor hosts one bus PER SESSION, so two
 * concurrent supervisors never share it (spec B1). Windows uses a named pipe, every other
 * platform a Unix domain socket under the user's Pi dir. Pure (home/platform injectable).
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** AF_UNIX `sun_path` is 104 bytes on macOS/BSD and 108 on Linux, NUL included — a socket
 *  path over the smallest of those makes both `listen` and `connect` fail outright. */
const MAX_SUN_PATH = 103;

export function sanitizeSegment(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function brokerEndpoint(sessionId: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
	const sid = sanitizeSegment(sessionId) || "default";
	if (platform === "win32") return `\\\\.\\pipe\\pi-persona-${sanitizeSegment(home)}-${sid}`;
	const dir = join(home, ".pi", "agent", "persona");
	const endpoint = join(dir, `broker-${sid}.sock`);
	if (Buffer.byteLength(endpoint) <= MAX_SUN_PATH) return endpoint;
	// Session ids are uuidv7 (36 chars), so an ordinary-but-longish $HOME already pushes the
	// readable name past sun_path; a hashed one is short and still derived purely from the
	// session id, so host and client compute the same endpoint independently. The hashed form
	// costs `$HOME` + 41 bytes, so a $HOME past 62 bytes stays out of reach either way —
	// nothing under the user's own dir would fit.
	return join(dir, `b-${createHash("sha1").update(sid).digest("hex").slice(0, 12)}.sock`);
}

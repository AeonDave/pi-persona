/** Local-endpoint helpers shared by the broker and exocom: fixed-size names and the private
 *  POSIX socket directory. Node built-ins only. */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A fixed-length name component, so an endpoint path stays inside `sockaddr_un` (104 bytes on
 *  macOS, 108 on Linux) whatever the length of the value it identifies. */
export function shortHash(value: string, length = 16): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Longest bindable socket path: `sockaddr_un.sun_path` is 104 bytes on macOS (108 on Linux) with
 *  the terminating NUL. Node binds a longer path silently truncated, possibly outside the private
 *  directory, so an over-long endpoint must fail before it is ever bound. */
export const MAX_ENDPOINT_BYTES = 103;

/** Create (or adopt) the directory of a POSIX socket as a private one: a real directory, owned by
 *  this user, mode 0700. A squatted, foreign or symlinked directory throws, so the caller fails
 *  closed instead of binding where another user can connect; so does a path over
 *  `MAX_ENDPOINT_BYTES` (a long TMPDIR). No-op on Windows (named pipes have no
 *  directory). `label` names the plane in the error text. */
export function preparePrivateEndpointDir(endpoint: string, label: string, platform: NodeJS.Platform = process.platform): void {
	if (platform === "win32") return;
	const bytes = Buffer.byteLength(endpoint);
	if (bytes > MAX_ENDPOINT_BYTES) throw new Error(`${label}: socket path too long (${bytes} > ${MAX_ENDPOINT_BYTES} bytes); shorten TMPDIR: ${endpoint}`);
	const dir = dirname(endpoint);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}: unsafe socket directory ${dir}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label}: socket directory is not owned by this user: ${dir}`);
	chmodSync(dir, 0o700);
}

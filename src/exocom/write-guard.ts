/** Advisory write-vs-claim overlap guard — warn-then-allow (Task 7). Pure except WriteWarnings'
 *  memory. Imports only `../core/ownership.ts` (path overlap) and `./untrusted.ts` (the sanitizer
 *  shared by every exocom surface that renders peer-authored ledger fields), per layering. */
import { posix, win32 } from "node:path";
import { normalizeWritePath, pathsOverlap } from "../core/ownership.ts";
import { untrusted, UNTRUSTED_MAX } from "./untrusted.ts";
import type { LedgerClaim } from "./ledger.ts";

/** Built-in tools whose `input.path` can land a write; the only ones this guard inspects. */
export const WRITE_TOOLS = new Set(["write", "edit"]);

/** Pi's write/edit tools accept a path relative to `cwd` OR an absolute one; the ledger's
 *  write_set is always repo-relative (`writeSetPathError`). An absolute path must be relativized
 *  against `cwd` before the overlap check, or it silently never matches a repo-relative claim.
 *  Windows-vs-POSIX syntax is picked from the PATH ITSELF (same rule as `normalizeWritePath`),
 *  never from the host platform, so the same claim overlaps whichever spelling this host's
 *  filesystem actually produces. A path whose relative form escapes `cwd` (starts with "..") is
 *  compared as-is: no repo-relative claim can ever own it. */
function relativizeAbsolute(path: string, cwd: string): string {
	const windows = normalizeWritePath(path).windows || normalizeWritePath(cwd).windows;
	const mod = windows ? win32 : posix;
	const trimmed = path.trim();
	if (!mod.isAbsolute(trimmed)) return path;
	const rel = mod.relative(cwd.trim(), trimmed).split(/[\\/]+/).join("/");
	return rel.startsWith("..") ? path : rel;
}

/** The first live claim (never the caller's own) whose write_set overlaps `path`. `cwd`
 *  relativizes an absolute `path` first (see {@link relativizeAbsolute}); omit it to compare
 *  `path` as-is, for callers that only ever see repo-relative paths. */
export function peerClaimFor(
	path: string,
	claims: readonly LedgerClaim[],
	self: string,
	cwd?: string,
): LedgerClaim | undefined {
	const target = normalizeWritePath(cwd ? relativizeAbsolute(path, cwd) : path);
	return claims.find((claim) =>
		claim.from_session !== self && claim.write_set.some((ws) => pathsOverlap(target, normalizeWritePath(ws))),
	);
}

/** One warning per (claim, normalized path) — the retry that follows a block is allowed through. */
export function writeWarningKey(claim: LedgerClaim, path: string): string {
	return `${claim.msg_id}|${normalizeWritePath(path).value}`;
}

/** A single claim's write_set is peer-controlled in length up to 64 paths (envelope.ts); the
 *  rendered warning stays one bounded line rather than growing with the claim — the same shape
 *  status.ts's `renderWriteSet` uses for the ledger view. */
const MAX_WRITE_SET_ENTRIES = 8;

function renderWriteSet(writeSet: readonly string[]): string {
	const paths = writeSet.map((path) => untrusted(path, UNTRUSTED_MAX.writePath));
	if (paths.length <= MAX_WRITE_SET_ENTRIES) return paths.join(", ");
	return `${paths.slice(0, MAX_WRITE_SET_ENTRIES).join(", ")}, +${paths.length - MAX_WRITE_SET_ENTRIES} more`;
}

/** Build the write-guard's tool-result reason. `claim.slice`, `claim.write_set`, and `label` are
 *  all PEER-AUTHORED and only length-bounded at the wire (envelope.ts); this reason reaches both
 *  a terminal notification and the model's tool result, so every peer field is sanitized
 *  ({@link untrusted}) before it is interpolated. `path` is the caller's own tool argument, not
 *  peer-authored, and is passed through unsanitized. Exported (rather than built inline in
 *  hooks.ts) so the sanitization is directly testable and the hook stays thin. */
export function writeWarningReason(path: string, claim: LedgerClaim, label: string): string {
	const who = untrusted(label, UNTRUSTED_MAX.label);
	const slice = untrusted(claim.slice, UNTRUSTED_MAX.slice);
	const writeSet = renderWriteSet(claim.write_set);
	return `exocom: ${path} is inside ${who}'s open claim (${slice}: ${writeSet}) — coordinate with exocom_ask or claim it; call the tool again to proceed (this warning shows once per path)`;
}

/** Warn-once memory for the write guard. A bare unbounded set would grow for the life of the
 *  install on a long session with many distinct claim+path pairs; caps at `maxEntries` (like the
 *  sibling `SeenMessages` in guards.ts) and drops the oldest insertion first once exceeded. */
export class WriteWarnings {
	private readonly maxEntries: number;
	private readonly keys = new Map<string, number>();
	constructor(maxEntries = 4096) {
		this.maxEntries = maxEntries;
	}
	seen(key: string): boolean {
		return this.keys.has(key);
	}
	remember(key: string): void {
		this.keys.set(key, this.keys.size);
		if (this.keys.size > this.maxEntries) {
			const oldest = this.keys.keys().next().value;
			if (oldest !== undefined) this.keys.delete(oldest);
		}
	}
	clear(): void {
		this.keys.clear();
	}
}

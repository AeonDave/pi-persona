/**
 * Sanitizer for PEER-AUTHORED text — shared by every exocom surface that renders a peer-authored
 * field into a status report, a UI notification, or a tool result the model reads: `slice`,
 * `write_set` entries, `question`, and every peer display name/label. Every such field is only
 * length-bounded at the wire boundary (envelope.ts) — a hostile peer can put terminal escapes or
 * instruction-shaped text in any of them. `untrusted()` strips terminal controls, collapses the
 * field to one line, and bounds its length before the value is ever interpolated downstream. One
 * shared helper (rather than a local copy per surface) so a fix here reaches every surface, and
 * `UNTRUSTED_MAX` is the single set of per-field caps every surface renders against.
 */
import { stripTerminalControls } from "../core/fence.ts";

/** Strip terminal controls, collapse the field to one line, and bound its length. Every
 *  peer-authored field goes through this before it is ever interpolated into a report, a
 *  notification, or a tool result. */
export function untrusted(value: string, max: number): string {
	return stripTerminalControls(value).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Per-field length caps shared across every surface that renders these ledger fields, so the
 *  bounds cannot drift between (e.g.) the status view and a write-guard warning. */
export const UNTRUSTED_MAX = {
	slice: 80,
	writePath: 120,
	question: 200,
	label: 48,
} as const;

/** A single claim's write_set is peer-controlled in length up to 64 paths (envelope.ts); the
 *  rendered row stays one bounded line rather than growing with the claim — shared by the ledger
 *  status view (status.ts) and the write-guard warning (write-guard.ts) so the shape can't drift. */
const MAX_WRITE_SET_ENTRIES = 8;

/** Sanitize and bound-format a peer's `write_set` for display: `"a, b, c"`, or the first
 *  {@link MAX_WRITE_SET_ENTRIES} entries plus `"... +N more"` once it exceeds that count. */
export function renderWriteSet(writeSet: readonly string[]): string {
	const paths = writeSet.map((path) => untrusted(path, UNTRUSTED_MAX.writePath));
	if (paths.length <= MAX_WRITE_SET_ENTRIES) return paths.join(", ");
	return `${paths.slice(0, MAX_WRITE_SET_ENTRIES).join(", ")}, +${paths.length - MAX_WRITE_SET_ENTRIES} more`;
}

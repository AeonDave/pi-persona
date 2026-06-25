/**
 * Identity helpers: name sanitisation, child labels, and run ids.
 *
 * Pure module — no Pi imports. The single source of truth for how names are
 * formed, so engine, progress, and (later) the bus never drift. The stateful
 * run-id counter lives in the engine; the formatting here stays deterministic.
 */

/** Lowercase and reduce to `[a-z0-9-]`, collapsing and trimming `-`. */
export function sanitizeNamePart(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** A human/log label for a delegated child; fan-out copies get a 1-based suffix. */
export function childLabel(agent: string, index?: number): string {
	const base = sanitizeNamePart(agent) || "agent";
	return index === undefined ? base : `${base}#${index + 1}`;
}

/** A stable run id from a monotonic sequence + timestamp (ms). Deterministic. */
export function formatRunId(seq: number, nowMs: number): string {
	return `r${nowMs.toString(36)}-${seq.toString(36)}`;
}

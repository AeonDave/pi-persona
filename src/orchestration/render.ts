/**
 * Shared rendering of a deliberation result — turn a member's structured fields into
 * readable prose, NOT the raw JSON envelope. Used by every vote-style strategy (`magi`,
 * `council-rounds`) so a ruling/dissent reads as text, never as tool JSON.
 */

import type { AgentResult } from "./types.ts";

/** A member's human-readable position from its structured fields (result + output). */
export function readableRuling(r: AgentResult): string {
	const s = r.structured;
	if (s) {
		const parts: string[] = [];
		if (typeof s.result === "string" && s.result.trim()) parts.push(s.result.trim());
		if (typeof s.output === "string" && s.output.trim()) parts.push(s.output.trim());
		if (parts.length > 0) return parts.join("\n\n");
	}
	return r.output.trim();
}

/** A one-line dissent entry: who, how they voted, and their one-line position. */
export function dissentLine(r: AgentResult): string {
	const s = r.structured;
	const vote = s && typeof s.vote === "string" && s.vote.trim() ? s.vote.trim() : "?";
	const summary = s && typeof s.result === "string" && s.result.trim() ? s.result.trim() : r.output.trim();
	return `[${r.agent} · ${vote}] ${summary}`;
}

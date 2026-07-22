/**
 * Shared rendering of a deliberation result — turn a member's structured fields into
 * readable prose, NOT the raw JSON envelope. Used by every vote-style strategy (`magi`,
 * `council-rounds`) so a ruling/dissent reads as text, never as tool JSON.
 */

import type { AgentResult } from "./types.ts";

function field(s: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = s?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneLine(value: string, max = 220): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function memberMeta(s: Record<string, unknown> | undefined): string[] {
	const meta: string[] = [];
	const vote = field(s, "vote");
	if (vote) meta.push(`vote ${vote}`);
	const confidence = s?.confidence;
	if (typeof confidence === "number" && Number.isFinite(confidence)) {
		meta.push(`confidence ${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`);
	}
	return meta;
}

/** A member's human-readable position from its structured fields (result + output). */
export function readableRuling(r: AgentResult): string {
	const s = r.structured;
	if (s) {
		const parts: string[] = [];
		const result = field(s, "result");
		const output = field(s, "output");
		if (result) parts.push(result);
		if (output && output !== result) parts.push(output);
		if (parts.length > 0) return parts.join("\n\n");
	}
	return r.output.trim();
}

/** Compact UI-only view of one child result. Structured fields win so JSON envelopes
 *  never leak into the agent overlay; unstructured agents retain a prose fallback. */
export function compactMemberResult(r: AgentResult): string {
	const s = r.structured;
	if (!s) return oneLine(r.output) || "(no output)";
	const meta = memberMeta(s);
	const summary = (field(s, "result") ?? field(s, "output") ?? r.output.trim()) || "(no output)";
	return `${meta.length > 0 ? `${meta.join(" · ")}\n` : ""}${oneLine(summary)}`;
}

/** Human UI rendering for aggregate/fanout results. The aggregate contract itself is
 *  untouched; this consumes its retained member envelopes only for presentation. */
export function humanizeAggregateResult(r: AgentResult): string | undefined {
	const members = r.structured?.results;
	if (!Array.isArray(members)) return undefined;
	const lines: string[] = [];
	for (const value of members) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const member = value as Record<string, unknown>;
		const agent = typeof member.agent === "string" && member.agent.trim() ? member.agent.trim() : "member";
		const ok = member.ok === true;
		const output = typeof member.output === "string" ? member.output : "";
		const structured = member.structured && typeof member.structured === "object" && !Array.isArray(member.structured)
			? (member.structured as Record<string, unknown>)
			: undefined;
		const view: AgentResult = { agent, output, usage: r.usage, ok };
		if (structured) view.structured = structured;
		lines.push(`${ok ? "✓" : "✗"} ${agent}\n${compactMemberResult(view)}`);
	}
	return lines.length > 0 ? lines.join("\n\n") : undefined;
}

export interface CouncilResultPresentation {
	headline: string | undefined;
	status: string | undefined;
	tally: Record<string, number> | undefined;
	usedFallback: boolean | undefined;
	body: string;
}

/** Plain Pi result text; the call renderer owns the single `council …` title. */
export function formatCouncilResult(input: CouncilResultPresentation, expanded: boolean): string {
	const body = input.body.trim();
	if (expanded) return body || "(the council returned no ruling)";
	const firstBodyLine = body.split("\n").find((line) => line.trim())?.trim();
	const status = input.status?.replace(/_/g, " ").trim();
	const verdict = oneLine(input.headline?.trim() || firstBodyLine || status || "(ruling)", 96);
	const meta: string[] = [];
	if (status && status.toLowerCase() !== verdict.toLowerCase()) meta.push(status);
	if (input.usedFallback) meta.push("confidence fallback");
	const tally = input.tally ? Object.entries(input.tally).map(([key, count]) => `${key}=${count}`).join(", ") : "";
	if (tally) meta.push(`tally ${tally}`);
	return `${verdict}${meta.length > 0 ? ` · ${meta.join(" · ")}` : ""} · ctrl+o`;
}

/** A one-line dissent entry: who, how they voted, and their one-line position. */
export function dissentLine(r: AgentResult): string {
	const s = r.structured;
	const vote = field(s, "vote") ?? "?";
	const summary = field(s, "result") ?? field(s, "output") ?? r.output.trim();
	return `[${r.agent} · ${vote}] ${summary}`;
}

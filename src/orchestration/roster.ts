/**
 * Roster loading — `teams.yaml` maps a team name to an ordered list of members.
 * Referenced by a persona's `orchestration.roster` or `council.roster`.
 *
 * A member is either a bare agent name (`- scout`) OR a map that specialises ONE
 * agent inline — `{ agent, role?, model?, skills? }` — so an ensemble of distinct
 * perspectives can be built from a SINGLE agent (e.g. one `reviewer` run three times
 * with different `role`s and models) instead of one .md file per perspective. That is
 * the "skills + role provide specialisation, not files" principle applied to rosters.
 *
 * Pure: reuses the core YAML-subset parser. `rosterSpec` normalises a member into the
 * run-spec fields the SDK's `agent()` accepts; `makeRoster` adapts a team map to the
 * SDK's `Roster` interface (unknown team → empty list).
 */

import { asBoolean, asStringArray, parseYamlSubset } from "../core/frontmatter.ts";
import type { Roster } from "./sdk.ts";

/** A roster member: a bare agent name, or an inline specialisation of one agent. `tools`/
 *  `isolation`/`mcp` bring a roster member to parity with an ad-hoc `delegate` task's own
 *  knobs (see `tools/delegate.ts`'s `DelegateTask`). */
export type RosterMember =
	| string
	| { agent: string; role?: string; model?: string; skills?: string[]; tools?: string[]; isolation?: "none" | "worktree"; mcp?: boolean };

/** The normalised run-spec fields a member contributes (agent + any specialisation). */
export interface RosterSpec {
	agent: string;
	role?: string;
	model?: string;
	skills?: string[];
	tools?: string[];
	isolation?: "none" | "worktree";
	mcp?: boolean;
}

/** Normalise a member into the fields `sdk.agent()` accepts (a bare name → just `agent`).
 *  `tools`/`isolation`/`mcp` map onto the SAME `AgentRunSpec` fields the `delegate` path's
 *  `specOf()` uses for these three concepts — including explicit `none`/`false` overrides —
 *  so a roster member and an ad-hoc task behave identically once specialised. */
export function rosterSpec(member: RosterMember): RosterSpec {
	if (typeof member === "string") return { agent: member };
	const spec: RosterSpec = { agent: member.agent };
	if (member.role?.trim()) spec.role = member.role.trim();
	if (member.model?.trim()) spec.model = member.model.trim();
	if (member.skills && member.skills.length > 0) spec.skills = member.skills;
	if (member.tools && member.tools.length > 0) spec.tools = member.tools;
	if (member.isolation !== undefined) spec.isolation = member.isolation;
	if (member.mcp !== undefined) spec.mcp = member.mcp;
	return spec;
}

// Emphasised keywords in a role are the lens; small connective words are not — drop
// them so "Focus ONLY on the SECURITY lens…" hints "SECURITY", not "ONLY".
const ROLE_STOPWORDS = new Set([
	"ONLY", "THE", "AND", "OR", "NOT", "FOR", "YOU", "YOUR", "ALL", "ANY", "USE", "VIA", "ONE",
	"ON", "IN", "OF", "TO", "IS", "IT", "BE", "DO", "AS", "AT", "BY", "AN", "A",
]);

/** A short emphasis hint from a member's role text — the first salient ALL-CAPS keyword
 *  (e.g. "SECURITY" from "Focus ONLY on the SECURITY lens…"), else the first few words.
 *  Used to disambiguate same-agent roster-role members in the UI tree. Pure. */
export function roleHint(role: string): string {
	const words = role.split(/\s+/);
	for (const w of words) {
		const clean = w.replace(/[^A-Za-z0-9]/g, "");
		if (clean.length >= 3 && /[A-Z]/.test(clean) && clean === clean.toUpperCase() && !ROLE_STOPWORDS.has(clean)) {
			return clean;
		}
	}
	const brief = words.slice(0, 4).join(" ").replace(/[:.,;].*$/, "").trim();
	return brief.length > 20 ? `${brief.slice(0, 20)}…` : brief || "role";
}

/** The base UI label for a member: `agent`, or `agent · HINT` when it carries a role —
 *  so an ensemble of one agent under several roles shows as distinct nodes. Pure. */
export function memberBaseLabel(member: RosterMember): string {
	const s = rosterSpec(member);
	return s.role ? `${s.agent} · ${roleHint(s.role)}` : s.agent;
}

/** Disambiguated node keys for a roster, aligned to input order: the base label, with a
 *  `#N` suffix only when the same base repeats. This is the SAME derivation the SDK applies
 *  per `agent()` call (base from role, occurrence-suffixed), so the tree's seeded "queued"
 *  nodes line up with the live ones instead of collapsing three same-name members into one.
 *  Pure. */
export function rosterNodeKeys(members: RosterMember[]): string[] {
	const seen = new Map<string, number>();
	return members.map((m) => {
		const base = memberBaseLabel(m);
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return n === 1 ? base : `${base}#${n}`;
	});
}

/** Coerce one raw YAML value into a roster member (string name, or `{ agent, … }` map). */
function toMember(raw: unknown): RosterMember | undefined {
	if (typeof raw === "string") return raw.trim() ? raw.trim() : undefined;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const o = raw as Record<string, unknown>;
		if (typeof o.agent !== "string" || !o.agent.trim()) return undefined;
		const m: { agent: string; role?: string; model?: string; skills?: string[]; tools?: string[]; isolation?: "none" | "worktree"; mcp?: boolean } = {
			agent: o.agent.trim(),
		};
		if (typeof o.role === "string" && o.role.trim()) m.role = o.role.trim();
		if (typeof o.model === "string" && o.model.trim()) m.model = o.model.trim();
		const skills = asStringArray(o.skills);
		if (skills) m.skills = skills;
		const tools = asStringArray(o.tools);
		if (tools) m.tools = tools;
		if (o.isolation === "worktree" || o.isolation === "none") m.isolation = o.isolation;
		const mcp = asBoolean(o.mcp);
		if (mcp !== undefined) m.mcp = mcp;
		return m;
	}
	return undefined;
}

export function parseTeams(yaml: string): Record<string, RosterMember[]> {
	const raw = parseYamlSubset(yaml);
	const teams: Record<string, RosterMember[]> = {};
	for (const [name, value] of Object.entries(raw)) {
		const items: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
		const members = items.map(toMember).filter((m): m is RosterMember => m !== undefined);
		if (members.length > 0) teams[name] = members;
	}
	return teams;
}

export function makeRoster(teams: Record<string, RosterMember[]>): Roster {
	return { team: (name: string) => teams[name] ?? [] };
}

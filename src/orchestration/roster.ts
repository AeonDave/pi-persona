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
	if (member.tools !== undefined) spec.tools = member.tools;
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

/** Coerce one raw value into a roster member (string name, or `{ agent, … }` map).
 *
 *  LENIENT, and deliberately so: this is the STATIC `teams.yaml` path (authored, trusted project
 *  data), where a member with a badly-typed field is normalised, not rejected — a bad `model`
 *  is dropped and a numeric `tools` entry is coerced to its string, so the panel still runs.
 *  Anything RUNTIME-supplied (a `council` call's `members`, an aux actor param) must go through
 *  {@link parseRuntimeRosterMember} instead: there, a dropped `tools` silently WIDENS a leg to
 *  the agent's default tool permissions, so a malformed field has to be refused, not normalised.
 *  `undefined` means "not a member": no usable agent name, or a wrong overall shape. */
export function parseRosterMember(raw: unknown): RosterMember | undefined {
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

/** Every field a member map may carry — anything else is a typo, not a silent no-op. */
const MEMBER_FIELDS = new Set(["agent", "role", "model", "skills", "tools", "isolation", "mcp"]);

export type RuntimeMember = { ok: true; member: RosterMember } | { ok: false; error: string };

/**
 * STRICT validation of a RUNTIME-supplied member (a `council` call's `members`, an aux actor
 * param), with a diagnostic that names the offending field.
 *
 * The lenient {@link parseRosterMember} is right for authored `teams.yaml`, where a dropped
 * field only reshapes a panel the author can read back in the file. Here the input arrives from
 * a tool call or a strategy param, and the silent-drop rules become a privilege change:
 * `tools: ["read", 42]` normalises to a DIFFERENT allowlist (or is dropped entirely, handing the
 * leg the agent's DEFAULT tools), `model: 42` / `mcp: "yes"` quietly discard the caller's
 * intent, and an unknown key looks honoured. So every known field is type-checked and an
 * unknown key is refused — BEFORE anything is spawned.
 */
export function parseRuntimeRosterMember(raw: unknown): RuntimeMember {
	if (typeof raw === "string") {
		return raw.trim() ? { ok: true, member: raw.trim() } : { ok: false, error: "an agent name (a non-empty string)" };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "an agent name (a string) or a { agent, … } map" };
	}
	const o = raw as Record<string, unknown>;
	if (typeof o.agent !== "string" || !o.agent.trim()) {
		return { ok: false, error: '"agent" (a non-empty string) is required' };
	}
	const unknownKeys = Object.keys(o).filter((k) => !MEMBER_FIELDS.has(k));
	if (unknownKeys.length > 0) {
		return { ok: false, error: `unknown member field(s) ${unknownKeys.join(", ")} — expected agent, role, model, skills, tools, isolation, mcp` };
	}
	const member: {
		agent: string;
		role?: string;
		model?: string;
		skills?: string[];
		tools?: string[];
		isolation?: "none" | "worktree";
		mcp?: boolean;
	} = { agent: o.agent.trim() };
	// A blank string is "unset" (the lenient path's own reading); a non-string is a type error.
	for (const key of ["role", "model"] as const) {
		const value = o[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return { ok: false, error: `"${key}" must be a string` };
		if (value.trim()) member[key] = value.trim();
	}
	for (const key of ["skills", "tools"] as const) {
		const value = o[key];
		if (value === undefined) continue;
		if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
			return { ok: false, error: `"${key}" must be an array of non-empty strings` };
		}
		member[key] = value as string[];
	}
	if (o.isolation !== undefined) {
		if (o.isolation !== "worktree" && o.isolation !== "none") {
			return { ok: false, error: '"isolation" must be "worktree" or "none"' };
		}
		member.isolation = o.isolation;
	}
	if (o.mcp !== undefined) {
		if (typeof o.mcp !== "boolean") return { ok: false, error: '"mcp" must be a boolean' };
		member.mcp = o.mcp;
	}
	return { ok: true, member };
}

export function parseTeams(yaml: string): Record<string, RosterMember[]> {
	const raw = parseYamlSubset(yaml);
	const teams: Record<string, RosterMember[]> = {};
	for (const [name, value] of Object.entries(raw)) {
		const items: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
		const members = items.map(parseRosterMember).filter((m): m is RosterMember => m !== undefined);
		if (members.length > 0) teams[name] = members;
	}
	return teams;
}

export function makeRoster(teams: Record<string, RosterMember[]>): Roster {
	return { team: (name: string) => teams[name] ?? [] };
}

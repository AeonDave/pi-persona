/**
 * Roster loading — `teams.yaml` maps a team name to an ordered list of members.
 * Referenced by a persona's `orchestration.roster` or `council.roster`.
 *
 * A member is either a bare agent name (`- scout`) OR a map that specialises ONE
 * agent inline — `{ agent, role?, model?, thinking?, skills? }` — so an ensemble of distinct
 * perspectives can be built from a SINGLE agent (e.g. one `reviewer` run three times
 * with different `role`s and models) instead of one .md file per perspective. That is
 * the "skills + role provide specialisation, not files" principle applied to rosters.
 *
 * Pure: reuses the core YAML-subset parser. `rosterSpec` normalises a member into the
 * run-spec fields the SDK's `agent()` accepts; `makeRoster` adapts a team map to the
 * SDK's `Roster` interface (unknown team → empty list).
 */

import { asBoolean, asStringArray, parseYamlSubset } from "../core/frontmatter.ts";
import { stripTerminalControls } from "../core/fence.ts";
import { parseLegThinking } from "../core/leg-thinking.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../core/types.ts";
import type { Roster } from "./sdk.ts";

/** A roster member: a bare agent name, or an inline specialisation of one agent. `tools`/
 *  `isolation`/`mcp` bring a roster member to parity with an ad-hoc `delegate` task's own
 *  knobs (see `tools/delegate.ts`'s `DelegateTask`). */
export type RosterMember =
	| string
	| RosterSpec;

/** The normalised run-spec fields a member contributes (agent + any specialisation). */
export interface RosterSpec {
	agent: string;
	role?: string;
	model?: string;
	thinking?: ThinkingLevel;
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
	const thinking = parseLegThinking(member.thinking);
	if (thinking !== undefined) spec.thinking = thinking;
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

const GIT_REF = /^(?:HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD)(?:[~^].*)?$/i;
const HASH = /^(?:0x)?[\da-f]{7,40}$/i;

function technicalRoleToken(token: string): boolean {
	const trimmed = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	return token.includes("_")
		|| token.includes("/")
		|| token.includes("\\")
		|| token.includes("$")
		|| token.includes("=")
		|| (trimmed.includes(":") && !trimmed.endsWith(":"))
		|| GIT_REF.test(trimmed)
		|| HASH.test(trimmed)
		|| /^[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]{1,8}$/u.test(trimmed);
}

function roleWords(role: string): string[] {
	// Inline/fenced code is not a role label. An unmatched opening fence also hides the
	// remainder instead of leaking its contents into the fallback label.
	const withoutCode = role.replace(/(`{1,3})[\s\S]*?\1/g, " ").replace(/`{1,3}[\s\S]*$/g, " ");
	return withoutCode.split(/\s+/).flatMap((raw) => {
		const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
		return word && !technicalRoleToken(raw) && !technicalRoleToken(word) ? [word] : [];
	});
}

function boundedRoleHint(text: string): string {
	const points = Array.from(text);
	return points.length > 20 ? `${points.slice(0, 19).join("")}…` : text;
}

/** A short emphasis hint from a member's role text — the first salient ALL-CAPS keyword
 *  (e.g. "SECURITY" from "Focus ONLY on the SECURITY lens…"), else a short human-readable
 *  prefix. Technical identifiers, code, paths, hashes and generic Git refs are omitted; a
 *  role with no readable words gets the neutral "role" hint. Used by presentation and
 *  run-unique UI keys, with roster seeding and SDK keys sharing this exact function. Pure. */
export function roleHint(role: string): string {
	// Roles become picker/tree chrome. Strip terminal sequences before token parsing so their
	// numeric parameters cannot be mistaken for visible prose, then remove bidi formatting
	// controls that could visually reorder or disguise the resulting label.
	const readable = stripTerminalControls(role).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu, "");
	const words = roleWords(readable);
	for (const w of words) {
		if (/^\p{L}{3,}$/u.test(w) && w === w.toUpperCase() && !ROLE_STOPWORDS.has(w)) {
			return boundedRoleHint(w);
		}
	}
	const brief = words.slice(0, 4);
	while (brief.length && ROLE_STOPWORDS.has(brief[brief.length - 1]!.toUpperCase())) brief.pop();
	return boundedRoleHint(brief.join(" ")) || "role";
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
 *  Explicit `thinking` is always strict: a typo must never inherit a different effort.
 *  Anything RUNTIME-supplied (a `council` call's `members`, an aux actor param) must go through
 *  {@link parseRuntimeRosterMember} instead: there, a dropped `tools` silently WIDENS a leg to
 *  the agent's default tool permissions, so a malformed field has to be refused, not normalised.
 *  `undefined` means "not a member": no usable agent name, or a wrong overall shape. */
export function parseRosterMember(raw: unknown): RosterMember | undefined {
	if (typeof raw === "string") return raw.trim() ? raw.trim() : undefined;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const o = raw as Record<string, unknown>;
		if (typeof o.agent !== "string" || !o.agent.trim()) return undefined;
		const m: RosterSpec = {
			agent: o.agent.trim(),
		};
		if (typeof o.role === "string" && o.role.trim()) m.role = o.role.trim();
		if (typeof o.model === "string" && o.model.trim()) m.model = o.model.trim();
		const thinking = parseLegThinking(o.thinking);
		if (thinking !== undefined) m.thinking = thinking;
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
const MEMBER_FIELDS = new Set(["agent", "role", "model", "thinking", "skills", "tools", "isolation", "mcp"]);

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
		return { ok: false, error: `unknown member field(s) ${unknownKeys.join(", ")} — expected agent, role, model, thinking, skills, tools, isolation, mcp` };
	}
	const member: RosterSpec = { agent: o.agent.trim() };
	if (o.thinking !== undefined) {
		if (!isThinkingLevel(o.thinking)) return { ok: false, error: `"thinking" must be one of: ${THINKING_LEVELS.join(", ")}` };
		member.thinking = o.thinking;
	}
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
		const members = items.map((item, index) => {
			try {
				return parseRosterMember(item);
			} catch (error) {
				throw new Error(`team ${name}[${index}]: ${error instanceof Error ? error.message : String(error)}`);
			}
		}).filter((m): m is RosterMember => m !== undefined);
		if (members.length > 0) teams[name] = members;
	}
	return teams;
}

export function makeRoster(teams: Record<string, RosterMember[]>): Roster {
	return { team: (name: string) => teams[name] ?? [] };
}

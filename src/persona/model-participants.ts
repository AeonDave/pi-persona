/**
 * Participant-aware model resolution for an orchestrated run.
 *
 * A strategy's participants are NOT just its roster members: an arbiter (`params.judge`), a
 * synthesiser, a critic or a generator is a real participant too — it spawns, it is billed, and its
 * model matters exactly as much as a core's. This module is the ONE pure place that answers two
 * questions for the UI layer:
 *
 *   1. WHO runs — roster members plus every auxiliary actor declared by an agent-typed strategy
 *      param (metadata-driven, so a new strategy needs no name switch here).
 *   2. ON WHAT — the effective model by precedence:
 *        explicit inline member model
 *          > saved per-persona assignment for the ROLE key
 *          > saved per-persona assignment for the agent key
 *          > the agent's own frontmatter model
 *          > the session model (the default, NOT an assignment — it must not suppress the picker).
 *
 * The persisted assignment KEY is `agent` for a bare member — the historical shape, so every
 * existing `config.json` keeps applying — and `agent#<hash-of-agent+role>` for a member carrying a
 * role. The hash keeps the full role as the identity without persisting the role PROMPT (which is
 * an instruction, not a key, and would leak strategy prose into the user's config file). The human
 * label stays separate, so the picker and the tree can still say `reviewer · SECURITY`.
 *
 * Pure: no engine, no UI, no config store, no clock. The picker decides; this decides WHAT it may
 * ask about.
 */

import { createHash } from "node:crypto";

import { memberBaseLabel, parseRosterMember, type RosterMember, type RosterSpec } from "../orchestration/roster.ts";
import { knownParams } from "../orchestration/strategy.ts";
import type { StrategyParam } from "../orchestration/sdk.ts";

/** Where a participant's effective model came from — in precedence order. */
export type ModelSource = "inline" | "assignment" | "agent" | "session" | "none";

/** A strategy param that names a real participant (an arbiter, a synthesiser, …) is marked
 *  `type: "agent"` in the strategy's own metadata — the single declaration, read from
 *  `knownParams`, so adding a strategy never means editing this file. */
function isAgentParam(param: StrategyParam): boolean {
	return param.type === "agent";
}

export interface ModelParticipant {
	/** The agent that runs. */
	agent: string;
	/** The on-the-fly role prompt, when the participant carries one (never persisted in `key`). */
	role?: string;
	/** Stable model-assignment key: the agent name, or `agent#<hash>` for a role member. */
	key: string;
	/** What a human should see: `agent`, or `agent · HINT` for a role member. */
	label: string;
	/** A roster member, or an auxiliary actor declared by a strategy param. */
	origin: "roster" | "param";
	/** The strategy param that declares this auxiliary actor (roster members omit it). */
	param?: string;
	/** The effective model for this participant, by precedence; undefined when nothing supplies one. */
	model?: string;
	/** Which step of the precedence supplied `model`. */
	source: ModelSource;
	/** Someone already chose this participant's model (inline, a saved assignment, or the agent's own
	 *  frontmatter) ⇒ never a picker candidate. The session default is deliberately NOT counted. */
	assigned: boolean;
}

export interface ParticipantInput {
	/** The run's members (the caller resolves inline-over-roster via
	 *  `resolveOrchestrationMembers`). */
	members?: RosterMember[];
	/** The running strategy — used to look up its declared agent-typed params. */
	strategy?: string;
	/** The strategy's params, as the run will see them. */
	params?: Record<string, unknown>;
	/** Param schema override; defaults to `knownParams(strategy)`. Test/forward seam. */
	schema?: Record<string, StrategyParam>;
	/** The persona's saved assignments, keyed by `participantKey`. */
	assigned?: Record<string, string>;
	/** An agent's own declared model (frontmatter). */
	agentModel?: (agent: string) => string | undefined;
	/** The session's own model — the last-resort default. */
	sessionModel?: string;
}

/**
 * The digest behind a role key. SHA-256 (128 bits kept) rather than a short rolling hash: this
 * value is the identity a model assignment is filed under, so a collision would hand one lens
 * another's model — a silent, expensive wrong answer. `crypto` is a node builtin (no dependency,
 * no host package), and the digest is deterministic across processes and runs, which is what lets
 * a persisted key resolve to the same participant tomorrow.
 */
function stableDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The model-assignment key for a participant. A bare member (no role) keeps the agent name — the
 * pre-role key shape, so assignments saved before roles existed keep applying to it.
 */
export function participantKey(agent: string, role?: string): string {
	const trimmed = role?.trim();
	return trimmed ? `${agent}#${stableDigest(`${agent}\0${trimmed}`)}` : agent;
}

/** One participant's model, resolved in the one precedence order the UI and the engines share. */
function fromSpec(spec: RosterSpec, origin: "roster" | "param", param: string | undefined, input: ParticipantInput): ModelParticipant {
	const assigned = input.assigned ?? {};
	const key = participantKey(spec.agent, spec.role);
	let model: string | undefined;
	let source: ModelSource = "none";
	if (spec.model) {
		model = spec.model;
		source = "inline";
	} else if (assigned[key]) {
		model = assigned[key];
		source = "assignment";
	} else if (assigned[spec.agent]) {
		model = assigned[spec.agent];
		source = "assignment";
	} else {
		const agentModel = input.agentModel?.(spec.agent);
		if (agentModel) {
			model = agentModel;
			source = "agent";
		} else if (input.sessionModel) {
			model = input.sessionModel;
			source = "session";
		}
	}
	return {
		agent: spec.agent,
		...(spec.role ? { role: spec.role } : {}),
		key,
		label: memberBaseLabel(asMember(spec)),
		origin,
		...(param ? { param } : {}),
		...(model ? { model } : {}),
		source,
		assigned: source === "inline" || source === "assignment" || source === "agent",
	};
}

/** Rebuild the member shape `memberBaseLabel` normalises (it takes a RosterMember, not a spec). */
function asMember(spec: RosterSpec): RosterMember {
	return spec.role ? { agent: spec.agent, role: spec.role, ...(spec.model ? { model: spec.model } : {}) } : spec.agent;
}

/** An auxiliary actor resolves in ONE chain: the value the caller supplied → (only where the
 *  metadata says so) the roster member it names or points at → the real agent named by `default`.
 *  A default that is a SENTENCE rather than an agent ("the first roster agent") is no participant
 *  at all — taking a phrase literally would offer a model for a leg that can never run. */
function auxActorSpec(input: ParticipantInput, paramName: string, param: StrategyParam): RosterSpec | undefined {
	const supplied = input.params?.[paramName];
	const spec = toSpec(supplied);
	if (spec) {
		// `inheritRoster` is opt-in per param (e.g. `map.verify`'s documented "a member named X"
		// lookup) and only ever rewrites a BARE selector. An arbiter/critic keeps its historic
		// meaning — naming that agent IS the actor, whatever role a panel member happens to wear.
		if (param.inheritRoster && typeof supplied === "string") {
			const seated = rosterMemberNamed(input.members, spec.agent);
			if (seated) return seated;
		}
		return spec;
	}
	const index = rosterIndexOf(param);
	if (index !== undefined) {
		const seated = toSpec(input.members?.[index]);
		if (seated) return seated;
	}
	return isAgentName(param.default) ? toSpec(param.default) : undefined;
}

/** The roster entry an aux selector names, verbatim — its role/inline model included, so the aux
 *  actor and the panel entry stay ONE participant with ONE model key. */
function rosterMemberNamed(members: RosterMember[] | undefined, agent: string): RosterSpec | undefined {
	for (const member of members ?? []) {
		const spec = toSpec(member);
		if (spec?.agent === agent) return spec;
	}
	return undefined;
}

/** The roster position an agent-typed param defaults to, when its metadata declares one. */
function rosterIndexOf(param: StrategyParam): number | undefined {
	const index = param.rosterIndex;
	return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** Is this default an AGENT NAME (one token) rather than a documentation phrase? Agent names never
 *  contain whitespace, so a multi-word default is prose describing a default, not a participant. */
function isAgentName(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0 && !/\s/.test(value.trim());
}

/** Every participant a run really spawns: the roster first (in run order), then auxiliary actors. */
export function collectModelParticipants(input: ParticipantInput): ModelParticipant[] {
	const out: ModelParticipant[] = [];
	const seen = new Set<string>();
	for (const raw of input.members ?? []) {
		const spec = toSpec(raw);
		if (!spec) continue;
		const p = fromSpec(spec, "roster", undefined, input);
		if (seen.has(p.key)) continue;
		seen.add(p.key);
		out.push(p);
	}
	const schema = input.schema ?? (input.strategy ? knownParams(input.strategy) : undefined);
	if (schema) {
		for (const [paramName, param] of Object.entries(schema)) {
			if (!isAgentParam(param)) continue;
			const spec = auxActorSpec(input, paramName, param);
			if (!spec) continue;
			const p = fromSpec(spec, "param", paramName, input);
			if (seen.has(p.key)) continue;
			seen.add(p.key);
			out.push(p);
		}
	}
	return out;
}

/** The participants a picker may still ask about: nobody has chosen a model for them, and this
 *  session has not already asked (and been dismissed) for that key. The caller records the keys it
 *  asks about BEFORE asking, so a dismissal is remembered too. */
export function pendingParticipants(
	participants: readonly ModelParticipant[],
	opts: { prompted: ReadonlySet<string> },
): ModelParticipant[] {
	return participants.filter((p) => !p.assigned && !opts.prompted.has(p.key));
}

// A roster member / param value is either a bare agent name or an inline specialisation map. Both
// come from the shared roster grammar (`parseRosterMember`), so an auxiliary actor named inline in
// a `params.judge` entry is normalised exactly like a `teams.yaml` member.
function toSpec(value: unknown): RosterSpec | undefined {
	if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return undefined;
	const member = parseRosterMember(value);
	if (!member) return undefined;
	const spec = typeof member === "string" ? { agent: member } : member;
	return spec.agent.trim() ? spec : undefined;
}

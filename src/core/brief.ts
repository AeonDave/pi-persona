/**
 * The delegation brief — a compact per-turn block appended to the TAIL of the supervisor's
 * system prompt so delegation never depends on decayed persona prose or the model's memory
 * of what is installed. It is the standing half of the runtime-reinforcement pair (the
 * reactive half is core/nudge.ts):
 *
 *   - DISCOVERY: the installed agents (name + clipped description), team rosters, and flows —
 *     regenerated from the live registry every turn, so it cannot desync the way hard-coded
 *     persona prose can, and it survives however much context the turn has burned.
 *   - THE STANDING DEFAULT: hand substantive work off by default, keep only trivial steps
 *     inline — restated every turn at the prompt tail, where it wins the recency tug-of-war
 *     a top-of-prompt persona directive loses.
 *
 * Pure module (no Pi imports). The caller (extension.ts) decides WHEN a brief applies
 * (capability gating, persona state); this module only renders.
 */

export interface BriefAgent {
	name: string;
	description?: string;
}

export interface BriefInput {
	/** Installed agents the active capabilities allow as delegate targets. */
	agents: BriefAgent[];
	/** Team name → member agent names (inline specialisations flattened to their agent). */
	teams: Record<string, string[]>;
	/** Installed flow names (empty ⇒ the line is omitted). */
	flows: string[];
	/** A persona is active: state the standing hand-off default, not just the roster. */
	standing: boolean;
	/** Delegate runs in the background by default (interactive sessions) — phrases delivery. */
	asyncDefault: boolean;
	/**
	 * Total sub-agents installed in the registry, BEFORE capability filtering. Lets an empty
	 * `agents` list tell "nothing installed (fresh install ⇒ seed)" apart from "this persona's
	 * delegate permission allows none of the installed agents (widen the allowlist; seeding won't
	 * help)". Defaults to `agents.length` when omitted (caller passed no separate registry count).
	 */
	installedCount?: number;
}

/** Longest description carried per agent line — one line each, never a paragraph. */
const DESC_CLIP = 96;
/** Most agents/teams/flows listed by name; beyond this the brief says "+N more". */
const MAX_LISTED = 16;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Render `[a, a, b]` as `a×2, b` — rosters repeat an agent for parallel lenses. */
function memberSummary(members: string[]): string {
	const counts = new Map<string, number>();
	for (const m of members) counts.set(m, (counts.get(m) ?? 0) + 1);
	return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ");
}

/**
 * Render the per-turn delegation brief, or undefined when there is nothing useful to say
 * (no agents installed and no active persona — the vanilla pi experience stays untouched).
 */
export function buildDelegationBrief(input: BriefInput): string | undefined {
	if (input.agents.length === 0 && !input.standing) return undefined;

	if (input.agents.length === 0) {
		const installed = input.installedCount ?? input.agents.length;
		if (installed > 0) {
			// Agents ARE installed, but this persona's `delegate` permission allows NONE of them (a
			// restrictive allowlist, or agents renamed/removed out from under it). Seeding won't help —
			// say so honestly (mirrors gating.ts's "This persona has no delegate targets"), instead of
			// the fresh-install seed guidance below, which would be a lie here.
			return (
				`[pi-persona] This persona holds \`delegate\` but its delegate permission allows none of the ${installed} ` +
				"installed sub-agent(s) — nothing to hand off. Widen the persona's `delegate` allowlist (or check for " +
				"renamed/removed agents in /doctor)."
			);
		}
		// A delegating persona is active but the registry is empty (fresh install): the
		// delegate/council tools are advertised, so every call would fail "unknown agent".
		// Say WHY and name the fix, instead of letting the first delegation attempts teach
		// the model that delegation is broken here.
		return (
			"[pi-persona] No sub-agents are installed yet, so `delegate`/`council` cannot run. " +
			"Suggest the user run `/persona seed` once (it installs the bundled agents: operator, " +
			"scout, reviewer, research, verifier, …) — after that, hand work off as a reflex."
		);
	}

	const lines: string[] = ["[pi-persona] Sub-agents:"];
	const listed = input.agents.slice(0, MAX_LISTED);
	for (const a of listed) {
		lines.push(a.description ? `- ${a.name} — ${clip(a.description, DESC_CLIP)}` : `- ${a.name}`);
	}
	if (input.agents.length > listed.length) {
		lines.push(`- …and ${input.agents.length - listed.length} more (see /doctor)`);
	}

	const teamNames = Object.keys(input.teams).slice(0, MAX_LISTED);
	if (teamNames.length > 0) {
		lines.push(
			`Teams (rosters for council/strategies): ${teamNames.map((t) => `${t}[${memberSummary(input.teams[t] ?? [])}]`).join(" · ")}`,
		);
	}
	if (input.flows.length > 0) lines.push(`Flows: ${input.flows.slice(0, MAX_LISTED).join(", ")}`);

	const example = input.agents.some((a) => a.name === "operator") ? "operator" : (listed[0]?.name ?? "operator");
	const delivery = input.asyncDefault
		? "they run in the background and each result returns to you automatically as a follow-up — don't watch or poll a healthy leg; you're woken if one stalls or messages you, plus an occasional check-in to catch drift"
		: "the call returns when they finish";
	lines.push(
		input.standing
			? `Hand off by default: when a task has independent, heavy, or parallel parts, fan them out FIRST in one \`delegate\` call (${delivery}); convene \`council\` for deliberation or batch sweeps. Keep only trivial single-step work, decisions, and the final synthesis inline. Minimum call: delegate({ agent: "${example}", task: "<self-contained brief: objective, scope, success signal>" }).`
			: `Reach for \`delegate\` when a task has independent or heavy parts (${delivery}) — e.g. delegate({ agent: "${example}", task: "<self-contained brief>" }).`,
	);
	return lines.join("\n");
}

export interface ExocomPeerBrief {
	name: string;
	persona?: string;
	purpose?: string;
}

/** Per-turn awareness of live exocom peers (independent pi instances in this workspace), or
 *  undefined when none are reachable. Tells the supervisor WHO is available + their specialization
 *  so it can choose to collaborate — never an obligation. */
export function buildExocomBrief(peers: ExocomPeerBrief[]): string | undefined {
	if (peers.length === 0) return undefined;
	const lines: string[] = [
		"[pi-persona] exocom peers — other INDEPENDENT pi instances are live in this workspace right now. They are NOT your sub-agents; each is its own supervisor you may collaborate with by messaging it:",
	];
	for (const p of peers.slice(0, MAX_LISTED)) {
		const spec = p.persona ? (p.purpose ? `${p.persona} — ${clip(p.purpose, DESC_CLIP)}` : p.persona) : "";
		lines.push(spec ? `- ${p.name} (${spec})` : `- ${p.name}`);
	}
	if (peers.length > MAX_LISTED) lines.push(`- …and ${peers.length - MAX_LISTED} more (exocom_list)`);
	lines.push(
		`Hand a peer a self-contained subtask with exocom_send({ target: "<name>", message: "<request>" }) — one-way, non-blocking; their reply returns to you as a follow-up. Coordinate only when it genuinely helps; a peer is a collaborator, not an obligation.`,
	);
	return lines.join("\n");
}

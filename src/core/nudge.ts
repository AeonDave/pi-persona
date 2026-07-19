/**
 * DelegationNudge — a pure state machine that watches the supervisor's OWN tool-result stream
 * and, when hands-on work burns too much context without a hand-off, returns a short reminder to
 * append to the offending tool's result. This is the runtime reinforcement the static persona
 * prompt cannot give: the persona directive sits at the TOP of the context and its behavioral pull
 * decays as recent tool output balloons ("delegate the breadth" loses the tug-of-war against 50
 * commands of momentum). The nudge lands in RECENT context — on the very command that triggered
 * it — where a decaying system-prompt line has no force.
 *
 * The trigger is REPETITION, not raw volume. The antipattern the persona warns against is "chaining
 * sweeps by hand" — a RUN of substantive hands-on commands with no hand-off (a dirbust/spray/enum
 * loop). Output volume alone is a poor proxy: a single big file read is high-volume but a legitimate
 * one-shot that belongs to reading-budget-discipline (grep-first), not delegation. So the primary
 * trigger counts consecutive SUBSTANTIVE hands-on tool calls since the last hand-off — a tiny call
 * (echo/cd/one-line check) is orchestration glue and does not advance the run; a run reaching the
 * threshold is a by-hand sweep. Tool identity is not required (a real sweep mixes read/grep/curl). A
 * high single-command threshold stays as a SECONDARY trigger for a genuinely enormous one-shot dump
 * (a sign it should have been detached/quarantined). A hand-off (delegate/council) resets the run;
 * nothing else does.
 *
 * Backoff: repeating the identical reminder is noise once the operator has seen it and kept going —
 * often because the work is session-bound and cannot be delegated at all (a live shell / tunnel a
 * sub-agent can't inherit; from the supervisor side that loop is indistinguishable from a delegable
 * sweep, so no signal can separate them). Each un-actioned nudge WIDENS the next run window (n× the
 * base): the reminder lands early, then de-escalates. Pure — no I/O, fully unit-testable.
 */

/** Tools that mean "the operator handed work off" — they end (reset) a by-hand run. */
const HANDOFF_TOOLS = new Set(["delegate", "council"]);

export interface NudgeThresholds {
	/** A single result at/above this many chars is a fat one-shot dump — nudge on its own. Kept
	 *  high so a normal large file read doesn't trip it; only a linpeas/ffuf-scale dump does. */
	singleHeavyChars: number;
	/** A run of this many consecutive SUBSTANTIVE hands-on commands (no hand-off) is a by-hand
	 *  sweep — the primary trigger. Counts steps, not bytes, so one big read never trips it. */
	runLength: number;
	/** A command whose output is below this many chars is orchestration glue (echo/cd/one-line
	 *  check), not a sweep step: it does not advance the run counter. */
	minStepChars: number;
}

export const DEFAULT_NUDGE_THRESHOLDS: NudgeThresholds = {
	singleHeavyChars: 40_000, // ~10k tokens in one command — a fat one-shot dump
	runLength: 8, // 8 substantive hands-on commands in a row without a hand-off = a by-hand sweep.
	// The standing delegation brief (core/brief.ts) carries the default every turn; this is the
	// reactive backstop for the supervisor who grinds a sweep through it anyway.
	minStepChars: 200, // below this a command is glue, not a sweep step
};

/** chars → ~thousands of tokens (≈4 chars/token), for the human-facing nudge text. */
const toK = (chars: number): number => Math.round(chars / 4 / 1000);

/**
 * Honest lead: name what actually tripped the nudge. A single fat dump blames THAT command; a
 * cumulative streak names the accumulated burn (never the tiny command that merely crossed the
 * line — printing its ~0k size looked like the nudge fired on nothing). The tail acknowledges that
 * not all burn is delegable: work bound to one interactive session a sub-agent can't inherit
 * (a live shell, a specific tunnel) stays with you — then the fix is to keep it lean, not to hand off.
 */
function renderNudge(reason: "dump" | "sweep", run: number, burn: number, size: number): string {
	const lead =
		reason === "dump"
			? `that direct command dumped ~${toK(size)}k tokens in one result (~${toK(burn)}k by hand since your last delegate).`
			: `${run} hands-on commands in a row (~${toK(burn)}k tokens) with no hand-off.`;
	return (
		`⟢ pi-persona — ${lead} ` +
		`"Delegate anything that burns context or budget." Breadth or a stalled vector → hand it off ` +
		"(`delegate` runs in the background and reports back). If the work is bound to one interactive " +
		"session a sub-agent can't inherit, keep it yourself but lean — one scripted sweep, grep-first, no full-dump reprints."
	);
}

export class DelegationNudge {
	private run = 0; // consecutive SUBSTANTIVE hands-on calls since the last hand-off
	private burn = 0; // cumulative output chars since the last hand-off (for the message only)
	private lastNudgeRun = 0; // run length at which we last nudged (the re-arm baseline)
	private nudges = 0; // cumulative nudges fired since the last hand-off (drives backoff)
	private readonly t: NudgeThresholds;

	constructor(thresholds: NudgeThresholds = DEFAULT_NUDGE_THRESHOLDS) {
		this.t = thresholds;
	}

	/** Clear the run — call on a new session or persona switch. */
	reset(): void {
		this.run = 0;
		this.burn = 0;
		this.lastNudgeRun = 0;
		this.nudges = 0;
	}

	/**
	 * Feed one supervisor tool result: its tool name and output length in chars. Returns the reminder
	 * text to append to that result, or undefined to leave the result untouched.
	 */
	observe(toolName: string, size: number): string | undefined {
		if (HANDOFF_TOOLS.has(toolName)) {
			// The operator delegated — the by-hand run is over; the hand-off itself never nudges.
			this.reset();
			return undefined;
		}
		const step = Math.max(0, size);
		this.burn += step;
		// Only a substantive step advances the run; a trivial call is orchestration glue, not a sweep
		// step (it neither advances nor resets the run — a stray echo mid-sweep doesn't break it).
		if (step >= this.t.minStepChars) this.run += 1;
		const single = size >= this.t.singleHeavyChars;
		// Backoff: each un-actioned nudge widens the next run window, so a long non-delegable
		// session-bound loop is reminded ONCE then left alone; a real runaway grind still trips the
		// widened window; a hand-off resets it.
		const window = this.t.runLength * (this.nudges + 1);
		const sweep = this.run - this.lastNudgeRun >= window;
		if (!single && !sweep) return undefined;
		this.lastNudgeRun = this.run;
		this.nudges += 1;
		return renderNudge(sweep ? "sweep" : "dump", this.run, this.burn, size);
	}
}

/**
 * PersistenceNudge — the counterweight to premature surrender. Where {@link DelegationNudge} fires
 * when the supervisor grinds work BY HAND, this fires when a delegated leg comes back having GIVEN
 * UP: the child's report carries an explicit surrender/blocked marker. It returns a reminder to
 * append to that very result — in RECENT context, on the leg that just landed — that a delegating
 * supervisor must not bank a premature block: confirm it names a genuine missing capability, else
 * steer it back with the recovery pass or re-dispatch. This is the runtime half of the operator
 * protocol's "reject premature surrender" rule; the top-of-prompt persona directive has decayed by
 * the time a blocked leg returns.
 *
 * Keyed on the ecosystem's OWN explicit protocol tokens (an operator emits `[BLOCKED: need X]`, a CTF
 * leg emits `FLAG: UNKNOWN`) — never a fuzzy "sounds stuck" guess, so it does not misfire on ordinary
 * prose. It inspects only `delegate`/`council` results (a child's report); the supervisor's own tools
 * are DelegationNudge's job, so the two never fire on the same event. Pure — no I/O, unit-testable.
 */

/** Tools whose result is a delegated child's report (where a surrender can surface). */
const REPORT_TOOLS = new Set(["delegate", "council"]);

/** Explicit surrender/blocked markers the operator + CTF protocols emit (operator.md). */
const SURRENDER_MARKERS: readonly RegExp[] = [/\[BLOCKED\b/i, /\bFLAG:\s*UNKNOWN\b/i];

const PERSISTENCE_NOTE =
	"⟢ pi-persona — a delegated leg came back BLOCKED/UNKNOWN. Don't bank it yet: a real block names a " +
	"missing external capability (access, credential, authorization, an unobtainable tool). If it's " +
	"out-of-ideas with budget left, steer it back with the recovery pass (probe the unverified, re-read " +
	"recon, simplest attack of the class, empirical payloads to leak structure) or re-dispatch with a " +
	"sharper packet.";

export class PersistenceNudge {
	/**
	 * Feed one supervisor tool result: its tool name and the full text of the result. Returns the
	 * reminder to append when a delegated leg's report signals premature surrender, else undefined.
	 * The SYNC path (a `delegate`/`council` tool_result the supervisor sees inline).
	 */
	observe(toolName: string, text: string): string | undefined {
		if (!REPORT_TOOLS.has(toolName)) return undefined;
		return this.scan(text);
	}

	/**
	 * Tool-agnostic surrender check on already-known-to-be-a-leg-report text. The ASYNC path uses
	 * this: a background run (the interactive default) delivers its report through the completion
	 * notifier as a fresh follow-up, NOT a `delegate` tool_result, so {@link observe}'s tool gate
	 * would never see it — the caller has already established the text is a settled leg's output.
	 */
	scan(text: string): string | undefined {
		return SURRENDER_MARKERS.some((re) => re.test(text)) ? PERSISTENCE_NOTE : undefined;
	}
}

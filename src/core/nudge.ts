/**
 * DelegationNudge — a pure state machine that watches the supervisor's OWN tool-result stream
 * and, when hands-on work burns too much context without a hand-off, returns a short reminder to
 * append to the offending tool's result. This is the runtime reinforcement the static persona
 * prompt cannot give: the persona directive sits at the TOP of the context and its behavioral pull
 * decays as recent tool output balloons ("delegate the breadth" loses the tug-of-war against 50
 * commands of momentum). The nudge lands in RECENT context — on the very command that triggered
 * it — where a decaying system-prompt line has no force.
 *
 * "Burn" is output SIZE (a token proxy), because that is the persona's OWN criterion — "delegate
 * anything that burns context or budget" — and it is tool-name-agnostic: it fires on any heavy
 * result, not a maintained list of heavy binaries. The persona also says a single read/grep/find is
 * legitimate direct work while an *iterative* sweep is delegation, so the primary trigger is the
 * CUMULATIVE burn since the last hand-off (iterative grinding accrues), with a high single-command
 * threshold reserved for a genuinely enormous one-shot dump. A hand-off tool (delegate/council)
 * resets the streak; nothing else does. Pure — no I/O, fully unit-testable.
 */

/** Tools that mean "the operator handed work off" — they end (reset) a hand-grinding streak. */
const HANDOFF_TOOLS = new Set(["delegate", "council"]);

export interface NudgeThresholds {
	/** A single result at/above this many chars is a fat one-shot dump — nudge on its own. Kept
	 *  high so a normal large file read doesn't trip it; only a linpeas/ffuf-scale dump does. */
	singleHeavyChars: number;
	/** Nudge each time direct burn since the last nudge crosses this many chars — this is what
	 *  catches iterative sweeps done by hand (each small, the accumulation is the signal). */
	cumulativeChars: number;
}

export const DEFAULT_NUDGE_THRESHOLDS: NudgeThresholds = {
	singleHeavyChars: 40_000, // ~10k tokens in one command
	cumulativeChars: 24_000, // ~6k tokens of accumulated hand-grinding since the last delegate —
	// an early backstop: the standing delegation brief (core/brief.ts) carries the default,
	// this catches the supervisor that grinds through it anyway.
};

/** chars → ~thousands of tokens (≈4 chars/token), for the human-facing nudge text. */
const toK = (chars: number): number => Math.round(chars / 4 / 1000);

function renderNudge(size: number, burn: number): string {
	return (
		`⟢ pi-persona — that direct command added ~${toK(size)}k tokens to your context ` +
		`(~${toK(burn)}k burned by hand since your last delegate). ` +
		`"Delegate anything that burns context or budget." If this is breadth or a stalled vector, ` +
		"hand it off (`delegate` — it runs in the background and reports back) and keep the specific thread yourself."
	);
}

export class DelegationNudge {
	private burn = 0; // chars of direct-tool output since the last hand-off
	private lastNudgeAt = 0; // burn level at which we last nudged (the re-arm baseline)
	private readonly t: NudgeThresholds;

	constructor(thresholds: NudgeThresholds = DEFAULT_NUDGE_THRESHOLDS) {
		this.t = thresholds;
	}

	/** Clear the streak — call on a new session or persona switch. */
	reset(): void {
		this.burn = 0;
		this.lastNudgeAt = 0;
	}

	/**
	 * Feed one supervisor tool result. `size` is its output length in chars. Returns the reminder
	 * text to append to that result, or undefined to leave the result untouched.
	 */
	observe(toolName: string, size: number): string | undefined {
		if (HANDOFF_TOOLS.has(toolName)) {
			// The operator delegated — the hand-grinding streak is over; the hand-off never nudges.
			this.burn = 0;
			this.lastNudgeAt = 0;
			return undefined;
		}
		this.burn += Math.max(0, size);
		const single = size >= this.t.singleHeavyChars;
		const cumulative = this.burn - this.lastNudgeAt >= this.t.cumulativeChars;
		if (!single && !cumulative) return undefined;
		this.lastNudgeAt = this.burn;
		return renderNudge(size, this.burn);
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
	 */
	observe(toolName: string, text: string): string | undefined {
		if (!REPORT_TOOLS.has(toolName)) return undefined;
		return SURRENDER_MARKERS.some((re) => re.test(text)) ? PERSISTENCE_NOTE : undefined;
	}
}

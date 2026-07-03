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
	cumulativeChars: 60_000, // ~15k tokens of accumulated hand-grinding since the last delegate
};

/** chars → ~thousands of tokens (≈4 chars/token), for the human-facing nudge text. */
const toK = (chars: number): number => Math.round(chars / 4 / 1000);

function renderNudge(size: number, burn: number): string {
	return (
		`⟢ pi-persona — that direct command added ~${toK(size)}k tokens to your context ` +
		`(~${toK(burn)}k burned by hand since your last delegate). ` +
		`"Delegate anything that burns context or budget." If this is breadth or a stalled vector, ` +
		"dispatch it (`delegate … async: true`) and keep the specific thread yourself."
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

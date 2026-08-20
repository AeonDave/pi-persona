/**
 * Time awareness — the readings that give the model back a clock, and the one rule that decides
 * how precise each of them may be.
 *
 * Nothing in pi's base prompt carries a date or a time, so from inside a turn five minutes of work
 * and five hours look identical: a supervisor cannot tell how long it has been on a problem, and a
 * peer reply that took twenty minutes reads exactly like an instant one. This module renders the
 * durations that fix that. Pure (every clock is an argument), so none of it needs a real one.
 *
 * The rule, which is why the three renderings have three different granularities:
 *
 *   - Text APPENDED to the conversation TAIL (a tool result, a delivered message) is written once
 *     and never re-sent as the provider's cached prefix, so precision there is free —
 *     {@link formatDuration} and {@link peerSentLabel} may say "2m 5s".
 *   - Text in the SYSTEM PROMPT is re-sent every turn and IS the cached prefix. A minute-granular
 *     value there rewrites that prefix every minute and throws away the provider's cache of
 *     everything before it, for a signal nobody needed at that resolution. So the session anchor
 *     reads on a deliberately coarse ladder ({@link sessionElapsedLabel}) that steps a couple of
 *     dozen times a DAY. The companion pi-persona-mind module makes the same trade for the same
 *     reason (its `ageLabel` collapses the whole sub-day range into one bucket).
 *
 * Both readings state an elapsed time as fact, so both refuse the inputs that would turn that
 * statement into a lie — see {@link parseInstant} and the plausibility bound each one applies.
 */

/**
 * Compact wall-clock duration for a TAIL surface: "<1s", "43s", "2m 5s", "2h 5m", "3d 4h". Two
 * units at most — this rides on reports the supervisor reads every time a leg lands.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?"; // corrupt/absent input — never render "NaNs"
	const seconds = Math.floor(ms / 1_000);
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * An ISO-8601 instant that names exactly one moment: a calendar date — which ECMA-262 fixes to UTC
 * midnight — optionally followed by a time that MUST carry "Z" or a numeric offset. Anchored at
 * both ends and free of nested quantifiers, so it stays linear on hostile input; matching a zone
 * loosely at the tail would read the "-20" of a bare date as an offset.
 */
const QUALIFIED_INSTANT = /^[+-]?\d{4,6}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2}|[+-]\d{2}))?$/;

/**
 * Parse an instant that is about to be stated as fact, or NaN.
 *
 * `Date.parse` silently reads a date-time with no zone ("2026-08-20T11:40:00") as the RECEIVER's
 * LOCAL time, so the identical string yields a different instant on every machine — two peers
 * would print two different ages for the same message, each equally confident. An unqualified
 * string is not a slightly-wrong time, it is an unknown one, so it is refused here rather than
 * guessed at.
 */
function parseInstant(value: unknown): number {
	if (typeof value !== "string" || !QUALIFIED_INSTANT.test(value)) return Number.NaN;
	return Date.parse(value);
}

/** What the delivery header says when the peer's own timestamp cannot be believed. */
const UNKNOWN_SENT = "sent at an unknown time (peer clock)";
/** Two machines' clocks routinely differ by seconds. That is skew, not a claim about the future. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
/** The widest transit age this header will state as fact. An exocom peer is a LIVE instance in
 *  this workspace; past this, the sender's clock — not the network — is the explanation. */
const MAX_PLAUSIBLE_SENT_AGE_MS = 30 * 86_400_000;
/** The widest session age the anchor will state as fact. A header a year old is not a long
 *  session, it is a corrupt or misread one; every real session sits far below this. */
const MAX_PLAUSIBLE_SESSION_AGE_MS = 365 * 86_400_000;

/**
 * How long ago an inbound peer message was sent, for the delivery header.
 *
 * `ts` is authenticated as coming from that peer (it is inside the signed canonical payload), but
 * its VALUE is the peer's own: its clock may be wrong, or it may simply lie. So the age is measured
 * against the RECEIVER's clock, and anything we cannot believe — a future time beyond ordinary
 * skew, an absurd age, a string with no zone, an unparseable one — degrades to one honest label
 * instead of being rendered as fact ("sent 1096d ago" is a peer-authored claim wearing the
 * harness's voice). Inside the believable window the age is still the peer's claim, only a
 * plausible one: bounding the range narrows what a peer can assert, it does not authenticate it.
 * The result is always a single line: the header it lands on must stay one.
 */
export function peerSentLabel(ts: unknown, now: number): string {
	const sent = parseInstant(ts);
	if (!Number.isFinite(sent) || !Number.isFinite(now)) return UNKNOWN_SENT;
	const age = now - sent;
	if (age < -CLOCK_SKEW_TOLERANCE_MS || age > MAX_PLAUSIBLE_SENT_AGE_MS) return UNKNOWN_SENT;
	// Tolerated skew lands here too: a message "from the future" by a few seconds just arrived.
	if (age <= 1_000) return "sent just now";
	return `sent ${formatDuration(age)} ago`;
}

/**
 * The session anchor's elapsed reading — COARSE on purpose, because it is re-sent every turn as
 * part of the cached system prefix.
 *
 * The ladder: one bucket for the first quarter hour, then quarter hours to the first hour, then
 * whole hours, then days-plus-hours. Worst case for a DAY of continuous work is 27 changes (3
 * quarter-hour steps + 23 hourly ones + the step into day form), i.e. 27 prefix invalidations where a
 * minute-granular label would force 1440 — 15 of them in the first 12 hours, and 24/day from day two
 * on. Each of those 27 buys real signal, since "how long have I been on this"
 * is a pacing question and nobody paces on minutes after the first hour. Inside any one bucket the
 * rendered anchor is byte-identical, so an hour of turns re-sends the same bytes.
 */
export function sessionElapsedLabel(elapsedMs: number): string {
	if (!Number.isFinite(elapsedMs)) return "<15m";
	// A clock that moved backwards (an NTP correction, a session file written by a machine running
	// ahead of this one) makes `elapsedMs` negative, which falls into the floor bucket below. It
	// understates; it never invents hours that did not pass.
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 15) return "<15m";
	if (minutes < 60) return `${Math.floor(minutes / 15) * 15}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The shape this module needs from pi's `SessionHeader` — nothing else, so it stays pure. */
export interface SessionAnchorHeader {
	timestamp?: unknown;
}

/**
 * The one-line session time anchor for the tail of the system prompt, or undefined when there is
 * no believable start to report.
 *
 * WHY the system prompt: the prompt is re-composed and re-sent every turn rather than summarized,
 * so an anchor placed there cannot be compacted away — the same fact placed in the conversation
 * tail would be. WHY the header's timestamp: it is the first entry of the append-only session file,
 * so after `/resume` it is still the ORIGINAL start. That is what makes this answer "how long have
 * I been on this problem" across restarts and not merely across turns. (Branching mints a NEW
 * session file with a fresh header, so the reading restarts there — correctly, since that is a new
 * session; the line claims the life of THIS session, not of the one it was cut from.)
 *
 * The absolute start is a constant for the life of the session, so it costs the prompt cache
 * nothing and it is the half that actually survives; the elapsed reading is bucketed
 * ({@link sessionElapsedLabel}) so it flips rarely.
 */
export function buildSessionAnchor(header: SessionAnchorHeader | null | undefined, now: number): string | undefined {
	const started = parseInstant(header?.timestamp);
	// A fresh in-memory session has no header at all, and a corrupt one must not become a confident
	// wrong start: no anchor is better than an anchor that lies about when the work began.
	if (!Number.isFinite(started) || !Number.isFinite(now)) return undefined;
	// Parseable is not believable. An epoch-zero or year-0001 header parses cleanly and would put
	// "you have been on it 20685d 12h" into the system prompt as fact; a start in the future is the
	// same failure with the sign flipped. Both are corruption, not a long session — so neither gets
	// an anchor, by the same rule that governs the unparseable case above.
	const elapsed = now - started;
	if (elapsed < -CLOCK_SKEW_TOLERANCE_MS || elapsed > MAX_PLAUSIBLE_SESSION_AGE_MS) return undefined;
	// Minute precision, UTC: unambiguous wherever the session is resumed, and constant — seconds
	// would add churn to the one part of this line that is supposed to never change.
	const absolute = `${new Date(started).toISOString().slice(0, 16)}Z`;
	return (
		`[pi-persona] Session clock — this session started ${absolute} and you have been on it ${sessionElapsedLabel(elapsed)}. ` +
		"That is the whole life of THIS session, and it survives compaction and restarts; the reading is deliberately coarse, so pace yourself by it rather than measure with it."
	);
}

/**
 * Ownership READ over the work ledger — pure formatting, no I/O.
 *
 * A peer today learns who owns what only when its own claim or ask collides with someone else's.
 * This renders the ledger as one bounded status view — the same read `exocom_status` and `/exocom`
 * both hand back — so a session can check before it claims or writes, not just after a refusal.
 *
 * `slice`, `write_set`, `question`, and every peer display name are PEER-AUTHORED and only
 * length-bounded at the wire boundary (envelope.ts) — a hostile peer can put terminal escapes or
 * instruction-shaped text in any of them. Every such field is stripped and collapsed
 * ({@link untrusted}) before it is rendered, own rows included (defense in depth: this session's
 * own prior tool calls are not a different trust boundary from the ledger file itself). The two
 * sections that can ONLY contain a peer's own claims or a peer's own question — "peer claims" and
 * "asks waiting for you" — are additionally wrapped in one `fencePeer` per section, so the model
 * reads them as quoted data rather than instructions, the same discipline `pendingAskBlock`
 * already applies to a single pending ask.
 */
import type { LedgerAsk, LedgerClaim, LedgerState } from "./ledger.ts";
import { formatDuration } from "../core/time.ts";
import { fencePeer, stripTerminalControls } from "../core/fence.ts";

/** No section may hand the model an unbounded ledger — a long-lived scope with many claims stays
 *  one bounded read, same discipline as the pending-ask block and the peer roster. */
const MAX_ROWS = 20;
/** A single claim's write_set is peer-controlled in length up to 64 paths (envelope.ts); the row
 *  itself stays one bounded line rather than growing with the claim. */
const MAX_WRITE_SET_ENTRIES = 8;

/** Strip terminal controls, collapse the field to one line, and bound its length. Every
 *  peer-authored ledger field goes through this before it is ever interpolated into the report. */
function untrusted(value: string, max: number): string {
	return stripTerminalControls(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function ageFor(ts: string, now: number): string {
	return formatDuration(now - Date.parse(ts));
}

function byTsAscending(a: { ts: string }, b: { ts: string }): number {
	return Date.parse(a.ts) - Date.parse(b.ts);
}

function renderWriteSet(writeSet: readonly string[]): string {
	const paths = writeSet.map((path) => untrusted(path, 120));
	if (paths.length <= MAX_WRITE_SET_ENTRIES) return paths.join(", ");
	return `${paths.slice(0, MAX_WRITE_SET_ENTRIES).join(", ")}, +${paths.length - MAX_WRITE_SET_ENTRIES} more`;
}

function resolveLabel(sessionId: string, labelFor: (sessionId: string) => string | undefined): string {
	return untrusted(labelFor(sessionId) ?? sessionId, 48);
}

function claimRow(claim: LedgerClaim, self: string, labelFor: (sessionId: string) => string | undefined, now: number): string {
	// Own rows omit the label — a session does not need to be told its own name.
	const prefix = claim.from_session === self ? "" : `${resolveLabel(claim.from_session, labelFor)} · `;
	return `• ${prefix}${untrusted(claim.slice, 80)} · ${renderWriteSet(claim.write_set)} · ${ageFor(claim.ts, now)}`;
}

function askRow(ask: LedgerAsk, otherSession: string, labelFor: (sessionId: string) => string | undefined, now: number): string {
	const label = resolveLabel(otherSession, labelFor);
	return `• ${label} · ${ask.work_key} · ${ask.ask_id} · "${untrusted(ask.question, 200)}" · ${ageFor(ask.ts, now)}`;
}

/** `fence: true` wraps the WHOLE section body in one `fencePeer` call — the title stays outside
 *  it, matching `attributePeer`'s anti-spoofing shape (a payload cannot fake the section it's in). */
function section(title: string, rows: string[], options: { fence?: boolean } = {}): string {
	if (rows.length === 0) return `${title}:\n(none)`;
	const bounded = rows.length <= MAX_ROWS ? rows : [...rows.slice(0, MAX_ROWS), `… +${rows.length - MAX_ROWS} more`];
	const body = bounded.join("\n");
	return `${title}:\n${options.fence ? fencePeer(body) : body}`;
}

/**
 * Render the whole ledger from `self`'s point of view: what it owns, what peers own, who is
 * waiting on it, and what it is waiting on — the read that lets a session check ownership before
 * it claims or writes, instead of learning it only from a refused claim.
 */
export function formatLedgerStatus(
	state: LedgerState,
	self: string,
	labelFor: (sessionId: string) => string | undefined,
	now: number,
): string {
	const ownClaims = state.claims.filter((claim) => claim.from_session === self).sort(byTsAscending);
	const peerClaims = state.claims.filter((claim) => claim.from_session !== self).sort(byTsAscending);
	const asksForYou = state.asks.filter((ask) => ask.to_session === self).sort(byTsAscending);
	const yourAsks = state.asks.filter((ask) => ask.from_session === self).sort(byTsAscending);

	if (ownClaims.length === 0 && peerClaims.length === 0 && asksForYou.length === 0 && yourAsks.length === 0) {
		return "nothing claimed or pending";
	}

	return [
		section("your claims", ownClaims.map((claim) => claimRow(claim, self, labelFor, now))),
		section("peer claims", peerClaims.map((claim) => claimRow(claim, self, labelFor, now)), { fence: true }),
		section("asks waiting for you", asksForYou.map((ask) => askRow(ask, ask.from_session, labelFor, now)), { fence: true }),
		section("your open asks", yourAsks.map((ask) => askRow(ask, ask.to_session, labelFor, now))),
	].join("\n\n");
}

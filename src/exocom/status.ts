/**
 * Ownership READ over the work ledger — pure formatting, no I/O.
 *
 * A peer today learns who owns what only when its own claim or ask collides with someone else's.
 * This renders the ledger as one bounded status view — the same read `exocom_status` and `/exocom`
 * both hand back — so a session can check before it claims or writes, not just after a refusal.
 */
import type { LedgerAsk, LedgerClaim, LedgerState } from "./ledger.ts";
import { formatDuration } from "../core/time.ts";

/** No section may hand the model an unbounded ledger — a long-lived scope with many claims stays
 *  one bounded read, same discipline as the pending-ask block and the peer roster. */
const MAX_ROWS = 20;

function ageFor(ts: string, now: number): string {
	return formatDuration(now - Date.parse(ts));
}

function byTsAscending(a: { ts: string }, b: { ts: string }): number {
	return Date.parse(a.ts) - Date.parse(b.ts);
}

function claimRow(claim: LedgerClaim, self: string, labelFor: (sessionId: string) => string | undefined, now: number): string {
	// Own rows omit the label — a session does not need to be told its own name.
	const prefix = claim.from_session === self ? "" : `${labelFor(claim.from_session) ?? claim.from_session} · `;
	return `• ${prefix}${claim.slice} · ${claim.write_set.join(", ")} · ${ageFor(claim.ts, now)}`;
}

function askRow(ask: LedgerAsk, otherSession: string, labelFor: (sessionId: string) => string | undefined, now: number): string {
	const label = labelFor(otherSession) ?? otherSession;
	return `• ${label} · ${ask.work_key} · ${ask.ask_id} · "${ask.question}" · ${ageFor(ask.ts, now)}`;
}

function section(title: string, rows: string[]): string {
	if (rows.length === 0) return `${title}:\n(none)`;
	if (rows.length <= MAX_ROWS) return `${title}:\n${rows.join("\n")}`;
	const shown = rows.slice(0, MAX_ROWS);
	return `${title}:\n${shown.join("\n")}\n… +${rows.length - MAX_ROWS} more`;
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
		section("peer claims", peerClaims.map((claim) => claimRow(claim, self, labelFor, now))),
		section("asks waiting for you", asksForYou.map((ask) => askRow(ask, ask.from_session, labelFor, now))),
		section("your open asks", yourAsks.map((ask) => askRow(ask, ask.to_session, labelFor, now))),
	].join("\n\n");
}

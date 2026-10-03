/**
 * Shared param normalisation for strategies. Unknown/junk values fall back rather than
 * silently changing semantics (I2 is lenient on unknown KEYS; a declared number that is
 * NaN/negative still has to mean something honest). An aux ACTOR (`judge`, `synthesizer`,
 * `generator`, `critic`) is the one exception: it is declared by name, so a supplied-but-
 * unusable value is a typo to diagnose, not a reason to quietly run someone else.
 */

import { parseRuntimeRosterMember, rosterSpec, type RosterSpec } from "./roster.ts";

/** A finite integer ≥ 1, else `fallback`. Fractional values floor. */
export function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}

/**
 * A best-of-N threshold: positive integer, then clamped to the roster size.
 * An unclamped `bestOf: 10` on a 3-member panel can never be reached, so every round
 * would fall through to best-by-confidence while the header still claimed "best-of-10".
 */
export function clampBestOf(value: unknown, rosterSize: number): { bestOf: number; clamped: boolean } {
	const majority = Math.floor(rosterSize / 2) + 1;
	const requested = positiveInteger(value, majority);
	const bestOf = Math.min(requested, Math.max(1, rosterSize));
	return { bestOf, clamped: bestOf !== requested };
}

/** An aux actor param parsed into the run-spec fields it contributes. */
export type AuxActor = { ok: true; spec: RosterSpec } | { ok: false; error: string };

/**
 * Parse an aux actor param — a bare agent name OR an inline roster member
 * (`{ agent, role?, model?, skills?, tools?, isolation?, mcp? }`), so an arbiter, critic,
 * generator or synthesiser can be SPECIALISED for one call exactly like a roster member.
 *
 * `undefined` means "not supplied" (absent/null/blank ⇒ the strategy's own default applies).
 * `{ ok: false }` means "supplied but unusable" — a typo must never be answered by silently
 * running a DIFFERENT actor than the caller named, and the member's own fields are validated
 * STRICTLY (`parseRuntimeRosterMember`): a `tools` list with a non-string entry would otherwise
 * normalise to a different allowlist — or be dropped, widening the leg to the agent defaults.
 */
export function parseAuxActor(value: unknown, param: string): AuxActor | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string" && !value.trim()) return undefined; // blank = not supplied
	const parsed = parseRuntimeRosterMember(value);
	if (!parsed.ok) return { ok: false, error: `params.${param} must be ${parsed.error}` };
	return { ok: true, spec: rosterSpec(parsed.member) };
}

/**
 * Shared param normalisation for strategies. Unknown/junk values fall back rather than
 * silently changing semantics (I2 is lenient on unknown KEYS; a declared number that is
 * NaN/negative still has to mean something honest).
 */

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

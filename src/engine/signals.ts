/**
 * Shared AbortSignal plumbing for the engine backends.
 */

/** One signal that fires when any of the given signals fires (ignores undefined). */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return undefined;
	if (live.length === 1) return live[0];
	return AbortSignal.any(live);
}

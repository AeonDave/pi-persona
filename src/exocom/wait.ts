/** Non-blocking exocom join — arm a wake, never hold the MCP tool call. Pure kernel. */
export const EXOCOM_WAIT_MAX_MS = 600_000;

/** Clamp an optional timeout to (0, EXOCOM_WAIT_MAX_MS]; default is the cap. */
export function waitTimeoutMs(requested: number | undefined, cap = EXOCOM_WAIT_MAX_MS): number {
	const ceiling = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : EXOCOM_WAIT_MAX_MS;
	if (requested === undefined || !Number.isFinite(requested)) return ceiling;
	return Math.min(ceiling, Math.max(1, Math.floor(requested)));
}

export interface WaitMatch {
	work_key: string;
	ask_id?: string;
}

/** A waiter for `work_key` (and optional `ask_id`) fires on a matching answer/release. */
export function waitMatches(waiter: WaitMatch, event: WaitMatch): boolean {
	if (waiter.work_key !== event.work_key) return false;
	if (waiter.ask_id === undefined || waiter.ask_id === "") return true;
	return event.ask_id === waiter.ask_id;
}

/** Match cleanup notices only through extension-owned metadata. A substring search confuses `a`
 * with `a1` and, worse, lets untrusted postcard prose containing `ask_id=...` discard an unrelated
 * queued delivery. Notifier items are still strings, so recognize only their trusted header lines. */
export function waitNoticeMatchesAskId(notice: string, askId: string): boolean {
	if (!askId) return false;
	const [first = "", second = ""] = notice.split(/\r?\n/, 2);
	const metadata = first === "[exocom-pending-ask]"
		? second
		: first.startsWith("[pi-persona] exocom answer ·") || first.startsWith("[pi-persona] exocom wait ")
			? first
			: "";
	return metadata.split(/[\t ·]+/u).includes(`ask_id=${askId}`);
}

/** Resolve host-local facts outside the pure clock formatter. */
import { buildClockSnapshot } from "../core/time.ts";

export function readClockSnapshot(now: number): string | undefined {
	const date = new Date(now);
	if (!Number.isFinite(date.getTime())) return undefined;
	let timeZone = "local timezone";
	try {
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
	} catch {
		// The numeric offset still identifies local time when an IANA name is unavailable.
	}
	return buildClockSnapshot(now, { timeZone, offsetMinutes: -date.getTimezoneOffset() });
}

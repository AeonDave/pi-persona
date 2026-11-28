import { MAX_TIMER_DELAY_MS } from "../core/config.ts";

/** Schedule a positive, finite watchdog delay and return its disarm function. */
export function armWatchdogTimeout(onExpiry: () => void, delayMs: number): () => void {
	if (delayMs <= MAX_TIMER_DELAY_MS) {
		const timer = setTimeout(onExpiry, delayMs);
		timer.unref?.();
		return () => clearTimeout(timer);
	}

	// Node converts larger delays to 1 ms. Recheck elapsed time at each segment so a
	// delayed callback doesn't extend the original deadline by the same amount.
	const startedAt = performance.now();
	let timer = setTimeout(checkDeadline, MAX_TIMER_DELAY_MS);
	timer.unref?.();
	function checkDeadline(): void {
		const remainingMs = delayMs - (performance.now() - startedAt);
		if (remainingMs <= 0) {
			onExpiry();
			return;
		}
		timer = setTimeout(checkDeadline, Math.min(Math.ceil(remainingMs), MAX_TIMER_DELAY_MS));
		timer.unref?.();
	}
	return () => clearTimeout(timer);
}

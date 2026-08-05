/**
 * Bounded-concurrency fan-out — the one place concurrency is implemented.
 * Pure (no I/O): order-preserving, clamps the limit, and never runs more than
 * `concurrency` callbacks at once. Used by `parallel()` in the Strategy SDK and
 * by the delegate tool's parallel mode.
 */

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut>(items.length);
	let next = 0;
	// Contained rejection, two halves. CONTAINMENT: once a callback rejects no worker pulls another
	// item, so a failed fan-out can't keep spawning siblings whose results are already destined for
	// the bin. LATENCY: the batch rejects with the FIRST error the moment it lands. A callback
	// already in flight cannot be cancelled from here, so awaiting it would not stop the work — it
	// would only delay the report, and the rejections that reach this path are the run-fatal ones
	// (`sdk.parallel`: a limit breach, a throwing host callback) that an operator must see now
	// rather than after the slowest healthy leg, which for a delegated agent is minutes. The worker
	// swallows into `failure`, so an abandoned one can never surface as an unhandled rejection.
	let failure: { error: unknown } | undefined;
	let onFailure = (): void => { /* replaced below */ };
	const fatal = new Promise<void>((resolve) => {
		onFailure = resolve;
	});
	const worker = async (): Promise<void> => {
		while (!failure) {
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index]!, index);
			} catch (error) {
				failure ??= { error };
				onFailure();
			}
		}
	};
	await Promise.race([Promise.all(Array.from({ length: limit }, () => worker())), fatal]);
	if (failure) throw failure.error;
	return results;
}

/**
 * A counting semaphore for concurrency across INDEPENDENT launches (where
 * `mapWithConcurrency` can't apply because the jobs don't arrive as one batch) —
 * e.g. async delegate runs launched across several tool calls. FIFO, throw-safe:
 * the slot is released even when the job rejects.
 */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(slots: number) {
		this.available = Math.max(1, slots);
	}

	/** Run `fn` once a slot is free; the slot is released when it settles. */
	async with<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next(); // hand the slot straight to the next waiter
		else this.available += 1;
	}
}

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
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}

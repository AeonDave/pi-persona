/** Relative advertised cost within one provider; never capability, throughput, or effort. */
export type ModelTier = "low" | "medium" | "high";

export interface ModelCostMetadata {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	cost?: { input: number; output: number };
	thinkingLevelMap?: Partial<Record<string, unknown>>;
}

/**
 * Rank distinct positive input+output prices within each provider, using an equal-token
 * input/output proxy. The first ceil(n/3) prices are low, through ceil(2n/3) medium,
 * and the rest high. Aliases cannot change the cutoffs. At least three distinct prices
 * are required; missing/zero prices remain unknown. No model names or ids imply a tier.
 * An uncapped reference keeps labels stable across searches; outside prices clamp to
 * its low/high bands. These are catalog comparisons, not account billing estimates.
 */
export function modelCostTiers(models: readonly ModelCostMetadata[], reference: readonly ModelCostMetadata[] = models): Map<string, ModelTier> {
	const pricesByProvider = new Map<string, Set<number>>();
	for (const model of reference) {
		const price = priceProxy(model);
		if (price === undefined) continue;
		let prices = pricesByProvider.get(model.provider);
		if (!prices) {
			prices = new Set();
			pricesByProvider.set(model.provider, prices);
		}
		prices.add(price);
	}
	const cutoffs = new Map<string, { low: number; medium: number }>();
	for (const [provider, prices] of pricesByProvider) {
		if (prices.size < 3) continue;
		const sorted = [...prices].sort((a, b) => a - b);
		const low = sorted[Math.ceil(sorted.length / 3) - 1];
		const medium = sorted[Math.ceil(2 * sorted.length / 3) - 1];
		if (low !== undefined && medium !== undefined) cutoffs.set(provider, { low, medium });
	}
	const tiers = new Map<string, ModelTier>();
	for (const model of models) {
		const price = priceProxy(model);
		const bands = cutoffs.get(model.provider);
		if (price === undefined || !bands) continue;
		tiers.set(`${model.provider}/${model.id}`, price <= bands.low ? "low" : price <= bands.medium ? "medium" : "high");
	}
	return tiers;
}

function positiveFinite(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

function priceProxy(model: ModelCostMetadata): number | undefined {
	if (!positiveFinite(model.cost?.input) || !positiveFinite(model.cost?.output)) return undefined;
	const price = model.cost.input + model.cost.output;
	if (!positiveFinite(price)) return undefined;
	// Decimal catalog prices can sum to adjacent binary floats; do not invent a new price rank.
	const normalized = Number(price.toPrecision(12));
	return positiveFinite(normalized) ? normalized : undefined;
}

function shortNumber(value: number): string {
	return value.toPrecision(3).replace(/(?:\.0+|(\.\d+?)0+)(?=e|$)/, "$1");
}

function contextLabel(value: number): string {
	if (value >= 1_000_000) return `${shortNumber(value / 1_000_000)}M`;
	if (value >= 1_000) return `${shortNumber(value / 1_000)}k`;
	return shortNumber(value);
}

/** Host catalog hints; API prices are advertised values, not an OAuth billing estimate. */
export function modelCandidateDetails(model: ModelCostMetadata, tier?: ModelTier): string {
	const details: string[] = [`cost:${tier ?? "unknown"}`];
	if (model.reasoning === true) details.push("reasoning");
	if (positiveFinite(model.contextWindow)) details.push(`ctx ${contextLabel(model.contextWindow)}`);
	if (positiveFinite(model.cost?.input) && positiveFinite(model.cost?.output)) {
		details.push(`API $${shortNumber(model.cost.input)}/$${shortNumber(model.cost.output)} per 1M in/out`);
	}
	return `[${details.join("; ")}]`;
}

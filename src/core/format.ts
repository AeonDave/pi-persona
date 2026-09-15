/** Compact token count for status digests — 164005 → "164k", 1_234_567 → "1.2M". Every raw token
 *  render (tree details, peek digests) goes through this one function so the strings never drift. */
export function compactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

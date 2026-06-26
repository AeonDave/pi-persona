/**
 * Compact token/cost formatting for sub-agent cards (pure). Shows uncached input
 * (↑), output (↓), and — crucially — cache read/write (R/W) so the numbers read
 * truthfully under prompt caching (where ↑ alone looks misleadingly tiny).
 */

import type { ChildUsage } from "../engine/stream.ts";

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: ChildUsage): string {
	const parts: string[] = [];
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

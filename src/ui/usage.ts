/**
 * Compact token/cost formatting for sub-agent cards (pure). Shows uncached input
 * (↑), output (↓), and — crucially — cache read/write (R/W) so the numbers read
 * truthfully under prompt caching (where ↑ alone looks misleadingly tiny).
 *
 * Also the conversion + session ledger that make Pi's footer (and pi-theme-1337's
 * frame, which walks the same entries) count sub-agent spend. Pi only sums the
 * supervisor session: assistant usage, `toolResult.usage`, compaction, and
 * branch summaries. Child sessions never appear there unless we attach a Pi
 * `Usage` on the supervisor tool result, or publish leftover async cost on the
 * `persona-cost` status key for a companion frame to add.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { emptyUsage, type ChildUsage } from "../engine/stream.ts";

/** Extension status key owned by pi-persona; pi-theme-1337 adds it to the frame $ . */
export const PERSONA_COST_STATUS_KEY = "persona-cost";

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

export function hasBillableUsage(u: ChildUsage): boolean {
	return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0 || u.cost > 0;
}

/** Pi's `Usage` shape — the footer / 1337 frame both read `cost.total`. */
export function toToolUsage(u: ChildUsage): Usage {
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
	};
}

/** Spread onto a tool result so Pi records it as `toolResult.usage`. */
export function toolUsageField(u: ChildUsage): { usage: Usage } | Record<string, never> {
	return hasBillableUsage(u) ? { usage: toToolUsage(u) } : {};
}

/**
 * Format leftover (not-yet-on-a-tool-result) child cost for `setStatus`. Matches
 * pi-theme-1337's `$0.423` / `$2.50` convention so the frame can parse it.
 * `undefined` clears the status.
 */
export function formatPersonaCostStatus(u: ChildUsage): string | undefined {
	if (!(u.cost > 0) || !Number.isFinite(u.cost)) return undefined;
	return u.cost < 1 ? `$${u.cost.toFixed(3)}` : `$${u.cost.toFixed(2)}`;
}

function plus(a: ChildUsage, b: ChildUsage): ChildUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: 0,
		turns: a.turns + b.turns,
	};
}

function minus(a: ChildUsage, b: ChildUsage): ChildUsage {
	return {
		input: Math.max(0, a.input - b.input),
		output: Math.max(0, a.output - b.output),
		cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
		cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
		cost: Math.max(0, a.cost - b.cost),
		contextTokens: 0,
		turns: Math.max(0, a.turns - b.turns),
	};
}

/**
 * Session-scoped child spend. `add` every engine run; `account` when that spend
 * is written onto a supervisor tool result. `pending` is what the footer/frame
 * would otherwise miss (background legs whose launch result had no usage yet).
 */
export class ChildUsageLedger {
	private total: ChildUsage = emptyUsage();
	private billed: ChildUsage = emptyUsage();
	private billedKeys = new Set<string>();

	add(usage: ChildUsage): void {
		this.total = plus(this.total, usage);
	}

	/** Returns false when `key` was already billed (don't attach the same spend twice). */
	account(usage: ChildUsage, key?: string): boolean {
		if (key !== undefined) {
			if (this.billedKeys.has(key)) return false;
			this.billedKeys.add(key);
		}
		this.billed = plus(this.billed, usage);
		return true;
	}

	accountMany(items: Array<{ key: string; usage: ChildUsage }>): ChildUsage {
		let fresh = emptyUsage();
		for (const item of items) {
			if (this.account(item.usage, item.key)) fresh = plus(fresh, item.usage);
		}
		return fresh;
	}

	pending(): ChildUsage {
		return minus(this.total, this.billed);
	}

	reset(): void {
		this.total = emptyUsage();
		this.billed = emptyUsage();
		this.billedKeys.clear();
	}
}

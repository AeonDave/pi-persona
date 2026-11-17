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
 * `persona-cost` status key for a companion frame to add. That leftover is rebuilt
 * from the session file's terminal-result records and billing tool results on every
 * session start, so it survives a restart, `/resume` or fork (`reconstructChildSpend`).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { emptyUsage, type ChildUsage } from "../engine/stream.ts";
import { TERMINAL_RESULT_ENTRY } from "../results/types.ts";

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

/** Pi's `Usage` shape — the footer / pi-theme-1337 frame both read `cost.total`. */
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

/** The supervisor tools whose results carry ledger-billed child usage (`toolUsageField`). */
const BILLING_TOOLS: ReadonlySet<string> = new Set(["delegate", "council", "flow", "intercom"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown, optional: boolean): number | undefined {
	if (value === undefined && optional) return 0;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A terminal record's cumulative usage, or undefined when it is not a well-formed count set. */
function terminalUsage(value: unknown): ChildUsage | undefined {
	const u = record(value);
	if (!u) return undefined;
	const input = count(u.input, false), output = count(u.output, false), cacheRead = count(u.cacheRead, true);
	const cacheWrite = count(u.cacheWrite, true), cost = count(u.cost, true), turns = count(u.turns, true);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || cost === undefined || turns === undefined) return undefined;
	return { input, output, cacheRead, cacheWrite, cost, contextTokens: 0, turns };
}

/** Pi's persisted tool-result `Usage` (the footer reads `cost.total`). */
function toolResultUsage(value: unknown): ChildUsage | undefined {
	const u = record(value);
	if (!u) return undefined;
	const input = count(u.input, true), output = count(u.output, true), cacheRead = count(u.cacheRead, true);
	const cacheWrite = count(u.cacheWrite, true), cost = count(record(u.cost)?.total, true);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || cost === undefined) return undefined;
	return { input, output, cacheRead, cacheWrite, cost, contextTokens: 0, turns: 0 };
}

/** The run ids a persisted billing result names: delegate `settledRuns[].id`, intercom `result` → `runId`. */
function billedRunIds(toolName: string, details: Record<string, unknown>): string[] {
	if (toolName === "delegate") {
		const settled = details.settledRuns;
		return Array.isArray(settled) ? settled.flatMap((run) => { const id = record(run)?.id; return typeof id === "string" ? [id] : []; }) : [];
	}
	if (toolName === "intercom") return details.action === "result" && typeof details.runId === "string" ? [details.runId] : [];
	return [];
}

export interface ChildSpendHistory {
	/** Usage of every counted terminal record. */
	total: ChildUsage;
	/** Usage of the counted records a persisted billing tool result claims (a subset of `total`). */
	billed: ChildUsage;
}

interface CountedRecord {
	usage: ChildUsage;
	billed: boolean;
}

/**
 * Rebuild the ledger from ONE session file's entries (all branches, like Pi's footer). Pure.
 *
 * Counted records: every `pi-persona-terminal-result` record carrying an `originRunId` — a tracker
 * run (`run-<n>`) or a top-level untracked root (`root:<uuid>`) — once per record identity (its
 * `ref`; the same record appended twice is one record). Two records sharing a run id are two runs:
 * ids repeated across owner generations before ids were made file-unique. A background
 * council/flow record already holds the aggregate, so its per-leg/per-phase records (no
 * `originRunId`) are never added beside it.
 *
 * Billing: a persisted delegate/council/flow/intercom tool result carrying `usage` claims the
 * record its `details.resultReceipt.ref` names exactly (nothing when that ref is not in the
 * file); without a receipt ref, per named run id (delegate
 * `settledRuns[].id`, intercom `runId`), the most recent record with that id that PRECEDES it in
 * file order (records are appended at settle time, before any collection). A record is claimed
 * at most once, and what is subtracted is that record's usage — the amount the live ledger billed.
 * A billing that resolves to no counted record adds and subtracts nothing: its run's record was
 * never written (a council/flow receipt lacks a `ref` only when no record was saved), so its spend
 * was never in `total`.
 *
 * Invariant: `billed` is a sub-sum of `total`, so `total − billed` = Σ unclaimed counted records'
 * usage — never negative in any field, and equal to what the live ledger showed for the same history.
 */
export function reconstructChildSpend(entries: readonly unknown[]): ChildSpendHistory {
	const records: CountedRecord[] = [];
	const byRef = new Map<string, CountedRecord>();
	const latestByRunId = new Map<string, CountedRecord>();
	const claim = (target: CountedRecord | undefined): void => { if (target) target.billed = true; };
	for (const raw of entries) {
		const entry = record(raw);
		if (!entry) continue;
		if (entry.type === "custom" && entry.customType === TERMINAL_RESULT_ENTRY) {
			const data = record(entry.data);
			const id = data?.originRunId, ref = data?.ref;
			const usage = terminalUsage(data?.usage);
			if (typeof id !== "string" || typeof ref !== "string" || !usage || byRef.has(ref)) continue;
			const counted: CountedRecord = { usage, billed: false };
			records.push(counted);
			byRef.set(ref, counted);
			latestByRunId.set(id, counted);
		} else if (entry.type === "message") {
			const message = record(entry.message);
			if (message?.role !== "toolResult" || typeof message.toolName !== "string" || !BILLING_TOOLS.has(message.toolName)) continue;
			if (message.usage === undefined || !toolResultUsage(message.usage)) continue;
			const details = record(message.details);
			if (!details) continue;
			// A receipt ref names the run's own record exactly; one absent from the file (memory-only,
			// append failure) means that record was never counted, so it must not fall back to an
			// older record that happens to share the run id.
			const ref = record(details.resultReceipt)?.ref;
			if (typeof ref === "string") claim(byRef.get(ref));
			else for (const id of billedRunIds(message.toolName, details)) claim(latestByRunId.get(id));
		}
	}
	let total = emptyUsage();
	let billed = emptyUsage();
	for (const counted of records) {
		total = plus(total, counted.usage);
		if (counted.billed) billed = plus(billed, counted.usage);
	}
	return { total, billed };
}

/**
 * Session-scoped child spend. `add` every engine run; `account` when that spend
 * is written onto a supervisor tool result. `pending` is what the footer/frame
 * would otherwise miss (background legs whose launch result had no usage yet).
 * `restore` rebuilds it from the session file on every session start, so the
 * figure survives a restart, `/resume` or a fork; `session()` is the token an
 * engine run captures at start so a run that settles after the session changed
 * cannot land in the next session's ledger.
 */
export class ChildUsageLedger {
	private total: ChildUsage = emptyUsage();
	private billed: ChildUsage = emptyUsage();
	private billedKeys = new Set<string>();
	private epoch = 0;

	session(): number {
		return this.epoch;
	}

	/** Dropped when `session` is a superseded token (the run started before the last reset/restore). */
	add(usage: ChildUsage, session = this.epoch): void {
		if (session !== this.epoch) return;
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
		this.epoch++;
		this.total = emptyUsage();
		this.billed = emptyUsage();
		this.billedKeys.clear();
	}

	/** Start a new session from what its file already records (see `reconstructChildSpend`). Only the
	 *  sums carry over, never the billed run ids: a restarted instance cannot collect a historical run,
	 *  and a restored id must never veto billing a NEW run that reuses it. */
	restore(entries: readonly unknown[]): void {
		this.reset();
		const history = reconstructChildSpend(entries);
		this.total = history.total;
		this.billed = history.billed;
	}
}

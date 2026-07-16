/**
 * `TimerScheduler` — the pure kernel behind the supervisor-armable `timer` tool.
 *
 * Problem it solves: a supervisor that must WAIT for a fixed wall-clock moment (an HTB machine
 * release, a rate-limit window, a scheduled re-check) has no cheap way to "sleep and resume". The
 * MCP/transport layer caps a blocking tool call at ~20-60s, so a 50-minute wait degenerates into
 * dozens of token-burning polls. The fix is an ALARM, not a sleep: arm a timer that, when it
 * expires, WAKES the session by injecting a follow-up (the extension routes the fire through the
 * same idle-delivery notifier that surfaces async-run completions — an idle delivery always starts
 * a fresh turn, so the supervisor resumes on its own).
 *
 * This module is pure (injected clock + setTimer/clearTimer + an onFire sink), so scheduling,
 * validation, cancellation and listing are unit-tested without a live model or real wall clock.
 * The extension owns the side effects (the actual timer + the wake delivery).
 */

/** A scheduled wakeup. `message` is what gets injected into the session when it fires. */
export interface TimerEntry {
	id: string;
	label: string;
	/** Absolute wall-clock fire time (epoch ms). */
	fireAtEpochMs: number;
	/** When the timer was armed (epoch ms) — for the "armed Xs ago" view. */
	armedAtEpochMs: number;
	/** The follow-up text delivered to the session on fire. */
	message: string;
}

export interface TimerArmRequest {
	/** Human label for the alarm (e.g. "Paperwork release"). Optional; defaults to the id. */
	label?: string;
	/** The follow-up injected into the session when the timer fires. Required, non-empty. */
	message: string;
	/** Fire after this many ms from now. Exactly one of delayMs / atEpochMs must be given. */
	delayMs?: number;
	/** Fire at this absolute epoch-ms. Exactly one of delayMs / atEpochMs must be given. */
	atEpochMs?: number;
}

/** A read-only snapshot of an armed timer, with the live remaining time. */
export interface TimerView {
	id: string;
	label: string;
	fireAtEpochMs: number;
	remainingMs: number;
	message: string;
}

export interface TimerArmResult {
	ok: boolean;
	error?: string;
	entry?: TimerEntry;
}

export interface TimerSchedulerDeps {
	/** Current wall-clock (epoch ms). Injected so tests control the clock. */
	now: () => number;
	/** Schedule a callback after `ms`; returns an opaque handle. */
	setTimer: (fn: () => void, ms: number) => unknown;
	/** Cancel a scheduled callback by its handle. */
	clearTimer: (handle: unknown) => void;
	/** Called exactly once when a timer expires (never for a cancelled one). */
	onFire: (entry: TimerEntry) => void;
	/** Minimum accepted delay (ms). Default 1000 — sub-second alarms are pointless here. */
	minDelayMs?: number;
	/** Maximum accepted delay (ms). Default 24h — guards against a runaway/typo alarm. */
	maxDelayMs?: number;
}

const DEFAULT_MIN_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1_000;

interface Scheduled {
	entry: TimerEntry;
	handle: unknown;
}

export class TimerScheduler {
	private readonly deps: TimerSchedulerDeps;
	private readonly minDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly timers = new Map<string, Scheduled>();
	private seq = 0;

	constructor(deps: TimerSchedulerDeps) {
		this.deps = deps;
		this.minDelayMs = deps.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
		this.maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	}

	/** Arm a new alarm. Returns the entry on success, or a reason on rejection. */
	arm(req: TimerArmRequest): TimerArmResult {
		const message = (req.message ?? "").trim();
		if (!message) return { ok: false, error: "timer needs a non-empty message (the follow-up injected when it fires)." };

		const hasDelay = req.delayMs !== undefined;
		const hasAt = req.atEpochMs !== undefined;
		if (hasDelay === hasAt) {
			return { ok: false, error: "timer needs exactly one of { delayMs } or { atEpochMs }." };
		}

		const now = this.deps.now();
		const fireAt = hasDelay ? now + (req.delayMs as number) : (req.atEpochMs as number);
		if (!Number.isFinite(fireAt)) return { ok: false, error: "timer fire time is not a finite number." };

		const delay = fireAt - now;
		if (delay < this.minDelayMs) {
			return { ok: false, error: `timer fires too soon (in ${delay}ms; minimum ${this.minDelayMs}ms). For an absolute time, check it is in the future.` };
		}
		if (delay > this.maxDelayMs) {
			return { ok: false, error: `timer fires too far out (in ${delay}ms; maximum ${this.maxDelayMs}ms).` };
		}

		const id = `timer-${++this.seq}`;
		const entry: TimerEntry = {
			id,
			label: (req.label ?? "").trim() || id,
			fireAtEpochMs: fireAt,
			armedAtEpochMs: now,
			message,
		};
		const handle = this.deps.setTimer(() => this.fire(id), delay);
		this.timers.set(id, { entry, handle });
		return { ok: true, entry };
	}

	/** Cancel an armed alarm by id. Returns false if unknown (already fired or never existed). */
	cancel(id: string): boolean {
		const scheduled = this.timers.get(id);
		if (!scheduled) return false;
		this.deps.clearTimer(scheduled.handle);
		this.timers.delete(id);
		return true;
	}

	/** Cancel every armed alarm (reload/dispose hygiene — never leak a timer across sessions). */
	cancelAll(): void {
		for (const scheduled of this.timers.values()) this.deps.clearTimer(scheduled.handle);
		this.timers.clear();
	}

	/** Snapshot of all armed alarms, soonest first, with live remaining time. */
	list(): TimerView[] {
		const now = this.deps.now();
		return [...this.timers.values()]
			.map((s) => ({
				id: s.entry.id,
				label: s.entry.label,
				fireAtEpochMs: s.entry.fireAtEpochMs,
				remainingMs: Math.max(0, s.entry.fireAtEpochMs - now),
				message: s.entry.message,
			}))
			.sort((a, b) => a.fireAtEpochMs - b.fireAtEpochMs);
	}

	/** Number of currently armed alarms. */
	get size(): number {
		return this.timers.size;
	}

	private fire(id: string): void {
		const scheduled = this.timers.get(id);
		if (!scheduled) return; // cancelled between expiry and callback — nothing to do
		this.timers.delete(id);
		this.deps.onFire(scheduled.entry);
	}
}

/** Render a fired-timer batch into one wake message for the supervisor. Exported for reuse + test. */
export function renderTimerFire(entries: TimerEntry[]): string {
	if (entries.length === 0) return "";
	const head = `[pi-persona] ⏰ ${entries.length} timer${entries.length === 1 ? "" : "s"} fired — resuming:`;
	const blocks = entries.map((e) => `• ${e.label} (${e.id}): ${e.message}`);
	return [head, ...blocks].join("\n");
}

/** Compact human-readable duration for the `list` view (e.g. "49m 12s", "1h 03m"). */
export function formatRemaining(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

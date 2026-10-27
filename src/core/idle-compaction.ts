/** Pure admission policy. The adapter owns clocks, timers, host context and quiescence. */
export interface IdleCompactionOptions {
	enabled?: boolean;
	idleMs?: number;
	thresholdPercent?: number;
}

export interface IdleCompactionDeadline {
	readonly generation: number;
	readonly dueAt: number;
}

export interface IdleCompactionCheck {
	now: number;
	percent: number | null | undefined;
	quiescent: boolean;
}

export class IdleCompactionPolicy {
	private readonly enabled: boolean;
	private readonly idleMs: number;
	private readonly thresholdPercent: number;
	private generation = 0;
	private pendingActivity = false;
	private current: IdleCompactionDeadline | undefined;

	constructor(options: IdleCompactionOptions = {}) {
		this.enabled = options.enabled ?? false;
		this.idleMs = options.idleMs ?? 15 * 60 * 1_000;
		this.thresholdPercent = options.thresholdPercent ?? 40;
		if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) throw new RangeError("idleMs must be finite and positive");
		if (!Number.isFinite(this.thresholdPercent) || this.thresholdPercent < 0 || this.thresholdPercent > 100) {
			throw new RangeError("thresholdPercent must be finite and between 0 and 100");
		}
	}

	get deadline(): IdleCompactionDeadline | undefined { return this.current; }

	/** Session/branch changes revoke every outstanding callback; reset never creates idle work. */
	reset(): void {
		this.generation++;
		this.pendingActivity = false;
		this.current = undefined;
	}

	/** Call only for genuine foreground work, never compaction events or UI bookkeeping. */
	activity(): void {
		this.generation++;
		this.pendingActivity = true;
		this.current = undefined;
	}

	/** Repeated settlement and compaction completion cannot create another idle episode. */
	settle(now: number): void {
		if (!this.enabled || !this.pendingActivity || !Number.isFinite(now) || !Number.isFinite(now + this.idleMs)) return;
		this.pendingActivity = false;
		this.current = Object.freeze({ generation: this.generation, dueAt: now + this.idleMs });
	}

	/** Native/manual compaction consumes this episode, including while foreground work settles. */
	compactionStarted(): void {
		this.pendingActivity = false;
		this.current = undefined;
	}

	/** Consume BEFORE launching: failure, cancellation and insufficient reduction never rearm. */
	tryAttempt(deadline: IdleCompactionDeadline, check: IdleCompactionCheck): boolean {
		if (!this.enabled || this.current !== deadline || !Number.isFinite(check.now) || check.now < deadline.dueAt ||
			!check.quiescent || typeof check.percent !== "number" || !Number.isFinite(check.percent) || check.percent <= this.thresholdPercent) return false;
		this.compactionStarted();
		return true;
	}
}

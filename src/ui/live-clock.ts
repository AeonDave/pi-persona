/**
 * A repeating tick that exists only while something is live. Surfaces that show a running clock
 * (the agent widget, the F9 overlay) start it when work appears; it stops itself the first time
 * `isLive()` is false, so an idle session owns no timer. `unref`'d — never keeps the process alive.
 */
export interface LiveClockOptions {
	intervalMs: number;
	isLive: () => boolean;
	onTick: () => void;
}

export class LiveClock {
	private readonly opts: LiveClockOptions;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: LiveClockOptions) {
		this.opts = opts;
	}

	/** Idempotent; a no-op while nothing is live. */
	start(): void {
		if (this.timer || !this.opts.isLive()) return;
		this.timer = setInterval(() => {
			if (!this.opts.isLive()) {
				this.stop();
				return;
			}
			this.opts.onTick();
		}, this.opts.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}
}

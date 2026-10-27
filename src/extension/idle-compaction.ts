/** Opt-in TUI timing only: preparation, summary generation and cancellation remain native Pi. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdleCompactionPolicy, type IdleCompactionDeadline } from "../core/idle-compaction.ts";
import { IDLE_COMPACTION_QUALIFICATION } from "../core/idle-compaction-qualification.ts";

export interface IdleCompactionDeps {
	enabled: boolean;
	idleMs: number;
	thresholdPercent: number;
	/** Persona work, questions and notification queues must all be quiescent. */
	canCompact(): boolean;
	/** Kick idle-gated notification delivery; never start an orchestration here. */
	onReleased(): void;
}

export interface IdleCompactionInstallation {
	readonly busy: boolean;
	/** Session teardown only. The host owns cancellation of its active operation. */
	dispose(): void;
}

interface Admission {
	epoch: number;
	activity: number;
	sessionId: string;
	leafId: string | null;
	awaitingStart: boolean;
	settled: Promise<void>;
	release(): void;
}

/** Install BEFORE Persona's input/orchestration handlers so the barriers cover their execution. */
export function installIdleCompaction(pi: ExtensionAPI, d: IdleCompactionDeps): IdleCompactionInstallation {
	// Release quarantine precedes policy construction, subscriptions and timer allocation.
	if (!IDLE_COMPACTION_QUALIFICATION.qualified || !d.enabled) return { busy: false, dispose() {} };
	const policy = new IdleCompactionPolicy(d);
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let terminalOff: (() => void) | undefined;
	let admission: Admission | undefined;
	let epoch = 0;
	let activity = 0;
	let prompts = 0;
	let disposed = false;
	const subscriptions: Array<() => void> = [];
	const active = () => d.enabled && !disposed && context?.mode === "tui";
	function clearTimer(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}
	function revoke(): void {
		epoch++;
		clearTimer();
		policy.reset();
	}
	function foreground(): void {
		activity++;
		clearTimer();
		policy.activity();
	}
	function eligible(ctx: ExtensionContext): boolean {
		return prompts === 0 && !ctx.hasPendingMessages() && ctx.ui.getEditorText().trim() === "" && d.canCompact();
	}
	function finish(owned: Admission): void {
		if (admission !== owned) return;
		admission = undefined;
		owned.release();
		if (!disposed && epoch === owned.epoch) {
			try { d.onReleased(); } catch { /* notification adapters own their delivery failures */ }
		}
	}
	function arm(): void {
		clearTimer();
		const ctx = context;
		const deadline = policy.deadline;
		if (!active() || !ctx || !deadline || admission) return;
		const capturedEpoch = epoch;
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		timer = setTimeout(() => attempt(ctx, deadline, capturedEpoch, sessionId, leafId), Math.max(0, deadline.dueAt - Date.now()));
		timer.unref?.();
	}
	function attempt(ctx: ExtensionContext, deadline: IdleCompactionDeadline, capturedEpoch: number, sessionId: string, leafId: string | null): void {
		timer = undefined;
		if (!active() || admission || capturedEpoch !== epoch || policy.deadline !== deadline) return;
		try {
			if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) {
				revoke();
				return;
			}
			if (!policy.tryAttempt(deadline, { now: Date.now(), percent: ctx.getContextUsage()?.percent, quiescent: ctx.isIdle() && eligible(ctx) })) {
				// No polling: later settlement or genuine input can reevaluate the pending episode.
				return;
			}
			let release!: () => void;
			const settled = new Promise<void>((resolve) => { release = resolve; });
			const owned: Admission = { epoch, activity, sessionId, leafId, awaitingStart: true, settled, release };
			admission = owned;
			// ONLY this timer starts compaction. No await may separate admission and the native call:
			// Pi's manual entry first awaits abort(), then installs its compaction controller.
			try { ctx.compact({ onComplete: () => finish(owned), onError: () => finish(owned) }); }
			catch { finish(owned); }
		} catch {
			// Stale contexts must never act on the next session or silently rearm themselves.
			revoke();
		}
	}
	async function barrier(): Promise<void> {
		const owned = admission;
		if (owned) await owned.settled;
	}

	subscriptions.push(pi.on("input", async () => {
		if (!active()) return;
		foreground();
		await barrier();
	}));
	subscriptions.push(pi.on("before_agent_start", async () => {
		if (!active()) return;
		await barrier();
		if (!disposed) foreground();
	}));
	subscriptions.push(pi.on("session_start", (_event, ctx) => {
		revoke();
		context = ctx;
		if (active()) terminalOff = ctx.ui.onTerminalInput(() => {
			foreground();
			// Raw input is genuine operator activity. Its new deadline is far beyond this
			// synchronous editor event; submitting a prompt invalidates it again via input.
			policy.settle(Date.now());
			arm();
			return undefined;
		});
	}));
	subscriptions.push(pi.on("agent_settled", () => {
		if (!active()) return;
		policy.settle(Date.now());
		arm();
	}));
	subscriptions.push(pi.on("session_before_compact", (event, ctx) => {
		if (!active()) return;
		clearTimer();
		policy.compactionStarted();
		const owned = admission;
		if (!owned) return;
		if (owned.awaitingStart && event.reason === "manual") {
			owned.awaitingStart = false;
			if (owned.epoch === epoch && owned.activity === activity && ctx.sessionManager.getSessionId() === owned.sessionId &&
				ctx.sessionManager.getLeafId() === owned.leafId && eligible(ctx)) return;
			return { cancel: true };
		}
		// Coordinate overlapping public requests until our callback settles. This veto
		// cannot prevent the native controller race during host cleanup; the release
		// qualification gate, above construction, is the protection on affected hosts.
		if (event.reason === "manual") {
			ctx.ui.notify("Compaction is already in progress or settling; retry /compact after completion.", "info");
		}
		return { cancel: true };
	}));
	subscriptions.push(pi.on("ui_prompt_start", () => { prompts++; clearTimer(); }));
	subscriptions.push(pi.on("ui_prompt_end", () => { prompts = Math.max(0, prompts - 1); arm(); }));
	subscriptions.push(pi.on("session_before_switch", revoke));
	subscriptions.push(pi.on("session_before_fork", revoke));
	subscriptions.push(pi.on("session_before_tree", revoke));
	subscriptions.push(pi.on("session_tree", revoke));
	subscriptions.push(pi.on("model_select", revoke));
	function dispose(): void {
		if (disposed) return;
		disposed = true;
		revoke();
		terminalOff?.();
		terminalOff = undefined;
		context = undefined;
		const owned = admission;
		admission = undefined;
		owned?.release();
		for (const off of subscriptions.splice(0)) off();
	}
	subscriptions.push(pi.on("session_shutdown", dispose));
	return { get busy() { return admission !== undefined; }, dispose };
}

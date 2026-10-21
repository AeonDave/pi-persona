/**
 * `council` and `flow` as ONE tracked run (the same machinery `delegate` uses): a visible strategy or
 * flow is launched into the {@link AsyncRunTracker}, rooted in the agent tree at `async:<runId>`, and
 * reachable through the stop key `async:<runId>`: `intercom stop`, stop all, and `x` on the run's root row
 * in the f9 overlay all end the whole run. Interactive sessions get a receipt at once and ONE completion
 * follow-up (`renderCompletion`); headless sessions join the same run before the tool returns, so the
 * single turn carries the result.
 *
 * Which semaphore gates what:
 *  - `slots` is the launch pool `delegate` already uses (`maxConcurrency`). A council or flow takes ONE
 *    slot for the whole run, exactly like one delegate leg, and shows `queued` until it has it.
 *  - The strategy SDK's own per-run semaphore (`orchestration/sdk.ts`) gates the legs INSIDE the run, so
 *    a council's members never compete with delegate legs for these slots and cannot deadlock on them.
 *    A flow parked at a human checkpoint keeps its slot for the wait: the operator owns that wait, and
 *    stopping the run releases it.
 *  - Token budgets, the child limit and the fork-bomb guard live in that SDK and the engine, untouched.
 */
import { END_TURN_NOTE } from "../core/brief.ts";
import type { ChildUsage } from "../engine/stream.ts";
import { emptyUsage } from "../engine/stream.ts";
import type { AgentResult } from "../orchestration/types.ts";
import type { Semaphore } from "../orchestration/parallel.ts";
import { madeHeadway, type AsyncRun, type AsyncRunTracker, type IdleCoalescingNotifier, type ProgressReading } from "../engine/async.ts";
import type { AgentTree } from "../ui/agent-tree.ts";
import type { ChildUsageLedger } from "../ui/usage.ts";

/** What a visible runner is handed when it works for a tracked run (absent ⇒ it roots and stops itself). */
export interface TrackedRun {
	/** The tree root of this run: `async:<runId>`. Its nodes hang under it. */
	rootId: string;
	/** Fires when the run is stopped — by key, by `intercom stop`, or by the headless tool call's abort. */
	signal: AbortSignal;
	/** Interactive: the launching turn has ended and the supervisor is idle, so a coached leg may block on an
	 *  ask (the run's engines are built `async`). Headless: the call is parked in the turn and could not answer. */
	background: boolean;
	/** One leg progressed: feeds the run's cumulative tokens, and its stall clock when the leg made headway. */
	onProgress(leg: string, progress: ProgressReading): void;
	/** The run is blocked on the operator (a flow checkpoint) — or released again (`undefined`). */
	onAwaiting(label: string | undefined): void;
}

export interface BackgroundRunDeps {
	tracker: AsyncRunTracker;
	agentTree: AgentTree;
	stopRegistry: Map<string, () => void>;
	/** The launch pool shared with `delegate` (see the module comment). */
	slots: Semaphore;
	completionNotifier: Pick<IdleCoalescingNotifier<AsyncRun>, "discard">;
	startPeek(): void;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
}

/** `inline` (headless) skips the status monitor: the launching call joins the run and nobody reads a status card. */
export interface LaunchMeta { kind: "council" | "flow"; label: string; task: string; inline: boolean }

type RunWork = (run: TrackedRun) => Promise<AgentResult>;

/** The receipt an interactive `council`/`flow` launch returns. `wake` finishes "you will be woken ONCE ...". */
export function launchReceipt(kind: LaunchMeta["kind"], id: string, subject: string, wake: string): string {
	return `Launched ${kind} ${id} (${subject}) in the background — you will be woken ONCE ${wake} (${END_TURN_NOTE}).`;
}

export interface BackgroundRuns {
	/** Launch `work` as one tracked run and return its id. */
	launch(meta: LaunchMeta, work: RunWork): string;
	/** Join launched runs (headless): wait for all of them, stop them if `signal` aborts, drop the follow-ups
	 *  this return replaces, and bill their usage once. `onSettled` sees each settle as (done, total). */
	settle(ids: readonly string[], signal: AbortSignal | undefined, onSettled?: (done: number, total: number) => void): Promise<{ runs: AsyncRun[]; usage: ChildUsage }>;
}

export function createBackgroundRuns(d: BackgroundRunDeps): BackgroundRuns {
	function launch(meta: LaunchMeta, work: RunWork): string {
		// `mutates`: a strategy's legs and their tool grants are decided leg by leg inside the run, so the run
		// is classed as a potential writer — the fail-closed answer for a persona's fresh-verification policy
		// (whose refusal says "may mutate", which is all this classification knows).
		const id = d.tracker.launch({ agent: meta.label, task: meta.task, label: meta.label, mutates: true, queued: true }, (onProgress, runId) => {
			const rootId = `async:${runId}`;
			const ac = new AbortController();
			d.stopRegistry.set(rootId, () => ac.abort());
			const legSeen = new Map<string, ProgressReading>();
			const legTokens = new Map<string, number>();
			const snapshot = (output = ""): { output: string; turns: number; tokens: number } => ({ output, turns: 0, tokens: [...legTokens.values()].reduce((a, b) => a + b, 0) });
			const run: TrackedRun = {
				rootId,
				signal: ac.signal,
				background: !meta.inline,
				onProgress: (leg, progress) => {
					// Headway is judged per leg - the run's own snapshot is only their token sum - by the same rule a
					// delegate leg is held to, so one chatty tool in one leg cannot keep the whole run looking alive.
					if (madeHeadway(legSeen.get(leg), progress)) d.tracker.advance(runId);
					legSeen.set(leg, progress);
					legTokens.set(leg, progress.tokens ?? legTokens.get(leg) ?? 0);
					onProgress(snapshot());
				},
				onAwaiting: (label) => {
					d.tracker.setAwaiting(runId, label);
				},
			};
			return d.slots
				.with(async () => {
					d.tracker.markAdmitted(runId);
					const result = await work(run);
					// A ruling or plan that did not complete lives in `result.output`, but a failed or stopped run's
					// report salvages the tracker's `progress.output` — hand it over so that work is not lost.
					if (!result.ok && result.output) onProgress(snapshot(result.output));
					return result;
				}, ac.signal)
				.catch((error: unknown): AgentResult => {
					if (!ac.signal.aborted) throw error;
					return { agent: meta.label, output: "", usage: emptyUsage(), ok: false, error: "run aborted", failureKind: "abort" };
				});
		});
		// Visible while queued, so `x` and the tree's stop work before the pool grants a slot; the visible runner
		// upserts this same row when it starts.
		d.agentTree.add({ id: `async:${id}`, label: meta.label, kind: meta.kind, status: "running", detail: "queued" });
		if (!meta.inline) d.startPeek();
		return id;
	}

	async function settle(ids: readonly string[], signal: AbortSignal | undefined, onSettled?: (done: number, total: number) => void): Promise<{ runs: AsyncRun[]; usage: ChildUsage }> {
		const runs = ids.flatMap((id) => d.tracker.peek(id) ?? []); // launch() registers each, and a running entry is never evicted
		const stopAll = (): void => {
			for (const id of ids) d.stopRegistry.get(`async:${id}`)?.();
		};
		if (signal?.aborted) stopAll();
		else signal?.addEventListener("abort", stopAll, { once: true });
		try {
			if (runs.some((run) => !run.settled)) {
				await new Promise<void>((resolve) => {
					const off = d.tracker.onComplete(() => {
						const done = runs.filter((run) => run.settled).length;
						onSettled?.(done, runs.length);
						if (done === runs.length) {
							off();
							resolve();
						}
					});
				});
			}
		} finally {
			signal?.removeEventListener("abort", stopAll);
		}
		d.completionNotifier.discard((pending) => ids.includes(pending.id)); // this return IS the delivery
		const usage = d.childUsage.accountMany(runs.map((run) => ({ key: run.id, usage: run.result?.usage ?? emptyUsage() })));
		d.publishPersonaCost();
		return { runs, usage };
	}

	return { launch, settle };
}

/**
 * The `delegate` tool's core logic — pure, engine-injected, testable. Maps params
 * to engine runs (single + bounded parallel), formats the result, and emits live
 * per-task "views" (running → done/failed) so the UI can show each sub-agent as
 * it runs. Capability gating happens upstream in the `tool_call` hook.
 */

import { type ChildUsage, emptyUsage } from "../engine/stream.ts";
import { mapWithConcurrency } from "../orchestration/parallel.ts";
import { aggregateResults } from "../orchestration/reducers.ts";
import type { StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";

export interface DelegateTask {
	agent: string;
	task: string;
}

export interface DelegateParams {
	agent?: string;
	task?: string;
	tasks?: DelegateTask[];
	concurrency?: number;
}

/** A live per-sub-agent view for the UI (running → done/failed). */
export interface DelegateView {
	agent: string;
	running: boolean;
	ok: boolean;
	output: string;
	usage: ChildUsage;
}

export interface DelegateOutcome {
	text: string;
	results: AgentResult[];
	views: DelegateView[];
	ok: boolean;
}

function viewOf(agent: string, r: AgentResult): DelegateView {
	return {
		agent,
		running: false,
		ok: r.ok,
		output: r.ok ? r.output || "(no output)" : r.error ?? "(failed)",
		usage: r.usage,
	};
}

export async function runDelegate(
	params: DelegateParams,
	engine: StrategyEngine,
	concurrencyDefault = 4,
	onProgress?: (views: DelegateView[]) => void,
): Promise<DelegateOutcome> {
	if (params.tasks && params.tasks.length > 0) {
		const tasks = params.tasks;
		const views: DelegateView[] = tasks.map((t) => ({
			agent: t.agent,
			running: true,
			ok: false,
			output: "",
			usage: emptyUsage(),
		}));
		onProgress?.(views.map((v) => ({ ...v })));

		const results = await mapWithConcurrency(tasks, params.concurrency ?? concurrencyDefault, async (t, i) => {
			const r = await engine.run({ agent: t.agent, task: t.task });
			views[i] = viewOf(t.agent, r);
			onProgress?.(views.map((v) => ({ ...v })));
			return r;
		});
		const agg = aggregateResults(results);
		return { text: agg.output, results, views, ok: agg.ok };
	}

	if (params.agent && params.task) {
		const r = await engine.run({ agent: params.agent, task: params.task });
		const text = r.ok ? r.output || "(no output)" : `Agent "${params.agent}" failed: ${r.error ?? "(no detail)"}`;
		return { text, results: [r], views: [viewOf(params.agent, r)], ok: r.ok };
	}

	return { text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }", results: [], views: [], ok: false };
}

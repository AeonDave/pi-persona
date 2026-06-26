/**
 * The `delegate` tool's core logic — pure, engine-injected, testable. Maps params
 * to engine runs (single + bounded parallel), formats the result, and emits live
 * per-task "views" (running → done/failed) so the UI can show each sub-agent as
 * it runs. A task may carry `skills`/`model`/`tools` to spawn a *dynamic* sub-agent
 * (e.g. the generic `operator` specialised by the skills it loads). Capability
 * gating happens upstream in the `tool_call` hook.
 */

import { type ChildUsage, emptyUsage } from "../engine/stream.ts";
import { mapWithConcurrency } from "../orchestration/parallel.ts";
import { aggregateResults } from "../orchestration/reducers.ts";
import type { AgentRunSpec, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";

export interface DelegateTask {
	agent: string;
	task: string;
	/** Skills the sub-agent must load first (dynamic specialisation). */
	skills?: string[];
	/** Model override for this sub-agent. */
	model?: string;
	/** Tool allowlist override for this sub-agent. */
	tools?: string[];
}

export interface DelegateParams {
	agent?: string;
	task?: string;
	skills?: string[];
	model?: string;
	tools?: string[];
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

function specOf(t: DelegateTask): AgentRunSpec {
	const spec: AgentRunSpec = { agent: t.agent, task: t.task };
	if (t.skills && t.skills.length > 0) spec.skills = t.skills;
	if (t.model) spec.model = t.model;
	if (t.tools && t.tools.length > 0) spec.tools = t.tools;
	return spec;
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
			const r = await engine.run(specOf(t));
			views[i] = viewOf(t.agent, r);
			onProgress?.(views.map((v) => ({ ...v })));
			return r;
		});
		const agg = aggregateResults(results);
		return { text: agg.output, results, views, ok: agg.ok };
	}

	if (params.agent && params.task) {
		const single: DelegateTask = { agent: params.agent, task: params.task };
		if (params.skills && params.skills.length > 0) single.skills = params.skills;
		if (params.model) single.model = params.model;
		if (params.tools && params.tools.length > 0) single.tools = params.tools;
		const r = await engine.run(specOf(single));
		const text = r.ok ? r.output || "(no output)" : `Agent "${params.agent}" failed: ${r.error ?? "(no detail)"}`;
		return { text, results: [r], views: [viewOf(params.agent, r)], ok: r.ok };
	}

	return { text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }", results: [], views: [], ok: false };
}

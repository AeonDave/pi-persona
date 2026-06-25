/**
 * The `delegate` tool's core logic — pure, engine-injected, testable. The
 * TypeBox schema + `registerTool` wrapper live in the extension wiring; this is
 * the part that maps params to engine runs (single + bounded parallel) and
 * formats the result. Capability gating happens upstream in the `tool_call` hook.
 */

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

export interface DelegateOutcome {
	text: string;
	results: AgentResult[];
	ok: boolean;
}

export async function runDelegate(
	params: DelegateParams,
	engine: StrategyEngine,
	concurrencyDefault = 4,
): Promise<DelegateOutcome> {
	if (params.tasks && params.tasks.length > 0) {
		const results = await mapWithConcurrency(params.tasks, params.concurrency ?? concurrencyDefault, (t) =>
			engine.run({ agent: t.agent, task: t.task }),
		);
		const agg = aggregateResults(results);
		return { text: agg.output, results, ok: agg.ok };
	}

	if (params.agent && params.task) {
		const r = await engine.run({ agent: params.agent, task: params.task });
		const text = r.ok ? r.output || "(no output)" : `Agent "${params.agent}" failed: ${r.error ?? "(no detail)"}`;
		return { text, results: [r], ok: r.ok };
	}

	return { text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }", results: [], ok: false };
}

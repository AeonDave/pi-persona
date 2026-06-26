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
	/** A friendly display name (the loader's choice), to tell sub-agents apart. */
	name?: string;
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
	name?: string;
	skills?: string[];
	model?: string;
	tools?: string[];
	tasks?: DelegateTask[];
	concurrency?: number;
}

/** A live per-sub-agent view for the UI (running → done/failed). */
export interface DelegateView {
	agent: string;
	/** Display label: `name · model` (e.g. "pippo · sonnet-4-6"). */
	label: string;
	running: boolean;
	ok: boolean;
	output: string;
	usage: ChildUsage;
}

// Fun, stable codenames for an unnamed generic `operator` so several are tellable apart.
const CODENAMES = [
	"pippo", "nova", "echo", "zara", "kilo", "mango", "ivy", "oslo",
	"rune", "fenix", "juno", "wasp", "lyra", "pongo", "gizmo", "tofu",
];

/** Short model name for display: drop provider + `claude-` + any `:thinking`. */
export function shortModel(ref: string | undefined): string {
	if (!ref) return "";
	const base = ref.split(":")[0]?.split("/").pop() ?? ref;
	return base.replace(/^claude-/, "");
}

/** Display label for a sub-agent: the loader's name (or a codename for a generic
 *  operator, else the agent's own name) plus its short model. */
export function labelFor(t: { agent: string; name?: string; model?: string }, index: number): string {
	const name = t.name?.trim() || (t.agent === "operator" ? (CODENAMES[index % CODENAMES.length] as string) : t.agent);
	const m = shortModel(t.model);
	return m ? `${name} · ${m}` : name;
}

export interface DelegateOutcome {
	text: string;
	results: AgentResult[];
	views: DelegateView[];
	ok: boolean;
}

/** Hard ceilings the engine enforces regardless of what the LLM asks for. */
export interface DelegateLimits {
	maxConcurrency: number;
	maxChildren: number;
}

function specOf(t: DelegateTask): AgentRunSpec {
	const spec: AgentRunSpec = { agent: t.agent, task: t.task };
	if (t.skills && t.skills.length > 0) spec.skills = t.skills;
	if (t.model) spec.model = t.model;
	if (t.tools && t.tools.length > 0) spec.tools = t.tools;
	return spec;
}

function viewOf(agent: string, label: string, r: AgentResult): DelegateView {
	return {
		agent,
		label,
		running: false,
		ok: r.ok,
		output: r.ok ? r.output || "(no output)" : r.error ?? "(failed)",
		usage: r.usage,
	};
}

export async function runDelegate(
	params: DelegateParams,
	engine: StrategyEngine,
	limits: DelegateLimits = { maxConcurrency: 4, maxChildren: 8 },
	onProgress?: (views: DelegateView[]) => void,
	onLegStart?: (index: number, abort: () => void) => void,
): Promise<DelegateOutcome> {
	if (params.tasks && params.tasks.length > 0) {
		// Enforce the hard ceilings: cap the fan-out and clamp the concurrency the
		// LLM requested — a strategy/tool call cannot exceed the declared limits.
		const tasks = params.tasks.slice(0, limits.maxChildren);
		const dropped = params.tasks.length - tasks.length;
		const concurrency = Math.min(Math.max(1, params.concurrency ?? limits.maxConcurrency), limits.maxConcurrency);
		const labels = tasks.map((t, i) => labelFor(t, i));
		const views: DelegateView[] = tasks.map((t, i) => ({
			agent: t.agent,
			label: labels[i] as string,
			running: true,
			ok: false,
			output: "",
			usage: emptyUsage(),
		}));
		onProgress?.(views.map((v) => ({ ...v })));

		const results = await mapWithConcurrency(tasks, concurrency, async (t, i) => {
			const ac = new AbortController();
			onLegStart?.(i, () => ac.abort());
			const r = await engine.run(
				specOf(t),
				(p) => {
					// Stream the leg's rolling output so the overlay shows it live.
					if (p.output) views[i] = { ...(views[i] as DelegateView), output: p.output };
					onProgress?.(views.map((v) => ({ ...v })));
				},
				ac.signal,
			);
			views[i] = viewOf(t.agent, labels[i] as string, r);
			onProgress?.(views.map((v) => ({ ...v })));
			return r;
		});
		const agg = aggregateResults(results);
		const text =
			dropped > 0
				? `${agg.output}\n\n[pi-persona] ${dropped} task(s) beyond the max-children limit (${limits.maxChildren}) were dropped.`
				: agg.output;
		return { text, results, views, ok: agg.ok };
	}

	if (params.agent && params.task) {
		const single: DelegateTask = { agent: params.agent, task: params.task };
		if (params.name) single.name = params.name;
		if (params.skills && params.skills.length > 0) single.skills = params.skills;
		if (params.model) single.model = params.model;
		if (params.tools && params.tools.length > 0) single.tools = params.tools;
		const label = labelFor(single, 0);
		const view: DelegateView = { agent: params.agent, label, running: true, ok: false, output: "", usage: emptyUsage() };
		onProgress?.([{ ...view }]);
		const ac = new AbortController();
		onLegStart?.(0, () => ac.abort());
		const r = await engine.run(
			specOf(single),
			(p) => {
				if (p.output) view.output = p.output;
				onProgress?.([{ ...view }]);
			},
			ac.signal,
		);
		const text = r.ok ? r.output || "(no output)" : `Agent "${params.agent}" failed: ${r.error ?? "(no detail)"}`;
		return { text, results: [r], views: [viewOf(params.agent, label, r)], ok: r.ok };
	}

	return { text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }", results: [], views: [], ok: false };
}

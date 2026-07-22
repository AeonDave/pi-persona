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
import { type AgentRunSpec, isPositiveFiniteMs, type SteerFn, type StrategyEngine } from "../orchestration/sdk.ts";
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
	/** Extra system-prompt text: an ON-THE-FLY specialist persona, appended to the
	 *  agent's own prompt (prompt-level only — capabilities are still the gate). */
	role?: string;
	/** Run this task in an isolated git worktree (edits never touch the main tree). */
	isolation?: "none" | "worktree";
	/** Route this task through the child engine so the sub-agent's MCP (`mcp*`/direct)
	 *  tools initialize and work (the in-process engine leaves them "not initialized"). */
	mcp?: boolean;
	/** Per-leg override (ms) of the shared idle-timeout ceiling — lets ONE legitimately slow
	 *  leg raise its own wall-clock budget without raising the default for its siblings. Ignored
	 *  unless a finite, positive number (junk/≤0 falls back to the engine's default). */
	timeoutMs?: number;
}

export interface DelegateParams {
	agent?: string;
	task?: string;
	name?: string;
	skills?: string[];
	model?: string;
	tools?: string[];
	role?: string;
	isolation?: "none" | "worktree";
	mcp?: boolean;
	/** Per-leg override (ms) of the shared idle-timeout ceiling (single mode). Ignored unless a
	 *  finite, positive number (junk/≤0 falls back to the engine's default). */
	timeoutMs?: number;
	tasks?: DelegateTask[];
	concurrency?: number;
}

/** A live per-sub-agent view for the UI (running → done/failed). */
export interface DelegateView {
	agent: string;
	/** Display label: `name · model` (e.g. "orion-recon · sonnet-4-6"). */
	label: string;
	running: boolean;
	ok: boolean;
	/** Terminal failure classification; `abort` projects as stopped rather than failed in the UI. */
	failureKind?: AgentResult["failureKind"];
	output: string;
	/** The tool the leg is currently running (e.g. "grep src/…"), "" if none. */
	activity: string;
	usage: ChildUsage;
}

// Fallback call-signs for an unnamed generic `operator`, so several legs are still tellable apart when
// the supervisor doesn't name them itself. When it does — the `<call-sign>-<purpose>` convention, e.g.
// "orion-recon" — that name wins over these.
export const CODENAMES = [
	"orion", "hermes", "atlas", "nova", "echo", "vega", "juno", "lyra",
	"rune", "fenix", "zara", "oslo", "iris", "titan", "onyx", "cobra",
];

/** Short model name for display: drop provider + `claude-` + any `:thinking`. */
export function shortModel(ref: string | undefined): string {
	if (!ref) return "";
	const base = ref.split(":")[0]?.split("/").pop() ?? ref;
	return base.replace(/^claude-/, "");
}

/** The bare display NAME for a sub-agent (no model suffix): the loader's name, or a codename
 *  for a generic operator, else the agent's own name. Exported so a caller that folds in the
 *  model itself (e.g. the async tree node, `AsyncRun.label`) doesn't have to strip it back out
 *  of {@link labelFor}'s composite string. */
export function nameFor(t: { agent: string; name?: string }, index: number): string {
	return t.name?.trim() || (t.agent === "operator" ? (CODENAMES[index % CODENAMES.length] as string) : t.agent);
}

/** Display label for a sub-agent: its bare {@link nameFor} name plus its short model. */
export function labelFor(t: { agent: string; name?: string; model?: string }, index: number): string {
	const name = nameFor(t, index);
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

/** Map a task to the run-spec fields the engine accepts — the single source of truth for the
 *  delegate path's field mapping. Exported so the async launch path (extension.ts) routes
 *  through the SAME mapping instead of duplicating it (a duplicated copy is how NP2's
 *  `timeoutMs` could silently miss the async fan-out, which is the interactive default). */
export function specOf(t: DelegateTask): AgentRunSpec {
	const spec: AgentRunSpec = { agent: t.agent, task: t.task };
	if (t.skills && t.skills.length > 0) spec.skills = t.skills;
	if (t.model) spec.model = t.model;
	if (t.tools && t.tools.length > 0) spec.tools = t.tools;
	if (t.role?.trim()) spec.role = t.role.trim();
	if (t.isolation !== undefined) spec.isolation = t.isolation;
	if (t.mcp !== undefined) spec.mcp = t.mcp;
	if (isPositiveFiniteMs(t.timeoutMs)) spec.timeoutMs = t.timeoutMs;
	return spec;
}

/**
 * Anti-loop ledger — the RUNTIME guard behind "do not re-issue the same failing
 * delegation" (never prompt-only, per the capability guardrails). Tracks consecutive
 * failures per (agent, model, task): after {@link MAX_IDENTICAL_FAILURES} identical
 * failures the delegation is vetoed before anything spawns, so a supervisor that
 * ignores the guidance physically cannot burn tokens on the same dead end. Changing
 * the model or the task is a NEW key — "retry once with a different model" stays open.
 */
export const MAX_IDENTICAL_FAILURES = 2;

/** The fields a delegation is keyed on — always `agent+model+task`; `role`/`tools`/`isolation`
 *  additionally fold into the key when {@link DelegationLedger}'s `ledgerV2` is on. */
export interface DelegationKeyInput {
	agent: string;
	model?: string;
	task: string;
	role?: string;
	tools?: string[];
	isolation?: string;
}

export class DelegationLedger {
	private readonly failures = new Map<string, number>();
	private readonly maxKeys = 200;
	private readonly ledgerV2: boolean;

	/** `ledgerV2` (PI_PERSONA_LEDGER_V2, default false) widens the veto key — see {@link key}. */
	constructor(opts?: { ledgerV2?: boolean }) {
		this.ledgerV2 = opts?.ledgerV2 ?? false;
	}

	/** OFF (default): EXACTLY today's `agent+model+task` key — the observable veto *behavior*
	 *  is preserved (record and vet always route through this SAME function, so whatever
	 *  separator is in play cancels out on both sides), though the key *bytes* did change
	 *  (NUL → space → `\x1f` across this batch). ON: additionally folds in `role` + a
	 *  stable-sorted `tools` join + `isolation`, so a genuine retry that changes only one of
	 *  those isn't falsely vetoed as "identical". `role` is trimmed and `isolation` is
	 *  collapsed to just "worktree" vs. everything else — normalized HERE, not by the caller
	 *  — so a record() fed a normalized spec (e.g. the async fan-out, post-`specOf()`) and a
	 *  vet() fed raw params (e.g. `isolation: "none"`, an untrimmed `role`) key IDENTICALLY;
	 *  otherwise the 2-strike veto could silently never fire for that class of retry. */
	private key(t: DelegationKeyInput): string {
		const SEP = "\x1f"; // collision-proof (no field can contain it) without making git see the file as binary (NUL did)
		const base = `${t.agent}${SEP}${t.model ?? ""}${SEP}${t.task}`;
		if (!this.ledgerV2) return base;
		const role = t.role?.trim() ?? "";
		const toolsKey = t.tools && t.tools.length > 0 ? [...t.tools].sort().join(",") : "";
		const isolation = t.isolation === "worktree" ? "worktree" : "";
		return `${base}${SEP}${role}${SEP}${toolsKey}${SEP}${isolation}`;
	}

	/** Record a settled delegation; success clears the key (it may be retried again later). */
	record(t: DelegationKeyInput, ok: boolean): void {
		const k = this.key(t);
		if (ok) {
			this.failures.delete(k);
			return;
		}
		this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
		// Bounded: evict the oldest key (Map preserves insertion order).
		if (this.failures.size > this.maxKeys) {
			const oldest = this.failures.keys().next().value;
			if (oldest !== undefined) this.failures.delete(oldest);
		}
	}

	/** A veto message when any task already failed identically MAX times, else undefined. */
	vet(tasks: DelegationKeyInput[]): string | undefined {
		const blocked = tasks.filter((t) => (this.failures.get(this.key(t)) ?? 0) >= MAX_IDENTICAL_FAILURES);
		if (blocked.length === 0) return undefined;
		const who = blocked.map((t) => `"${t.agent}"${t.model ? ` (${t.model})` : ""}`).join(", ");
		return (
			`delegate: this exact delegation to ${who} already failed ${MAX_IDENTICAL_FAILURES}× — nothing was spawned. ` +
			"Change the approach: a different model, a reworded/smaller task, another agent — or report the blocker to the user."
		);
	}
}

/**
 * Pre-spawn agent validation for the `delegate` tool — mirrors the model-name path
 * (extension.ts's `resolveDelegateModels`): a wrong agent name must return a SELF-CORRECTING
 * error naming the installed agents BEFORE anything spawns, instead of the engine's late bare
 * failure. Nothing spawns ⇒ nothing is recorded, so a typo never counts toward the
 * {@link DelegationLedger} veto. Empty registry ⇒ the fresh-install guidance (opt-in seeding
 * means a new install has zero agents while the tool is already advertised).
 */
export function unknownAgentError(requested: string[], installed: string[]): string | undefined {
	const unknown = [...new Set(requested.filter((n) => !installed.includes(n)))];
	if (unknown.length === 0) return undefined;
	const who = unknown.map((n) => `"${n}"`).join(", ");
	if (installed.length === 0) {
		return (
			`delegate: no sub-agents are installed, so ${who} cannot run — nothing was spawned. ` +
			"Ask the user to run `/persona seed` once (it installs the bundled agents), or add agent files under `.pi/agents/`."
		);
	}
	const list = installed.slice(0, 16).join(", ");
	return (
		`delegate: unknown agent(s) ${who} — nothing was spawned. Installed agents: ${list}${installed.length > 16 ? ", …" : ""}. ` +
		"Pick one of those, or shape `operator` on the fly with `role` + `skills`."
	);
}

/**
 * Should this `delegate` call run in the BACKGROUND (async)? An explicit `async` always wins;
 * otherwise an interactive session (`hasUI`) defaults to background — the supervisor stays free and
 * results return as follow-ups — unless the call opts out with `sync: true`. A headless run (no UI,
 * e.g. `pi -p`) defaults to SYNC: the single turn must carry the result, and nothing drains a
 * follow-up after the process exits. `renderCall` passes `hasUI: true` (it only ever fires in a UI),
 * so the async tag it shows tracks the exact same default the execute path takes.
 */
export function wantsAsyncRun(params: { async?: boolean; sync?: boolean }, hasUI: boolean): boolean {
	return params.async ?? (hasUI && params.sync !== true);
}

function viewOf(agent: string, label: string, r: AgentResult): DelegateView {
	return {
		agent,
		label,
		running: false,
		ok: r.ok,
		...(r.failureKind !== undefined ? { failureKind: r.failureKind } : {}),
		output: r.ok ? r.output || "(no output)" : r.error ?? "(failed)",
		activity: "",
		usage: r.usage,
	};
}

export async function runDelegate(
	params: DelegateParams,
	engine: StrategyEngine,
	limits: DelegateLimits = { maxConcurrency: 4, maxChildren: 8 },
	onProgress?: (views: DelegateView[]) => void,
	onLegStart?: (index: number, abort: () => void) => void,
	onLegSteerable?: (index: number, steer: SteerFn) => void,
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
			activity: "",
			usage: emptyUsage(),
		}));
		onProgress?.(views.map((v) => ({ ...v })));

		const results = await mapWithConcurrency(tasks, concurrency, async (t, i) => {
			const ac = new AbortController();
			onLegStart?.(i, () => ac.abort());
			const r = await engine.run(
				specOf(t),
				(p) => {
					// Stream the leg's rolling output + current tool activity.
					const cur = views[i] as DelegateView;
					views[i] = { ...cur, output: p.output || cur.output, activity: p.activity ?? "" };
					onProgress?.(views.map((v) => ({ ...v })));
				},
				ac.signal,
				(steer) => onLegSteerable?.(i, steer),
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
		if (params.role?.trim()) single.role = params.role.trim();
		if (params.isolation !== undefined) single.isolation = params.isolation;
		if (params.mcp !== undefined) single.mcp = params.mcp;
		if (params.timeoutMs !== undefined) single.timeoutMs = params.timeoutMs;
		const label = labelFor(single, 0);
		const view: DelegateView = {
			agent: params.agent,
			label,
			running: true,
			ok: false,
			output: "",
			activity: "",
			usage: emptyUsage(),
		};
		onProgress?.([{ ...view }]);
		const ac = new AbortController();
		onLegStart?.(0, () => ac.abort());
		const r = await engine.run(
			specOf(single),
			(p) => {
				if (p.output) view.output = p.output;
				view.activity = p.activity ?? "";
				onProgress?.([{ ...view }]);
			},
			ac.signal,
			(steer) => onLegSteerable?.(0, steer),
		);
		const text = r.ok ? r.output || "(no output)" : `Agent "${params.agent}" failed: ${r.error ?? "(no detail)"}`;
		return { text, results: [r], views: [viewOf(params.agent, label, r)], ok: r.ok };
	}

	return { text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }", results: [], views: [], ok: false };
}

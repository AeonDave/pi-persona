/** `delegate` tool registration. */
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/agent.ts";
import { Type } from "typebox";
import { END_TURN_NOTE } from "../core/brief.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { configuredModels } from "../extension/engine.ts";
import { compactInlineText, MAX_COLLAPSED_CARD_COLUMNS, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { resolveModelRef } from "../core/models.ts";
import { inventedLegNameHint } from "../core/naming.ts";
import { toolUsageField } from "../ui/usage.ts";
import { expandDetailHint, failureDetails, isInline } from "../extension/shared.ts";
import {
	DelegationLedger, type DelegateParams as DelegateCall, keyInputOf, nameFor, normalizeDelegateConcurrency,
	shortModel, shouldRecordDelegationOutcome, specOf, unknownAgentError, unknownContractError,
	validateDelegationBrief, validateParallelWriteSets, coerceDelegateParams,
} from "./delegate.ts";
import { Semaphore } from "../orchestration/parallel.ts";
import type { AgentRunSpec, SteerFn, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { sanitizeLabel } from "../extension/shared.ts";
import type { PersonaController } from "../persona/controller.ts";
import type { AgentTree } from "../ui/agent-tree.ts";
import { buildCompletionReport, runDisplayName, type AsyncRunTracker } from "../engine/async.ts";
import type { BackgroundRuns } from "./background-run.ts";
import { emptyUsage, type ProgressSnapshot, type ToolEvent } from "../engine/stream.ts";
import { progressPatch } from "../ui/agent-tree.ts";
import type { RunLimits } from "../core/capabilities.ts";

interface DelegateLaunchSnapshot {
	id: string;
	label: string;
	agent: string;
	model?: string;
}

interface DelegateLaunchRow {
	id: string;
	fullName: string;
	displayName: string;
	clipped: boolean;
	hasAlias: boolean;
}

const COLLAPSED_LAUNCH_ROWS = 3;

/** Prefer session-persisted identity, then recover old launch cards from the live tracker. */
function launchRows(
	details: { runId?: unknown; runIds?: unknown; runs?: unknown },
	tracker: AsyncRunTracker,
	allowTracker: boolean,
): DelegateLaunchRow[] {
	const persisted = new Map<string, DelegateLaunchSnapshot>();
	if (Array.isArray(details.runs)) {
		for (const item of details.runs) {
			if (!item || typeof item !== "object") continue;
			const run = item as Record<string, unknown>;
			if (typeof run.id !== "string" || typeof run.label !== "string" || typeof run.agent !== "string") continue;
			persisted.set(run.id, {
				id: run.id,
				label: run.label,
				agent: run.agent,
				...(typeof run.model === "string" ? { model: run.model } : {}),
			});
		}
	}
	const storedIds = Array.isArray(details.runIds)
		? details.runIds.filter((id): id is string => typeof id === "string")
		: typeof details.runId === "string" ? [details.runId] : [];
	const ids = [...storedIds];
	const seenIds = new Set(ids);
	for (const id of persisted.keys()) {
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		ids.push(id);
	}
	const entries = ids.map((id): { run: DelegateLaunchSnapshot; hasAlias: boolean } => {
		const saved = persisted.get(id);
		if (saved) return { run: saved, hasAlias: true };
		const tracked = allowTracker ? tracker.peek(id) : undefined;
		if (tracked) {
			return {
				run: {
					id,
					label: tracked.label ?? tracked.agent,
					agent: tracked.agent,
					...(tracked.model ? { model: tracked.model } : {}),
				},
				hasAlias: true,
			};
		}
		// Older history may outlive both its launch snapshot and tracker entry. Retain the
		// routing id as an explicitly diagnostic fallback so the batch count stays complete.
		return { run: { id, label: id, agent: id }, hasAlias: false };
	});
	const named = entries.map(({ run, hasAlias }) => ({
		id: compactInlineText(run.id, { maxChars: 64 }) || "run",
		fullName: runDisplayName(run),
		hasAlias,
	}));
	const counts = new Map<string, number>();
	for (const row of named) counts.set(row.fullName, (counts.get(row.fullName) ?? 0) + 1);
	return named.map((row) => {
		const displayName = counts.get(row.fullName)! > 1
			? `${compactInlineText(row.fullName, { maxChars: 56 })} [${compactInlineText(row.id, { maxChars: 16 })}]`
			: row.fullName;
		return {
			...row,
			displayName,
			clipped: compactInlineText(displayName, { maxChars: 80 }) !== displayName,
		};
	});
}

function collapsedLaunchSummary(rows: readonly DelegateLaunchRow[], dropped: number | undefined): string {
	const prefix = "delegate launched ";
	const dropNote = dropped && dropped > 0 ? ` · ${dropped} task${dropped === 1 ? "" : "s"} dropped` : "";
	const maxVisible = Math.min(rows.length, COLLAPSED_LAUNCH_ROWS);
	for (let count = maxVisible; count >= 1; count--) {
		const names = rows.slice(0, count).map((row) => row.displayName);
		const omitted = rows.length - names.length;
		const suffix = omitted > 0 ? `, +${omitted} more` : "";
		const body = `${prefix}${names.join(", ")}${suffix}${dropNote}`;
		const needsHint = omitted > 0 || rows.slice(0, count).some((row) => row.clipped) || body.length > MAX_COLLAPSED_CARD_COLUMNS || visibleWidth(body) > MAX_COLLAPSED_CARD_COLUMNS;
		const candidate = `${body}${needsHint ? ` · ${expandDetailHint()}` : ""}`;
		if (candidate.length <= MAX_COLLAPSED_CARD_COLUMNS && visibleWidth(candidate) <= MAX_COLLAPSED_CARD_COLUMNS) return candidate;
	}
	const omitted = rows.length - 1;
	const suffix = omitted > 0 ? `, +${omitted} more` : "";
	const hint = ` · ${expandDetailHint()}`;
	const fixed = `${prefix}${suffix}${dropNote}${hint}`;
	const aliasLimit = Math.max(16, Math.min(MAX_COLLAPSED_CARD_COLUMNS - visibleWidth(fixed), MAX_COLLAPSED_CARD_COLUMNS - fixed.length));
	const first = compactInlineText(rows[0]!.displayName, { maxChars: aliasLimit });
	return compactInlineText(`${prefix}${first}${suffix}${dropNote}${hint}`, { maxChars: MAX_COLLAPSED_CARD_COLUMNS });
}

function expandedLaunchDetails(text: string, rows: readonly DelegateLaunchRow[]): string {
	if (rows.length === 0 || !rows.some((row) => row.hasAlias)) return text;
	const diagnostics = rows.map((row) => `- ${row.fullName} [${row.id}]`).join("\n");
	return `${text}\n\nLaunched workers:\n${diagnostics}`;
}

export interface DelegateToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	controller: PersonaController;
	agents: AgentConfig[];
	contractNames: () => string[];
	buildEngine: (signal?: AbortSignal, onProgress?: (s: ProgressSnapshot) => void, opts?: { async?: boolean }) => StrategyEngine;
	agentTree: AgentTree;
	tracker: AsyncRunTracker;
	/** Headless: joins the runs a call launched (see background-run.ts). */
	runs: BackgroundRuns;
	/** The launch pool, shared with the background `council` and `flow` runs (absent ⇒ a private one). */
	launchPool?: Semaphore;
	config: { ledgerV2: boolean };
	RUN_LIMITS: RunLimits;
	publishAgentTool(agentId: string, event: ToolEvent): void;
	stopRegistry: Map<string, () => void>;
	steerRegistry: Map<string, SteerFn>;
	drainBusBlock(): string;
	startPeek(): void;
}

export function registerDelegateTool(pi: ExtensionAPI, d: DelegateToolDeps): void {
	// ── delegate tool (opportunistic L0) ────────────────────────────────────────
	const JsonString = Type.String({
		description: "JSON text of the same value — accepted when a client stringifies nested args",
	});
	const SkillsSchema = Type.Array(Type.String(), {
		description: "Skills the sub-agent loads first — spawns a dynamic specialist (skills are inherited from the host)",
	});
	const RoleSchema = Type.String({
		description:
			"On-the-fly specialist persona: extra system-prompt text appended to the agent's own (e.g. 'You are a Rust unsafe-code auditor…') — combine with `skills` to shape a dynamic sub-agent without authoring a file",
	});
	const LeaderNameDescription = `${inventedLegNameHint()} As the supervisor, assign and pass this name before launch so the worker sees it from its first turn; omission remains valid and uses the configured agent's generic fallback.`;
	const BriefListSchema = Type.Union([Type.String(), Type.Array(Type.String())]);
	const DelegationBriefSchema = Type.Object({
		objective: Type.String({ description: "Verifiable objective and success signal" }),
		scopeRoe: Type.String({ description: "In-scope targets plus hard scope/authorization boundaries" }),
		position: Type.String({ description: "Minimum starting state, foothold, credentials, or assumptions the worker may rely on" }),
		constraints: BriefListSchema,
		requiredArtifacts: BriefListSchema,
		stopConditions: BriefListSchema,
	});
	const WriteSetSchema = Type.Array(Type.String(), {
		description: "Repository-relative files/directories this leg alone may modify; parallel overlaps are rejected",
	});
	const DelegateTaskItem = Type.Object({
		agent: Type.String({ description: 'Agent to run — use "operator" for a dynamic, skill-driven executor' }),
		task: Type.String({ description: "Self-contained packet: objective, scope, allowed tools, success signal, non-goals" }),
		brief: Type.Optional(Type.Union([DelegationBriefSchema, JsonString], {
			description: "This worker's structured brief. Required when the active persona has requireBrief, including read-only scouts. Supply all six fields here in each tasks[] entry; task prose and a top-level brief do not replace it.",
		})),
		name: Type.Optional(
			Type.String({ description: LeaderNameDescription }),
		),
		skills: Type.Optional(Type.Union([SkillsSchema, JsonString])),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(
			Type.String({ description: "Model override (exact provider/id — call the `models` tool to find one)" }),
		),
		tools: Type.Optional(Type.Union([Type.Array(Type.String(), { description: "Tool allowlist override for this sub-agent; [] explicitly grants no tools" }), JsonString])),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run in an isolated git worktree (edits never touch the main tree)" }),
		),
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give this sub-agent working MCP tools (runs it on the child engine so pi-mcp-adapter initializes; the default engine leaves MCP tools 'not initialized'). Pass any server session id in the task to share a server-keyed backend's state." }),
		),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Idle window in ms for this worker, reset by any progress. NOT a deadline: a worker that keeps progressing runs past it. A positive value overrides the shared default; zero or negative uses the default." }),
		),
		writeSet: Type.Optional(Type.Union([WriteSetSchema, JsonString])),
		outputContract: Type.Optional(Type.String({ description: "Name of an installed output contract (see /doctor; built-in: default). Omit for free-form output — describe the report shape in requiredArtifacts instead." })),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		brief: Type.Optional(Type.Union([DelegationBriefSchema, JsonString], {
			description: "Single-mode structured brief. Required when the active persona has requireBrief. For parallel mode, provide a separate complete brief inside every tasks[] entry instead; this top-level field is not shared with the batch.",
		})),
		name: Type.Optional(Type.String({ description: LeaderNameDescription })),
		skills: Type.Optional(Type.Union([SkillsSchema, JsonString])),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
		tools: Type.Optional(Type.Union([Type.Array(Type.String(), { description: "Tool allowlist override (single mode); [] explicitly grants no tools" }), JsonString])),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run the single sub-agent in an isolated git worktree" }),
		),
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give the single sub-agent working MCP tools (runs it on the child engine; the default engine leaves MCP tools 'not initialized')" }),
		),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Single-mode idle window in ms, reset by any progress. NOT a deadline: a worker that keeps progressing runs past it. A positive value overrides the shared default; zero or negative uses the default." }),
		),
		writeSet: Type.Optional(Type.Union([WriteSetSchema, JsonString])),
		outputContract: Type.Optional(Type.String({ description: "Name of an installed output contract (see /doctor; built-in: default). Omit for free-form output — describe the report shape in requiredArtifacts instead." })),
		tasks: Type.Optional(
			Type.Union([
				Type.Array(Type.Union([DelegateTaskItem, JsonString])),
				JsonString,
			], { description: `Independent tasks as an array of objects (at most ${d.RUN_LIMITS.maxChildren} workers per call; split larger batches). Each entry carries its own agent, task, and any policy-required brief; top-level single-mode fields are not inherited. Give each a bounded scope; parallel writers need disjoint writeSet values.` }),
		),
		concurrency: Type.Optional(
			Type.Integer({ minimum: 1, description: `Max children to run at once (default ${d.RUN_LIMITS.maxConcurrency}; larger requests are clamped)` }),
		),
	});

	// Canonicalise a delegate's requested model names to provider/id; return a clear
	// error (no spawn) when one is ambiguous/unknown so the supervisor retries with a
	// valid id instead of wasting a child on an unauthenticated provider.
	function resolveDelegateModels(params: DelegateCall, ctx: ExtensionContext): string | undefined {
		const models = configuredModels(ctx);
		if (models.length === 0) return undefined;
		const preferProvider = ctx.model?.provider; // the loader/session provider (the authenticated one)
		const slots: Array<{ ref: string; set: (v: string) => void; who: string }> = [];
		if (params.model) slots.push({ ref: params.model, set: (v) => { params.model = v; }, who: "the sub-agent" });
		params.tasks?.forEach((t, i) => {
			if (t.model) slots.push({ ref: t.model, set: (v) => { t.model = v; }, who: `task ${i + 1} (${t.agent})` });
		});
		for (const s of slots) {
			const r = resolveModelRef(s.ref, models, preferProvider);
			if (r.ok) {
				s.set(r.ref);
				continue;
			}
			const list = r.candidates.slice(0, 10).join(", ");
			return `delegate: model "${s.ref}" for ${s.who} is ${r.reason} — use an exact model id. Candidates: ${list}${r.candidates.length > 10 ? ", …" : ""}.`;
		}
		return undefined;
	}

	// The launch pool: EVERY delegate run passes through here, headless ones included, so a 20-task
	// fan-out respects one concurrency ceiling instead of opening 20 model sessions at once. Queued
	// runs show as "running" with no progress yet; stopping a queued run works (the engine settles a
	// pre-aborted signal without a model call). A background `council`/`flow` takes ONE slot of this same
	// pool for its whole run (tools/background-run.ts); its inner legs are gated by the strategy SDK's own semaphore.
	const asyncSlots = d.launchPool ?? new Semaphore(d.RUN_LIMITS.maxConcurrency);
	let asyncNameSequence = 0;

	// Runtime anti-loop guard: an identical (agent, model, task) delegation that failed
	// twice is vetoed BEFORE it spawns — the completion report's "don't re-issue" guidance
	// is advice; this is the enforcement (capabilities are never prompt-only).
	const ledger = new DelegationLedger({ ledgerV2: d.config.ledgerV2 });

	// Only the built-in inspection tools are known read-only. Shells and unknown/custom tools are
	// potential writers; treating them as readers would let a persona's ownership policy fail open
	// merely by moving an edit into a script. ONE classifier for the in-batch gates and the
	// cross-call one below, so a leg can never count as a writer in one and a reader in the other.
	// `skills`/`role` are deliberately NOT part of this: both are prompt text (a skills preamble and an
	// appended system prompt), while `tools` is an enforced session allowlist in both engines — a leg
	// granted only read/grep/find/ls cannot write however it is instructed. Classifying on them would
	// invent writers that provably cannot write, and under requireDisjointWrites that is a hard refusal.
	const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
	function mayMutateWorkspace(spec: { agent: string; tools?: string[] | undefined; mcp?: boolean | undefined }): boolean {
		const configured = d.agents.find((agent) => agent.name === spec.agent);
		const effectiveTools = spec.tools !== undefined ? spec.tools : configured?.tools;
		const effectiveMcp = spec.mcp ?? configured?.mcp;
		return effectiveMcp === true || effectiveTools === undefined || effectiveTools.some((tool) => !readOnlyTools.has(tool));
	}

	// Ownership intent belongs to the agent definition, not to the caller. An agent that declares the area
	// it alone writes (`writeSet` in its frontmatter: research → `.research/`) hands that area to every leg
	// that names none of its own, so the persona's ownership gate sees a writer with disjoint ownership
	// rather than an unknown one the supervisor would have to guess a fix for. A leg's own non-empty
	// writeSet always wins, and an agent that declares nothing leaves the leg exactly as the caller wrote
	// it. Declarative like the field it fills: the paths annotate and gate, nothing enforces them at runtime.
	function inheritAgentWriteSets(call: DelegateCall): DelegateCall {
		const declared = (agent: string | undefined, own: readonly string[] | undefined): string[] | undefined => {
			if (own?.some((path) => path.trim())) return undefined;
			const set = d.agents.find((candidate) => candidate.name === agent)?.writeSet;
			return set && set.length > 0 ? [...set] : undefined;
		};
		if (call.tasks && call.tasks.length > 0) {
			return {
				...call,
				tasks: call.tasks.map((task) => {
					const inherited = declared(task.agent, task.writeSet);
					return inherited ? { ...task, writeSet: inherited } : task;
				}),
			};
		}
		const inherited = declared(call.agent, call.writeSet);
		return inherited ? { ...call, writeSet: inherited } : call;
	}

	// An interactive `tasks` fan-out of 2+ legs gets one header row — `delegate · N legs`, detail `k/N settled`
	// — that leaves with its last leg. Settlement only ever updates or removes it, never adds, so a leg that
	// settles after the tree was cleared (/new, shutdown) cannot resurrect it. Legs are counted as they
	// settle (not derived from the tracker), so a leg failing inside launch() cannot close it early.
	const batchRows = new Map<string, { size: number; settled: number }>();
	const batchRowId = (batch: string): string => `delegate:${batch}`;
	function openBatchRow(batch: string, size: number): string {
		batchRows.set(batch, { size, settled: 0 });
		const id = batchRowId(batch);
		d.agentTree.add({ id, label: `delegate · ${size} legs`, kind: "delegate", status: "running", detail: `0/${size} settled` });
		return id;
	}
	d.tracker.onComplete(({ batch }) => {
		if (batch === undefined) return;
		const row = batchRows.get(batch);
		if (!row) return;
		row.settled += 1;
		if (row.settled < row.size) {
			d.agentTree.update(batchRowId(batch), { detail: `${row.settled}/${row.size} settled` });
			return;
		}
		batchRows.delete(batch);
		d.agentTree.update(batchRowId(batch), { status: "done" }); // a node removed while "running" is reported as stopped
		d.agentTree.remove(batchRowId(batch));
	});

	// Launch one agent (tracked) and add its live async node to the tree. `label` is the bare codename
	// (nameFor) — the model is folded in here (and stored on the d.tracker entry) so the tree node and
	// every intercom digest show the SAME composed name. `inline` (headless) means the launching call
	// stays parked until the run settles, so the leg may not block on a supervisor reply it cannot give.
	// `fanOut` is set for a leg of a `tasks` call: its batch id, the per-call concurrency gate, and the
	// header row it hangs under (interactive fan-outs of 2+ legs only).
	function launchAsyncRun(agent: string, task: string, runSpec: AgentRunSpec, label: string, inline: boolean, fanOut?: { batch: string; slots: Semaphore | undefined; groupId: string | undefined }): string {
		const model = shortModel(runSpec.model);
		// The writer classification travels WITH the run (d.tracker metadata), not in a side Set keyed by
		// the returned id: a thunk that throws synchronously settles the run inside launch(), so a
		// registration after launch() returns would re-insert an already-dead run and leak it.
		const id = d.tracker.launch({ agent, task, label, ...(model ? { model } : {}), mutates: mayMutateWorkspace(runSpec), queued: true, ...(fanOut ? { batch: fanOut.batch } : {}) }, (onProgress, runId) => {
			const nodeId = `async:${runId}`;
			// A real, HARD stop for the async run (a steer is only a soft request the child may
			// ignore): aborting this signal makes the engine call the sub-agent's `agent.abort()`.
			const ac = new AbortController();
			d.stopRegistry.set(nodeId, () => ac.abort());
			const execute = () =>
				asyncSlots.with(() => {
					d.tracker.markAdmitted(runId);
					return d.buildEngine(
						undefined,
						(snap) => {
							onProgress(snap);
							if (snap.toolEvent) d.publishAgentTool(nodeId, snap.toolEvent);
							const now = Date.now();
							d.agentTree.update(nodeId, progressPatch(snap, now));
							// Any leg advancing is the batch advancing: its header must not show a false stall.
							if (fanOut?.groupId) d.agentTree.update(fanOut.groupId, { lastAdvanceAt: now });
						},
						{ async: !inline },
						// STOP via `ac.signal` (hard abort) and STEER via the run-id key (soft redirect) —
						// both work for the supervisor (intercom `stop`/`steer`) and the f9 overlay (`x`/`s`),
						// for ANY persona (these are supervisor→child controls, not child tools).
					).run(runSpec, undefined, ac.signal, (steer) => {
						d.steerRegistry.set(nodeId, steer);
						// live now — clear the "queued" marker and re-stamp the clock from run time, not
						// the queue-time seed, so the elapsed reading and stall badge are both honest.
						const now = Date.now();
						d.agentTree.update(nodeId, { detail: "", startedAt: now, lastAdvanceAt: now });
					});
				}, ac.signal);
			// A per-call semaphore composes with the process-wide ceiling. Acquire it first so a
			// queued member of a serial batch never occupies a global slot while waiting for its
			// predecessor, so `concurrency: 1` means one leg at a time.
			return (fanOut?.slots ? fanOut.slots.with(execute, ac.signal) : execute())
				.catch((error: unknown): AgentResult => {
					if (!ac.signal.aborted) throw error;
					return { agent, output: "", usage: emptyUsage(), ok: false, error: "agent aborted", failureKind: "abort" };
				})
				.then((r) => {
					if (shouldRecordDelegationOutcome(r)) {
						ledger.record(keyInputOf({ ...runSpec, task }), r.ok);
					}
					return r;
				});
		});
		const nodeId = `async:${id}`;
		// "queued" until the semaphore grants a slot and the engine reports it steerable. Every
		// `async:*` node IS async by construction, so no "(async)" tag is needed — fold in the
		// model instead, matching the canonical `<codename> · <model>` name shown elsewhere.
		d.agentTree.add({
			id: nodeId,
			label: model ? `${label} · ${model}` : label,
			...(fanOut?.groupId ? { parentId: fanOut.groupId } : {}),
			status: "running",
			kind: "subagent",
			agent,
			...(runSpec.model ? { model: runSpec.model } : {}),
			detail: "queued",
		});
		// Arm the async-run status/stall monitor (no-op if both cadences are disabled). A headless leg runs
		// inline with nobody to read a status card, exactly as the pre-tracker headless path did.
		if (!inline) d.startPeek();
		return id;
	}

	// Headless (`pi -p`): nothing drains a follow-up once the process exits, so the call that launched
	// the runs joins them and returns the very report their completion follow-up would have carried.
	async function settleInline(ids: string[], signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined, droppedNote = "") {
		const { runs, usage } = await d.runs.settle(ids, signal, (done, total) => {
			onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${total} done` }], details: {} });
		});
		const ok = runs.every((run) => run.status === "done");
		const dropped = droppedNote && `

[pi-persona]${droppedNote}`;
		return {
			content: [{ type: "text" as const, text: `${buildCompletionReport(runs, fenceUntrusted, { bounded: false })}${dropped}${d.drainBusBlock()}` }],
			details: ok ? {} : failureDetails({}),
			isError: !ok,
			...toolUsageField(usage),
		};
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to sub-agents — your default move whenever a task has independent, heavy, or parallel parts.",
			"Pass agent and task for one worker, or a tasks array for parallel workers. Required fields follow the active persona's delegation policy (the per-turn delegation brief shows the exact call shape); an incomplete call is rejected before any worker starts, and the error names what is missing.",
			"Interactive sessions ALWAYS run it in the BACKGROUND: you get run ids at once and stay free, and each result wakes you as a completion follow-up (a `tasks` call wakes you ONCE, when its last leg settles). Work independently meanwhile; when only children remain, end your turn. NEVER sleep, poll, or arm a `timer` to wait for a child. Headless sessions (`pi -p`) block for the turn and return results inline.",
			"Steering received during an active tool may be acted on after that tool returns; do not assume arbitrary tool work is interrupted immediately.",
			"No fitting agent? Shape one on the fly: `operator` + `role` (extra system prompt) + `skills`.",
			"Assign each worker's name before launch so it sees the same identity from its first turn; omitted names keep the generic fallback.",
			"A `model` may be a loose name ('sonnet', 'opus-4.6', 'claude-pro-max-native/opus-4-6') — it resolves to YOUR provider's id; ambiguous names return",
			"candidates (or call `models`). Other options: name, tools, outputContract, writeSet, isolation: \"worktree\", mcp, concurrency, tasks[].timeoutMs.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			d.lastCtx = ctx;
			// Interactive sessions (TUI and RPC) ALWAYS run in the background: the supervisor stays free
			// and results return as follow-ups (the idle-gated push path). Headless (`pi -p`) launches the
			// SAME runs but joins them before returning — the single turn must carry the result. A runtime
			// constraint, not a model-facing choice, so there is no flag.
			const inline = isInline(ctx);
			const coerced = coerceDelegateParams(rawParams);
			if (!coerced.ok) return { content: [{ type: "text", text: coerced.error }], details: failureDetails({}), isError: true };
			let params = coerced.params;
			const policy = d.controller.activePersona?.delegation;
			const defaultOutputContract = policy?.outputContract;
			if (defaultOutputContract) {
				params = params.tasks && params.tasks.length > 0
					? {
							...params,
							tasks: params.tasks.map((task) => task.outputContract?.trim() ? task : { ...task, outputContract: defaultOutputContract }),
						}
					: params.agent && params.task && !params.outputContract?.trim()
						? { ...params, outputContract: defaultOutputContract }
						: params;
			}
			// Before classification and every ownership consumer (the gate, the overlap check, the run specs).
			params = inheritAgentWriteSets(params);
			if (policy?.requireBrief) {
				const briefError = validateDelegationBrief(params);
				if (briefError) return { content: [{ type: "text", text: briefError }], details: failureDetails({}), isError: true };
			}
			if (params.tasks && params.tasks.length > 0) {
				const effectiveConcurrency = normalizeDelegateConcurrency(params.concurrency, d.RUN_LIMITS.maxConcurrency);
				const classified = params.tasks.map((task, index) => ({ task, index, mayWrite: mayMutateWorkspace(task) }));
				const writing = classified.filter((entry) => entry.mayWrite);
				if (policy?.requireFreshVerification && policy.verificationAgents && policy.verificationAgents.length > 0) {
					const verifierNames = new Set(policy.verificationAgents);
					const droppedVerifiers = params.tasks
						.slice(d.RUN_LIMITS.maxChildren)
						.filter((task) => verifierNames.has(task.agent));
					if (droppedVerifiers.length > 0) {
						const names = [...new Set(droppedVerifiers.map((task) => `"${task.agent}"`))].join(", ");
						const message =
							`delegate: the max-children limit (${d.RUN_LIMITS.maxChildren}) would truncate declared fresh verifier ${names}. ` +
							"Split the mutations into smaller batches and run every verifier after the final material mutation; no partial batch was started.";
						return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
					}
					const verifiers = classified.filter(({ task }) => verifierNames.has(task.agent));
					// A declared verifier may itself have `bash` for running tests; that makes it a
					// potential filesystem writer for ownership purposes, but not the material mutation
					// it is meant to approve. Compare it only with the other mutating roles here.
					const mutations = writing.filter(({ task }) => !verifierNames.has(task.agent));
					const lastMutation = mutations.reduce((last, entry) => Math.max(last, entry.index), -1);
					const staleOrder = effectiveConcurrency === 1 && verifiers.some(({ index }) => index <= lastMutation);
					if (mutations.length > 0 && verifiers.length > 0 && (effectiveConcurrency > 1 || staleOrder)) {
						const names = verifiers.map(({ index, task }) => `tasks[${index}] ("${task.agent}")`).join(", ");
						const reason = effectiveConcurrency > 1
							? "would overlap a material mutation"
							: "is ordered before a material mutation";
						const message = `delegate: fresh verification must run after every material mutation; ${names} ${reason}. Serialize the batch with every writer first and every declared verifier last, or start the verifier in a later call once every writer has SETTLED (interactive: end your turn; its completion follow-up wakes you) — a later call while a writer is still running is rejected the same way.`;
						return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
					}
				}
				if (effectiveConcurrency > 1) {
					if (policy?.requireDisjointWrites) {
						if (writing.length > 1) {
							const unowned = writing.filter(({ task }) => !task.writeSet?.some((path) => path.trim()));
							if (unowned.length > 0) {
								const missing = unowned.map(({ index, task }) => `tasks[${index}] ("${task.agent}")`);
								// One remedy per leg, naming the parameters: the caller should never have to guess a fix.
								const remedies = unowned.map(({ index, task }) => `tasks[${index}] ("${task.agent}"): add writeSet: ["<files or directories only this leg edits>"], or make it a reader with tools: ["read","grep","find","ls"] (or pick scout).`);
								const message = `delegate: this persona requires disjoint ownership for parallel writers; missing non-empty writeSet on ${missing.join(", ")}. ${remedies.join(" ")} Or serialize the batch with concurrency: 1.`;
								return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
							}
						}
					}
					const writeSetError = validateParallelWriteSets(params.tasks);
					if (writeSetError) return { content: [{ type: "text", text: writeSetError }], details: failureDetails({}), isError: true };
				}
			}
			// The gate above sees ONE call. Interactive delegate is ALWAYS background, so the
			// remedy it prescribes — run the verifier in a later call — lands WHILE the mutation is
			// still running unless the same rule holds across calls; the policy would otherwise be
			// defeated by following its own instructions. Guidance is never the enforcement here
			// (capabilities are runtime-checked), so a verifier waits for the writers to settle.
			if (policy?.requireFreshVerification && policy.verificationAgents && policy.verificationAgents.length > 0) {
				const verifierNames = new Set(policy.verificationAgents);
				const requestedAgents = params.tasks && params.tasks.length > 0 ? params.tasks.map((t) => t.agent) : params.agent ? [params.agent] : [];
				if (requestedAgents.some((agent) => verifierNames.has(agent))) {
					// A declared verifier's own background legs are not the mutation it must approve
					// (same carve-out the in-batch gate makes for a test-running verifier).
					const liveMutations = d.tracker.writers().filter((run) => !verifierNames.has(run.agent));
					if (liveMutations.length > 0) {
						const verifierList = [...new Set(requestedAgents.filter((agent) => verifierNames.has(agent)))].map((agent) => `"${agent}"`).join(", ");
						const visibleMutations = liveMutations.slice(0, 8);
						const omittedMutations = liveMutations.length - visibleMutations.length;
						const inFlight = `${visibleMutations.map((run) => `${run.id} (${sanitizeLabel(run.agent)})`).join(", ")}${omittedMutations > 0 ? `, … +${omittedMutations} more` : ""}`;
						const message =
							`delegate: fresh verification must run after every material mutation; ${verifierList} cannot start while ${inFlight} ${liveMutations.length === 1 ? "is" : "are"} still running and may mutate the workspace. ` +
							(inline
								? "The writer's own call returns its result; start the verifier in a later call against the resulting state."
								: "End your turn; the writer's completion follow-up wakes you, then start the verifier against the resulting state.");
						return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
					}
				}
			}
			const modelErr = resolveDelegateModels(params, ctx);
			if (modelErr) return { content: [{ type: "text", text: modelErr }], details: failureDetails({}), isError: true };
			// Pre-spawn agent validation (mirrors the model path): a wrong name returns the
			// installed list instead of spawning into a bare engine failure, and a typo never
			// counts toward the ledger's 2-strike veto.
			const agentErr = unknownAgentError(
				params.tasks && params.tasks.length > 0 ? params.tasks.map((t) => t.agent) : params.agent ? [params.agent] : [],
				d.agents.map((a) => a.name),
			);
			if (agentErr) return { content: [{ type: "text", text: agentErr }], details: failureDetails({}), isError: true };
			// Same pre-spawn rule for output contracts: a prose description or a typo here used to become a
			// runtime engine failure on every leg; now it is one rejection that names the installed contracts.
			const contractErr = unknownContractError(
				params.tasks && params.tasks.length > 0 ? params.tasks.map((t) => t.outputContract) : [params.outputContract],
				d.contractNames(),
			);
			if (contractErr) return { content: [{ type: "text", text: contractErr }], details: failureDetails({}), isError: true };
			// Anti-loop veto (after model canonicalisation, so keys match retries): an
			// identical delegation that already failed twice does not spawn again.
			const requested =
				params.tasks && params.tasks.length > 0
					? params.tasks.map(keyInputOf)
					: params.agent && params.task
						? [keyInputOf({ ...params, agent: params.agent, task: params.task })]
						: [];
			const veto = ledger.vet(requested);
			if (veto) return { content: [{ type: "text", text: veto }], details: failureDetails({}), isError: true };
			if (params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks.slice(0, d.RUN_LIMITS.maxChildren);
				const dropped = params.tasks.length - tasks.length;
				const effectiveConcurrency = normalizeDelegateConcurrency(params.concurrency, d.RUN_LIMITS.maxConcurrency);
				// Avoid an extra scheduling hop when the requested limit cannot bind (also keeps a
				// one-leg background launch observably immediate, as it was before per-call limits).
				const batchSlots = effectiveConcurrency < tasks.length ? new Semaphore(effectiveConcurrency) : undefined;
				const nameOffset = asyncNameSequence;
				asyncNameSequence += tasks.length;
				// One id per call: the name offset only ever grows, so no two calls share it.
				const batch = `batch-${nameOffset.toString(36)}`;
				const fanOut = { batch, slots: batchSlots, groupId: !inline && tasks.length > 1 ? openBatchRow(batch, tasks.length) : undefined };
				const runs = tasks.map((t, i): DelegateLaunchSnapshot => {
					// Routed through specOf() (not a hand-rolled field list): a per-leg knob such as `timeoutMs`
					// lands here for free instead of needing a second copy.
					const spec = specOf(t, nameOffset + i);
					const label = nameFor(t, nameOffset + i);
					const id = launchAsyncRun(t.agent, t.task, spec, label, inline, fanOut);
					const model = shortModel(spec.model);
					return { id, label, agent: t.agent, ...(model ? { model } : {}) };
				});
				const ids = runs.map((run) => run.id);
				const droppedNote = dropped > 0 ? ` ${dropped} task(s) beyond the max-children limit (${d.RUN_LIMITS.maxChildren}) were dropped.` : "";
				if (inline) return settleInline(ids, signal, onUpdate, droppedNote);
				return {
					content: [
						{
							type: "text",
							text: `Launched ${ids.length} background leg${ids.length === 1 ? "" : "s"} as one batch: ${runs.map((run) => `${run.id} (${runDisplayName(run)})`).join(", ")}; you will be woken ONCE when the batch settles (${END_TURN_NOTE}).${droppedNote}`,
						},
					],
					details: { runIds: ids, runs, ...(dropped > 0 ? { dropped } : {}) },
					isError: false,
				};
			}
			if (params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const nameIndex = asyncNameSequence++;
				// Use the canonical mapper here too: explicit `none`/`false` and future fields must
				// survive exactly as they do in a fan-out.
				const single = { ...params, agent, task };
				const runSpec = specOf(single, nameIndex);
				const label = nameFor(single, nameIndex);
				const id = launchAsyncRun(agent, task, runSpec, label, inline);
				if (inline) return settleInline([id], signal, onUpdate);
				const model = shortModel(runSpec.model);
				return {
					content: [
						{
							type: "text",
							text: `Launched async run ${id} (${agent}) — runs in the background and wakes you on completion (${END_TURN_NOTE}).`,
						},
					],
					details: { runId: id, runs: [{ id, label, agent, ...(model ? { model } : {}) }] },
					isError: false,
				};
			}
			return {
				content: [{ type: "text", text: "delegate: provide either { agent, task } or { tasks: [{ agent, task }, ...] }" }],
				details: failureDetails({}),
				isError: true,
			};
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			const coerced = coerceDelegateParams(args);
			const view = coerced.ok ? coerced.params : undefined;
			if (view?.tasks && view.tasks.length > 0) {
				// Names live in the tree / final card — keep the call line itself minimal.
				return new Text(`${title}${theme.fg("accent", `parallel (${view.tasks.length})`)}`, 0, 0);
			}
			if (typeof args.tasks === "string" && args.tasks.trim()) {
				return new Text(`${title}${theme.fg("accent", "parallel")}`, 0, 0);
			}
			const identity = [view?.name ?? args.name, view?.agent ?? args.agent ?? "?"].filter(Boolean).join(" · ");
			const modelValue = view?.model ?? args.model;
			const model = typeof modelValue === "string" && modelValue.trim() ? theme.fg("dim", ` · ${compactInlineText(shortModel(modelValue), { maxChars: 48 })}`) : "";
			return new Text(`${title}${theme.fg("accent", compactInlineText(identity, { maxChars: 96 }) || "?")}${model}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			// Safe: the delegate `execute` above stores `{ runId | runIds, runs, dropped }` (interactive launch)
			// or nothing (a headless call's report is its text) in `details`; the double cast just narrows
			// Pi's opaque `details` type to that known shape for rendering.
			const details = result.details as unknown as { runId?: string; runIds?: string[]; runs?: unknown; dropped?: number } | undefined;
			const first = result.content[0];
			const fallback = details?.runIds?.length
				? `async runs ${details.runIds.join(", ")}`
				: details?.runId
					? `async run ${details.runId}`
					: "(no output)";
			const text = sanitizeTerminalText(first?.type === "text" ? first.text : fallback);
			const allowTracker = context === undefined || context.isPartial === true;
			const rows = details ? launchRows(details, d.tracker, allowTracker) : [];
			if (expanded) return new Text(expandedLaunchDetails(text, rows), 0, 0);
			if (details?.runId || details?.runIds?.length) {
				if (rows.length > 0 && !result.isError) {
					return new Text(theme.fg("accent", collapsedLaunchSummary(rows, details.dropped)), 0, 0);
				}
				if (result.isError) {
					const preview = compactVisibleText(text, { maxLines: 4, maxLineChars: 100 });
					return new Text(`${theme.fg("error", theme.bold("failed"))}\n${theme.fg("toolOutput", preview.text)}${preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : ""}`, 0, 0);
				}
				const ids = details.runIds?.length ? details.runIds.slice(0, 3) : [details.runId as string];
				const omitted = (details.runIds?.length ?? 0) - ids.length;
				const dropped = details.dropped ? ` · ${details.dropped} task${details.dropped === 1 ? "" : "s"} dropped (max children)` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", `launched ${ids.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`)}${theme.fg("dim", dropped)}`, 0, 0);
			}
			if (result.isError) {
				const preview = compactVisibleText(text, { maxLines: 4, maxLineChars: 100 });
				return new Text(`${theme.fg("error", theme.bold("delegate failed"))}\n${theme.fg("toolOutput", preview.text)}${preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : ""}`, 0, 0);
			}
			return new Text(theme.fg("toolOutput", compactVisibleText(text, { maxLines: 4, maxLineChars: 100 }).text), 0, 0);
		},
	});
}

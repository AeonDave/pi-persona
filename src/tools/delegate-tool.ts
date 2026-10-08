/** `delegate` tool registration. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/agent.ts";
import { Type } from "typebox";
import { fenceUntrusted } from "../core/fence.ts";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { configuredModels } from "../extension/engine.ts";
import { compactInlineText, MAX_COLLAPSED_CARD_COLUMNS, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { resolveModelRef } from "../core/models.ts";
import { inventedLegNameHint } from "../core/naming.ts";
import { formatUsage, toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";
import { sumUsage } from "../orchestration/reducers.ts";
import { expandDetailHint, failureDetails } from "../extension/shared.ts";
import {
	DelegationLedger, type DelegateView, type DelegateParams as DelegateCall, nameFor, normalizeDelegateConcurrency,
	runDelegate, shortModel, shouldRecordDelegationOutcome, specOf, unknownAgentError, unknownContractError,
	validateDelegationBrief, validateParallelWriteSets, wantsAsyncRun, coerceDelegateParams,
} from "./delegate.ts";
import { Semaphore } from "../orchestration/parallel.ts";
import type { AgentRunSpec, SteerFn, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { agentNodeStatusForDelegate, sanitizeLabel } from "../extension/shared.ts";
import type { PersonaController } from "../persona/controller.ts";
import type { AgentTree } from "../ui/agent-tree.ts";
import { runDisplayName, type AsyncRunTracker } from "../engine/async.ts";
import { emptyUsage, type ProgressSnapshot, type ToolEvent } from "../engine/stream.ts";
import { progressPatch } from "../ui/agent-tree.ts";
import type { AddNodeInput } from "../ui/agent-tree.ts";
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
	nextRootId: (prefix: string) => string;
	tracker: AsyncRunTracker;
	config: { ledgerV2: boolean };
	RUN_LIMITS: RunLimits;
	publishAgentTool(agentId: string, event: ToolEvent): void;
	stopRegistry: Map<string, () => void>;
	steerRegistry: Map<string, SteerFn>;
	stopRequested: Set<string>;
	ensurePersonaModels(ctx: ExtensionContext, roster: unknown[]): Promise<void>;
	clearStops(prefix: string): void;
	clearSteers(prefix: string): void;
	drainBusBlock(): string;
	startPeek(): void;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
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
			Type.Number({ description: "Idle timeout in ms for this worker: resets on progress, not a total runtime cap. A positive value overrides the shared default; zero or negative uses the default." }),
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
			Type.Number({ description: "Single-mode idle timeout in ms: resets on progress, not a total runtime cap. A positive value overrides the shared default; zero or negative uses the default." }),
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
		async: Type.Optional(
			Type.Boolean({
				description:
					"Explicitly run in the background (already the DEFAULT in interactive sessions) — returns run ids at once; each result comes back to you automatically as a follow-up. Set false to force blocking. If both async and sync are supplied, async takes precedence.",
			}),
		),
		sync: Type.Optional(
			Type.Boolean({
				description:
					"Block this turn until the sub-agent(s) finish and return their results inline — only when you need them before your very next step. (Headless sessions already default to sync.) Omit async when using this flag; an explicit async value takes precedence.",
			}),
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

	// The async launch pool: every background run passes through here, so a 20-task async
	// fan-out respects the same concurrency ceiling a sync delegate does, instead of opening
	// 20 model sessions at once. Queued runs show as "running" with no progress yet; stopping
	// a queued run works (the engine settles a pre-aborted signal without a model call).
	const asyncSlots = new Semaphore(d.RUN_LIMITS.maxConcurrency);
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

	// Launch one agent in the background (tracked) and add its live async node to the tree.
	// `label` is the bare codename (nameFor) — the model is folded in here (and stored on the
	// d.tracker entry) so the tree node and every intercom digest show the SAME composed name.
	function launchAsyncRun(agent: string, task: string, runSpec: AgentRunSpec, label: string, batchSlots?: Semaphore): string {
		const model = shortModel(runSpec.model);
		// The writer classification travels WITH the run (d.tracker metadata), not in a side Set keyed by
		// the returned id: a thunk that throws synchronously settles the run inside launch(), so a
		// registration after launch() returns would re-insert an already-dead run and leak it.
		const id = d.tracker.launch({ agent, task, label, ...(model ? { model } : {}), mutates: mayMutateWorkspace(runSpec) }, (onProgress, runId) => {
			const nodeId = `async:${runId}`;
			// A real, HARD stop for the async run (a steer is only a soft request the child may
			// ignore): aborting this signal makes the engine call the sub-agent's `agent.abort()`.
			const ac = new AbortController();
			d.stopRegistry.set(nodeId, () => ac.abort());
			const execute = () =>
				asyncSlots.with(() =>
					d.buildEngine(
						undefined,
						(snap) => {
							onProgress(snap);
							if (snap.toolEvent) d.publishAgentTool(nodeId, snap.toolEvent);
							d.agentTree.update(nodeId, progressPatch(snap, Date.now()));
						},
						{ async: true },
						// STOP via `ac.signal` (hard abort) and STEER via the run-id key (soft redirect) —
						// both work for the supervisor (intercom `stop`/`steer`) and the f9 overlay (`x`/`s`),
						// for ANY persona (these are supervisor→child controls, not child tools).
					).run(runSpec, undefined, ac.signal, (steer) => {
						d.steerRegistry.set(nodeId, steer);
						// live now — clear the "queued" marker and re-stamp the clock from run time, not
						// the queue-time seed, so the elapsed reading and stall badge are both honest.
						const now = Date.now();
						d.agentTree.update(nodeId, { detail: "", startedAt: now, lastAdvanceAt: now });
					}),
					ac.signal,
				);
			// A per-call semaphore composes with the process-wide ceiling. Acquire it first so a
			// queued member of a serial batch never occupies a global slot while waiting for its
			// predecessor. This makes `concurrency: 1` mean the same thing in sync and async mode.
			return (batchSlots ? batchSlots.with(execute, ac.signal) : execute())
				.catch((error: unknown): AgentResult => {
					if (!ac.signal.aborted) throw error;
					return { agent, output: "", usage: emptyUsage(), ok: false, error: "agent aborted", failureKind: "abort" };
				})
				.then((r) => {
					if (shouldRecordDelegationOutcome(r)) {
						ledger.record(
							{
								agent,
								...(runSpec.model ? { model: runSpec.model } : {}),
								task,
								...(runSpec.role ? { role: runSpec.role } : {}),
								...(runSpec.tools !== undefined ? { tools: runSpec.tools } : {}),
								...(runSpec.isolation ? { isolation: runSpec.isolation } : {}),
							},
							r.ok,
						);
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
			status: "running",
			kind: "subagent",
			agent,
			...(runSpec.model ? { model: runSpec.model } : {}),
			detail: "queued",
		});
		d.startPeek(); // arm the async-run status/stall monitor (no-op if both cadences are disabled)
		return id;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to sub-agents — your default move whenever a task has independent, heavy, or parallel parts.",
			"Pass agent and task for one worker, or a tasks array for parallel workers. Follow the active persona's delegation policy for required fields.",
			"When requireBrief is active, EVERY worker needs brief: { objective, scopeRoe, position, constraints, requiredArtifacts, stopConditions } with nonempty values, including read-only scouts. In parallel mode put it in each tasks[].brief; task prose and a top-level brief do not substitute. Read the current per-turn delegation brief for a complete example.",
			"A persona may also require a structured output contract or disjoint writeSet ownership for parallel writers. Incomplete calls are rejected before any worker starts; fill the missing fields across the batch before retrying.",
			"In interactive sessions it runs in the BACKGROUND by default: you get run ids at once and stay free.",
			"Work independently while children run; when only children remain, end your turn and let their automatic completion follow-ups wake you.",
			"Do not monitor, poll, or automatically wait for all children. Use `intercom wait` only when a result is needed before your next step; `sync: true` intentionally blocks instead; headless runs default to sync.",
			"Steering received during an active tool may be acted on after that tool returns; do not assume arbitrary tool work is interrupted immediately.",
			"No fitting agent? Shape one on the fly: `operator` + `role` (extra system prompt) + `skills`.",
			"Assign each worker's name before launch so it sees the same identity from its first turn; omitted names keep the generic fallback.",
			"A `model` may be a loose name ('sonnet') — it resolves to YOUR provider's id; ambiguous names return",
			"candidates (or call `models`). Other options: name, tools, outputContract, writeSet, isolation: \"worktree\", mcp, concurrency, tasks[].timeoutMs.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			d.lastCtx = ctx;
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
						const message = `delegate: fresh verification must run after every material mutation; ${names} ${reason}. Serialize the batch with every writer first and every declared verifier last, or start the verifier in a later call once every writer has SETTLED (its completion follow-up, or intercom { action:"wait", to:"<run-id>" }) — a later call while a writer is still running is rejected the same way.`;
						return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
					}
				}
				if (effectiveConcurrency > 1) {
					if (policy?.requireDisjointWrites) {
						if (writing.length > 1) {
							const missing = writing.filter(({ task }) => !task.writeSet?.some((path) => path.trim())).map(({ index, task }) => `tasks[${index}] ("${task.agent}")`);
							if (missing.length > 0) {
								const message = `delegate: this persona requires disjoint ownership for parallel writers; missing non-empty writeSet on ${missing.join(", ")}. Declare repository-relative paths each of those legs alone may edit, restrict tools to read/grep/find/ls (or pick scout), or serialize with concurrency: 1.`;
								return { content: [{ type: "text", text: message }], details: failureDetails({}), isError: true };
							}
						}
					}
					const writeSetError = validateParallelWriteSets(params.tasks);
					if (writeSetError) return { content: [{ type: "text", text: writeSetError }], details: failureDetails({}), isError: true };
				}
			}
			// The gate above sees ONE call. Interactive delegate is background by default, so the
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
							`delegate: fresh verification must run after every material mutation; ${verifierList} cannot start while ${inFlight} ${liveMutations.length === 1 ? "is" : "are"} still mutating. ` +
							`Wait for the completion follow-up (or intercom { action:"wait", to:"${liveMutations[0]?.id}" }), then start the verifier against the resulting state.`;
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
					? params.tasks.map((t) => ({
							agent: t.agent,
							...(t.model ? { model: t.model } : {}),
							task: t.task,
							...(t.role ? { role: t.role } : {}),
							...(t.tools !== undefined ? { tools: t.tools } : {}),
							...(t.isolation ? { isolation: t.isolation } : {}),
						}))
					: params.agent && params.task
						? [
								{
									agent: params.agent,
									...(params.model ? { model: params.model } : {}),
									task: params.task,
									...(params.role ? { role: params.role } : {}),
									...(params.tools !== undefined ? { tools: params.tools } : {}),
									...(params.isolation ? { isolation: params.isolation } : {}),
								},
							]
						: [];
			const veto = ledger.vet(requested);
			if (veto) return { content: [{ type: "text", text: veto }], details: failureDetails({}), isError: true };
			// Background by default in interactive sessions: the supervisor stays free and results
			// return as follow-ups (the idle-gated push path). Headless (`pi -p`) defaults to sync —
			// the single turn must carry the result, and nothing drains a follow-up after the
			// process exits. An explicit `async` always wins; `sync: true` opts one call out.
			const wantsAsync = wantsAsyncRun(params, ctx.hasUI === true);
			// Async (single OR parallel): run in the background so YOU stay free to keep
			// working / answer the user — results arrive later as follow-ups; /peek to watch.
			if (wantsAsync && params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks.slice(0, d.RUN_LIMITS.maxChildren);
				const dropped = params.tasks.length - tasks.length;
				const effectiveConcurrency = normalizeDelegateConcurrency(params.concurrency, d.RUN_LIMITS.maxConcurrency);
				// Avoid an extra scheduling hop when the requested limit cannot bind (also keeps a
				// one-leg background launch observably immediate, as it was before per-call limits).
				const batchSlots = effectiveConcurrency < tasks.length ? new Semaphore(effectiveConcurrency) : undefined;
				const nameOffset = asyncNameSequence;
				asyncNameSequence += tasks.length;
				const runs = tasks.map((t, i): DelegateLaunchSnapshot => {
					// Routed through specOf() (not a hand-rolled field list) so this, the interactive
					// DEFAULT delegate path, never drifts from the sync path's mapping — NP2's per-leg
					// `timeoutMs` (and any future knob) lands here for free instead of needing a second copy.
					const spec = specOf(t, nameOffset + i);
					const label = nameFor(t, nameOffset + i);
					const id = launchAsyncRun(t.agent, t.task, spec, label, batchSlots);
					const model = shortModel(spec.model);
					return { id, label, agent: t.agent, ...(model ? { model } : {}) };
				});
				const ids = runs.map((run) => run.id);
				const droppedNote = dropped > 0 ? ` ${dropped} task(s) beyond the max-children limit (${d.RUN_LIMITS.maxChildren}) were dropped.` : "";
				return {
					content: [
						{
							type: "text",
							text: `Launched ${ids.length} async runs in the background (${ids.join(", ")}) — keep working; each notifies on completion. /peek to watch.${droppedNote}`,
						},
					],
					details: { runIds: ids, runs, ...(dropped > 0 ? { dropped } : {}) },
					isError: false,
				};
			}
			if (wantsAsync && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				const nameIndex = asyncNameSequence++;
				// Use the canonical mapper here too: explicit `none`/`false` and future fields must
				// survive exactly as they do in fan-out and sync mode.
				const single = { ...params, agent, task };
				const runSpec = specOf(single, nameIndex);
				const label = nameFor(single, nameIndex);
				const id = launchAsyncRun(agent, task, runSpec, label);
				const model = shortModel(runSpec.model);
				return {
					content: [
						{
							type: "text",
							text: `Launched async run ${id} (${agent}) — runs in the background; you'll be notified on completion. /peek ${id} to watch.`,
						},
					],
					details: { runId: id, runs: [{ id, label, agent, ...(model ? { model } : {}) }] },
					isError: false,
				};
			}
			const delRoot = `delegate:${_toolCallId}`;
			d.agentTree.add({ id: delRoot, label: "delegate", status: "running", kind: "delegate" });
			try {
				const delegateLimits = { maxConcurrency: d.RUN_LIMITS.maxConcurrency, maxChildren: d.RUN_LIMITS.maxChildren };
				const outcome = await runDelegate(
					params,
					d.buildEngine(signal),
					delegateLimits,
					(views) => {
						views.forEach((v, i) => {
							const id = `${delRoot}/${i}`;
							if (!v.running) {
								d.stopRegistry.delete(id);
								d.stopRequested.delete(id);
								d.steerRegistry.delete(id);
							}
							const status = agentNodeStatusForDelegate(v);
							const spec = requested[i];
							const node: AddNodeInput = {
								id,
								label: v.label,
								parentId: delRoot,
								status,
								kind: "subagent",
								...(spec?.agent ? { agent: spec.agent } : {}),
								...(spec?.model ? { model: spec.model } : {}),
							};
							node.detail = v.running ? v.activity : formatUsage(v.usage);
							if (v.output) node.output = v.output;
							d.agentTree.add(node);
						});
						const done = views.filter((v) => !v.running).length;
						onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
					},
					(i, abort) => d.stopRegistry.set(`${delRoot}/${i}`, abort),
					(i, steer) => d.steerRegistry.set(`${delRoot}/${i}`, steer),
					// The same run signal the engine was built with: a leg whose engine REJECTS under a
					// whole-run stop must file as "abort", not as an agent failure the user never caused.
					signal,
					(i, event) => d.publishAgentTool(`${delRoot}/${i}`, event),
				);
				// Feed the anti-loop ledger (results align with the requested tasks by index).
				outcome.results.forEach((r, i) => {
					const t = requested[i];
					if (t && shouldRecordDelegationOutcome(r)) ledger.record(t, r.ok);
				});
				d.agentTree.update(delRoot, { status: signal?.aborted ? "stopped" : outcome.ok ? "done" : "failed" });
				const usage = sumUsage(outcome.results.map((r) => r.usage));
				d.childUsage.account(usage);
				d.publishPersonaCost();
				return {
					// Sub-agent text is untrusted even as a tool result (guardrails §: fence
					// before it reaches the supervisor) — the async path already fences via
					// buildCompletionReport; the sync path must match.
					content: [{ type: "text", text: `${fenceUntrusted(outcome.text)}${d.drainBusBlock()}` }],
					details: outcome.ok ? { views: outcome.views } : failureDetails({ views: outcome.views }),
					isError: !outcome.ok,
					...toolUsageField(usage),
				};
			} catch (error) {
				d.agentTree.update(delRoot, { status: signal?.aborted ? "stopped" : "failed" });
				throw error;
			} finally {
				d.clearStops(delRoot);
				d.clearSteers(delRoot);
				d.agentTree.remove(delRoot);
			}
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			const coerced = coerceDelegateParams(args);
			const view = coerced.ok ? coerced.params : undefined;
			const mode = wantsAsyncRun(view ?? args, true) ? theme.fg("warning", " async") : theme.fg("dim", " sync");
			if (view?.tasks && view.tasks.length > 0) {
				// Names live in the tree / final card — keep the call line itself minimal.
				return new Text(`${title}${theme.fg("accent", `parallel (${view.tasks.length})`)}${mode}`, 0, 0);
			}
			if (typeof args.tasks === "string" && args.tasks.trim()) {
				return new Text(`${title}${theme.fg("accent", "parallel")}${mode}`, 0, 0);
			}
			const identity = [view?.name ?? args.name, view?.agent ?? args.agent ?? "?"].filter(Boolean).join(" · ");
			const modelValue = view?.model ?? args.model;
			const model = typeof modelValue === "string" && modelValue.trim() ? theme.fg("dim", ` · ${compactInlineText(shortModel(modelValue), { maxChars: 48 })}`) : "";
			return new Text(`${title}${theme.fg("accent", compactInlineText(identity, { maxChars: 96 }) || "?")}${model}${mode}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			// Safe: the delegate `execute` above always stores `{ views: DelegateView[] }` (sync,
			// single/parallel) or `{ runId | runIds }` (async) in `details`; the double cast just narrows
			// Pi's opaque `details` type to that known shape for rendering.
			const details = result.details as unknown as { views?: DelegateView[]; runId?: string; runIds?: string[]; runs?: unknown; dropped?: number } | undefined;
			const views = details?.views ?? [];
			if (views.length === 0) {
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
			}
			const title = theme.fg("toolTitle", theme.bold("delegate "));
			const running = views.filter((v) => v.running).length;
			// While running, render nothing — the live per-agent view is the tree widget
			// (and the f9 overlay). A sticky card here would just duplicate it. The full
			// per-leg cards below appear once the run completes.
			if (running > 0) return new Container();
			const okCount = views.filter((v) => v.ok).length;
			const container = new Container();
			container.addChild(new Text(`${title}${theme.fg("accent", `${okCount}/${views.length} ok`)}`, 0, 0));
			// A failure is actionable; never bury it below a page of successful legs. Collapsed cards
			// show at most three semantic one-line previews. Expansion remains the lossless inspection
			// surface, while F9 keeps the live navigable tree.
			const ordered = expanded ? views : [...views].sort((a, b) => Number(a.ok) - Number(b.ok));
			const visible = expanded ? ordered : ordered.slice(0, 3);
			for (const v of visible) {
				const icon = v.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const usageStr = formatUsage(v.usage);
				const usage = usageStr ? theme.fg("dim", ` ${usageStr}`) : "";
				const body = sanitizeTerminalText(v.output || "(no output)");
				if (expanded) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${icon} ${theme.fg("accent", compactInlineText(v.label, { maxChars: 96 }) || "agent")}${usage}`, 0, 0));
					container.addChild(new Text(theme.fg("toolOutput", body), 0, 0));
					continue;
				}
				// Keep the collapsed semantic row below 100 columns even on a very wide terminal.
				// Usage remains one keystroke away in expanded mode; the collapsed card prioritizes
				// identity + outcome instead of wrapping one result into several pseudo-rows.
				const preview = compactVisibleText(body, { maxLines: 1, maxLineChars: 60 });
				container.addChild(
					new Text(`${icon} ${theme.fg("accent", compactInlineText(v.label, { maxChars: 28 }) || "agent")} · ${theme.fg("toolOutput", preview.text)}`, 0, 0),
				);
			}
			if (!expanded) {
				const omitted = views.length - visible.length;
				const prefix = omitted > 0 ? `… +${omitted} more result${omitted === 1 ? "" : "s"} · ` : "";
				container.addChild(new Text(theme.fg("dim", `${prefix}${expandDetailHint()}`), 0, 0));
			}
			return container;
		},
	});
}

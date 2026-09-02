/** `delegate` tool registration. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/agent.ts";
import { Type } from "typebox";
import { failureDetails } from "../extension/shared.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { Text } from "@earendil-works/pi-tui";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { configuredModels } from "../extension/engine.ts";
import { compactInlineText, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { resolveModelRef } from "../core/models.ts";
import { inventedLegNameHint } from "../core/naming.ts";
import { formatUsage, toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";
import { sumUsage } from "../orchestration/reducers.ts";
import { expandDetailHint } from "../extension/shared.ts";
import type { Static } from "typebox";
import {
	DelegationLedger, type DelegateView, nameFor, normalizeDelegateConcurrency,
	runDelegate, shortModel, shouldRecordDelegationOutcome, specOf, unknownAgentError,
	validateDelegationBrief, validateParallelWriteSets, wantsAsyncRun,
} from "./delegate.ts";
import { Semaphore } from "../orchestration/parallel.ts";
import type { AgentRunSpec, SteerFn, StrategyEngine } from "../orchestration/sdk.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { agentNodeStatusForDelegate, sanitizeLabel } from "../extension/shared.ts";
import type { PersonaController } from "../persona/controller.ts";
import type { AgentTree } from "../ui/agent-tree.ts";
import type { AsyncRunTracker } from "../engine/async.ts";
import { emptyUsage, type ProgressSnapshot, type ToolEvent } from "../engine/stream.ts";
import { compactTokens } from "../engine/async.ts";
import type { AddNodeInput } from "../ui/agent-tree.ts";
import type { RunLimits } from "../core/capabilities.ts";

export interface DelegateToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	controller: PersonaController;
	agents: AgentConfig[];
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
	const SkillsSchema = Type.Array(Type.String(), {
		description: "Skills the sub-agent loads first — spawns a dynamic specialist (skills are inherited from the host)",
	});
	const RoleSchema = Type.String({
		description:
			"On-the-fly specialist persona: extra system-prompt text appended to the agent's own (e.g. 'You are a Rust unsafe-code auditor…') — combine with `skills` to shape a dynamic sub-agent without authoring a file",
	});
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
		brief: Type.Optional(DelegationBriefSchema),
		name: Type.Optional(
			Type.String({ description: inventedLegNameHint() }),
		),
		skills: Type.Optional(SkillsSchema),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(
			Type.String({ description: "Model override (exact provider/id — call the `models` tool to find one)" }),
		),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this sub-agent; [] explicitly grants no tools" })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run in an isolated git worktree (edits never touch the main tree)" }),
		),
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give this sub-agent working MCP tools (runs it on the child engine so pi-mcp-adapter initializes; the default engine leaves MCP tools 'not initialized'). Pass any server session id in the task to share a server-keyed backend's state." }),
		),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Per-leg wall-clock ceiling in ms; overrides the shared default for this task only" }),
		),
		writeSet: Type.Optional(WriteSetSchema),
		outputContract: Type.Optional(Type.String({ description: "Installed output contract enforced for this leg" })),
	});
	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent to delegate to (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
		brief: Type.Optional(DelegationBriefSchema),
		name: Type.Optional(Type.String({ description: inventedLegNameHint() })),
		skills: Type.Optional(SkillsSchema),
		role: Type.Optional(RoleSchema),
		model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override (single mode); [] explicitly grants no tools" })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree = run the single sub-agent in an isolated git worktree" }),
		),
		mcp: Type.Optional(
			Type.Boolean({ description: "true = give the single sub-agent working MCP tools (runs it on the child engine; the default engine leaves MCP tools 'not initialized')" }),
		),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Per-leg wall-clock ceiling in ms; overrides the shared default (single mode)" }),
		),
		writeSet: Type.Optional(WriteSetSchema),
		outputContract: Type.Optional(Type.String({ description: "Installed output contract enforced for the single leg" })),
		tasks: Type.Optional(
			Type.Array(DelegateTaskItem, { description: "Independent tasks to run in parallel — give each a disjoint scope" }),
		),
		concurrency: Type.Optional(
			Type.Integer({ minimum: 1, description: `Max children to run at once (default ${d.RUN_LIMITS.maxConcurrency}; larger requests are clamped)` }),
		),
		async: Type.Optional(
			Type.Boolean({
				description:
					"Explicitly run in the background (already the DEFAULT in interactive sessions) — returns run ids at once; each result comes back to you automatically as a follow-up. Set false to force blocking.",
			}),
		),
		sync: Type.Optional(
			Type.Boolean({
				description:
					"Block this turn until the sub-agent(s) finish and return their results inline — only when you need them before your very next step. (Headless sessions already default to sync.)",
			}),
		),
	});

	// Canonicalise a delegate's requested model names to provider/id; return a clear
	// error (no spawn) when one is ambiguous/unknown so the supervisor retries with a
	// valid id instead of wasting a child on an unauthenticated provider.
	function resolveDelegateModels(params: Static<typeof DelegateParams>, ctx: ExtensionContext): string | undefined {
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
							const patch: { output?: string; detail?: string } = {};
							if (snap.output) patch.output = snap.output;
							// Mirrors the main subscription's onAgentProgress fallback: activity (e.g. the
							// "✉ from …" transparency tick) wins over a bare token count.
							if (snap.activity) patch.detail = snap.activity;
							else if (snap.tokens) patch.detail = `${compactTokens(snap.tokens)} tok`;
							if (patch.output !== undefined || patch.detail !== undefined) d.agentTree.update(nodeId, patch);
						},
						{ async: true },
						// STOP via `ac.signal` (hard abort) and STEER via the run-id key (soft redirect) —
						// both work for the supervisor (intercom `stop`/`steer`) and the f9 overlay (`x`/`s`),
						// for ANY persona (these are supervisor→child controls, not child tools).
					).run(runSpec, undefined, ac.signal, (steer) => {
						d.steerRegistry.set(nodeId, steer);
						d.agentTree.update(nodeId, { detail: "" }); // live now — clear the "queued" marker
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
		d.startPeek(); // arm the timed supervisor wakeup while this run is in flight (no-op if PI_PERSONA_PEEK_MS=0)
		return id;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to sub-agents — your default move whenever a task has independent, heavy, or parallel parts.",
			'Minimum call: { agent: "operator", task: "<self-contained brief: objective, scope, success signal>" } — everything else is optional.',
			"Fan out with tasks: [{ agent, task }, ...] (disjoint scopes), then synthesize the returns yourself. A persona may declaratively require a six-field `brief`, a structured output contract, or disjoint `writeSet` ownership; those calls fail before spawn when incomplete.",
			"In interactive sessions it runs in the BACKGROUND by default: you get run ids at once, stay free,",
			"and each result returns to you automatically as a follow-up — do NOT poll (`intercom wait` only when",
			"you need a result before your very next step; `sync: true` to block instead; headless runs default to sync).",
			"No fitting agent? Shape one on the fly: `operator` + `role` (extra system prompt) + `skills`.",
			"A `model` may be a loose name ('sonnet') — it resolves to YOUR provider's id; ambiguous names return",
			"candidates (or call `models`). Advanced knobs: name, tools, brief, outputContract, writeSet, isolation: \"worktree\", mcp, concurrency, tasks[].timeoutMs.",
		].join(" "),
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			d.lastCtx = ctx;
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
								const message = `delegate: this persona requires disjoint ownership for parallel writers; missing non-empty writeSet on ${missing.join(", ")}. Declare repository-relative paths, split the scopes, or serialize the writers.`;
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
				const ids = tasks.map((t, i) => {
					// Routed through specOf() (not a hand-rolled field list) so this, the interactive
					// DEFAULT delegate path, never drifts from the sync path's mapping — NP2's per-leg
					// `timeoutMs` (and any future knob) lands here for free instead of needing a second copy.
					const spec = specOf(t);
					return launchAsyncRun(t.agent, t.task, spec, nameFor(t, nameOffset + i), batchSlots);
				});
				const droppedNote = dropped > 0 ? ` ${dropped} task(s) beyond the max-children limit (${d.RUN_LIMITS.maxChildren}) were dropped.` : "";
				return {
					content: [
						{
							type: "text",
							text: `Launched ${ids.length} async runs in the background (${ids.join(", ")}) — keep working; each notifies on completion. /peek to watch.${droppedNote}`,
						},
					],
					details: { runIds: ids },
					isError: false,
				};
			}
			if (wantsAsync && params.agent && params.task) {
				const agent = params.agent;
				const task = params.task;
				// Use the canonical mapper here too: explicit `none`/`false` and future fields must
				// survive exactly as they do in fan-out and sync mode.
				const single = { ...params, agent, task };
				const runSpec = specOf(single);
				const id = launchAsyncRun(agent, task, runSpec, nameFor(single, asyncNameSequence++));
				return {
					content: [
						{
							type: "text",
							text: `Launched async run ${id} (${agent}) — runs in the background; you'll be notified on completion. /peek ${id} to watch.`,
						},
					],
					details: { runId: id },
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
			if (args.tasks && args.tasks.length > 0) {
				// Names live in the tree / final card — keep the call line itself minimal.
				return new Text(`${title}${theme.fg("accent", `parallel (${args.tasks.length})`)}`, 0, 0);
			}
			const agent = compactInlineText(args.agent ?? "?", { maxChars: 80 }) || "?";
			const preview = compactInlineText(args.task ?? "", { maxChars: 60 });
			// renderCall only fires in an interactive UI, where delegate runs in the BACKGROUND by
			// default — pass hasUI:true to the same wantsAsyncRun the execute path uses, so the common
			// (defaulted) background run still shows the tag; `sync: true` drops it.
			const asyncTag = wantsAsyncRun(args, true) ? theme.fg("warning", " async") : "";
			return new Text(`${title}${theme.fg("accent", agent)}${asyncTag}${theme.fg("dim", ` ${preview}`)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			// Safe: the delegate `execute` above always stores `{ views: DelegateView[] }` (sync,
			// single/parallel) or `{ runId | runIds }` (async) in `details`; the double cast just narrows
			// Pi's opaque `details` type to that known shape for rendering.
			const details = result.details as unknown as { views?: DelegateView[]; runId?: string; runIds?: string[] } | undefined;
			const views = details?.views ?? [];
			if (views.length === 0) {
				const first = result.content[0];
				const fallback = details?.runIds?.length
					? `async runs ${details.runIds.join(", ")}`
					: details?.runId
						? `async run ${details.runId}`
						: "(no output)";
				const text = first?.type === "text" ? first.text : fallback;
				return new Text(sanitizeTerminalText(text), 0, 0);
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

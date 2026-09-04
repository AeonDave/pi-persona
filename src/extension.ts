/**
 * pi-persona — the single ExtensionFactory wiring every layer to Pi.
 *
 * Loads personas/agents/teams on session_start; applies a persona (prompt +
 * model/thinking/tools) and gates delegation via the PersonaController; registers
 * the `delegate` and `council` tools, the unified agent tree + navigable overlay
 * (`f9` / `/agents`), the `f8` persona cycle, and the `/persona`, `/doctor`,
 * `/orchestrate`, `/peek` commands. Orchestration runs through the Strategy SDK on
 * one of two engine backends: InProcessEngine (the runtime default — steerable,
 * shares the session) or ChildProcessEngine (the correctness baseline — worktree
 * isolation; see docs/ARCHITECTURE.md).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentConfig } from "./agents/agent.ts";
import { installBridge, isBridgeMode } from "./bridge.ts";
import { resolveConfig } from "./core/config.ts";
import { type ContractDef } from "./core/contract.ts";
import {
	inspectLegacySeededSpines,
	migratePristineSeededDefaults,
	seedDefaults,
	type SeedMigrationOptions,
	type SeedMigrationResult,
	type SeedResult,
	type SpineLegacyIO,
	type SpineLegacyResult,
	type SpineLegacySelection,
} from "./core/seed.ts";
import { buildDelegationBrief } from "./core/brief.ts";
import { canDelegateTo, canFanOut, type RunLimits } from "./core/capabilities.ts";
import { fenceUntrusted } from "./core/fence.ts";
import { sanitizeDisplayLabel } from "./core/display-label.ts";
import { DelegationNudge, PersistenceNudge } from "./core/nudge.ts";
import { type EngineAdapterBroker } from "./engine/adapter.ts";
import { configuredModels, createBuildEngine, DEFAULT_ENGINE_FACTORIES, type EngineFactories } from "./extension/engine.ts";
import { installHooks, type HookHost } from "./extension/hooks.ts";
import {
	canDeliverPersonaNotification,
	expandDetailHint,
	sanitizePeerField,
	sendPersonaFollowUp,
	type PendingAsk,
} from "./extension/shared.ts";
export {
	agentNodeStatusForDelegate,
	boundExocomInboundBatch,
	canDeliverPersonaNotification,
	canonicalExocomTelemetryTargets,
	coachingDisabledHint,
	exocomInboundBatchSize,
	EXOCOM_INBOX_MAX,
	exocomInboundDisposition,
	expandDetailHint,
	failureDetails,
	fenceIntercomOutcome,
	formatCouncilCallLabel,
	formatExocomQueuedBatchToast,
	formatExocomQueuedToast,
	piPersonaToolErrorPatch,
	reconcileAnsweredAsk,
	sanitizeLabel,
	sanitizePeerField,
	sendPersonaFollowUp,
	shouldReportHeartbeatFailure,
	type ExocomQueuedToast,
	type PendingAsk,
} from "./extension/shared.ts";
import { installExocom } from "./exocom/install.ts";
import { parseExocomArgv } from "./exocom/activation.ts";
import { registerDelegateTool } from "./tools/delegate-tool.ts";
import { registerIntercomTool } from "./tools/intercom-tool.ts";
import { registerTimerTool } from "./tools/timer.ts";
import { registerCouncilTool } from "./tools/council.ts";
import { registerFlowTool } from "./tools/flow.ts";
import { registerModelsTool } from "./tools/models.ts";
import { type AsyncRun, AsyncRunTracker, boundCompletionSurface, buildCheckIn, buildPeekAlert, buildPeekDigest, buildRetentionOverflowNote, compactTokens, IdleCoalescingNotifier, PeekWatcher, renderCompletion } from "./engine/async.ts";
import { emptyUsage, type ToolEvent } from "./engine/stream.ts";
import { type BrokerHost, startBrokerHost } from "./bus/broker/host.ts";
import { brokerEndpoint } from "./bus/broker/paths.ts";
import { InProcessBus } from "./bus/inproc.ts";
import { loadContracts, loadDefinitions, loadPresets, loadTeams, type LoadResult, type ScopedDir } from "./loader.ts";
import { type FlowSpec, flowHash, parseFlow, verifyFlowRefs } from "./orchestration/flow.ts";
import { journalFileName, journalWriter, readJournal } from "./orchestration/flow-journal.ts";
import { runFlow } from "./orchestration/flow-run.ts";
import type { FlowOutcome } from "./orchestration/flow-run.ts";
import { type RosterMember, rosterNodeKeys, rosterSpec } from "./orchestration/roster.ts";
import type { AgentProgress, AgentStatus, SteerFn } from "./orchestration/sdk.ts";
import { knownParams, strategyNames } from "./orchestration/strategy.ts";
import { compactMemberResult } from "./orchestration/render.ts";
import type { AgentResult, FailureKind } from "./orchestration/types.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import { resolveStrategyName, runPersonaStrategy } from "./persona/orchestrate.ts";
import { expandCouncilPreset, type OrchestrationGrammar, type Persona } from "./persona/persona.ts";
import { bundledSpinePath, bundledWorkerSpinePath, readSpineFile, resolveSpine, type SpineSources } from "./persona/spine.ts";
import { readLastPersona, writeLastPersona } from "./persona/state.ts";
import { type AgentKind as TelemetryAgentKind, type AgentStatus as TelemetryAgentStatus } from "./telemetry/contract.ts";
import { TelemetryProducer, type TelemetryAgentInput } from "./telemetry/producer.ts";
import {
	type PersonaConfigStore,
	personaModels,
	readPersonaConfigs,
	withPersonaModels,
	writePersonaConfigs,
} from "./persona/config-store.ts";
import { shortModel } from "./tools/delegate.ts";
import { formatInbox } from "./tools/intercom.ts";
import { renderTimerFire, TimerScheduler, type TimerEntry } from "./core/timer.ts";
import { AgentOverlay } from "./ui/agent-overlay.ts";
import { type AddNodeInput, type AgentNode, type AgentTreeChange, AgentTree, type AgentNodeStatus, renderAgentTreeSummary } from "./ui/agent-tree.ts";
import { filterModels, ModelPicker, orderModelRefs } from "./ui/model-picker.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "./ui/presentation.ts";
import { ChildUsageLedger, formatPersonaCostStatus, formatUsage, PERSONA_COST_STATUS_KEY } from "./ui/usage.ts";

const RUN_LIMITS: RunLimits = {
	// A generous anti-runaway backstop, not a council-size cap: a declared ensemble
	// (e.g. 9 members × several rounds) must fit; the token budget is the real cost guard.
	maxChildren: 64,
	maxDepth: 2,
	maxConcurrency: 4,
	timeoutMs: 180_000, // IDLE window (resets on output) — kills a hung child, not a busy one
	budgetTokens: 1_000_000,
};

// A running async child that hasn't ADVANCED (output/turns/tokens) for this long is flagged
// "possibly stuck" — the soft stall signal. It is deliberately patient: a long scan, a big
// generation, or a blocking command shows no visible progress yet is perfectly healthy, so we wake
// the supervisor only after a genuinely long quiet spell. Purely advisory (no auto-abort); the idle
// watchdog (RUN_LIMITS.timeoutMs, reset on progress) + token budget are the always-on enforcing
// backstops, with the OPT-IN hard cap (PI_PERSONA_AGENT_MAX_MS, off by default) as an extra ceiling.
const STALL_FLAG_MS = 90_000;

const BUNDLED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "persona";

/** The Pi global agent dir, overridable via PI_AGENT_DIR (handy for tests/sandboxes). */
function userAgentDir(): string {
	return process.env.PI_AGENT_DIR || getAgentDir();
}
/** A spawned Pi resolves its global settings/auth from PI_CODING_AGENT_DIR, while pi-persona's
 * test/user override is PI_AGENT_DIR. Pin the child to the same resolved directory the in-process
 * createAgentSession receives, otherwise retry/provider settings diverge between engine backends. */
function childPiSettingsEnv(): Record<string, string> {
	return { PI_CODING_AGENT_DIR: userAgentDir() };
}
function personaDataDir(): string {
	return join(userAgentDir(), DATA_DIR);
}

/** Cross-process `contact_peer` roster (spec B7): scopes `brokerPeers` — the process-wide,
 *  pre-spawn registry keyed by handle (populated in `makeBrokerDeps`'s `register`, see
 *  below) — to the SAME per-engine group as the caller `self`, mirroring `engine/inproc.ts`'s
 *  per-engine-instance `peerLabels` map. `self`'s OWN recorded group is the source of truth
 *  here, NOT the wire's `group` argument the host would otherwise pass: the child's env
 *  carries no group (spec B6, the wire `register` frame stays minimal), so every wire group
 *  is "" and scoping by it would either always come back empty (this scope) or leak every
 *  concurrent run's peers into one flat list (the host's own default `group=""` scoping).
 *  `self` not found (not registered with `peers: true`) ⇒ empty roster, never a leak.
 *  Exported for direct unit/integration testing — `extension.ts`'s activation closure itself
 *  isn't a testable unit. */
export function listPeersForGroup(brokerPeers: ReadonlyMap<string, { label: string; group: string }>, self: string): Array<{ handle: string; label: string }> {
	const g = brokerPeers.get(self)?.group;
	if (g === undefined) return [];
	return [...brokerPeers.entries()]
		.filter(([handle, p]) => p.group === g && handle !== self)
		.map(([handle, p]) => ({ handle, label: p.label }));
}

interface CommandResultEntry {
	label: string;
	content: string;
	ok: boolean;
	failureKind?: FailureKind;
	error?: string;
}

/**
 * Keep the immediate operator-facing settlement toast and the semantic completion delivery on one
 * path. A supervisor-requested abort is terminal, but it is not an execution error: the tracker
 * classifies it as `stopped`, so the UI reports it at info level while the completion still reaches
 * the supervisor exactly once through the normal notifier.
 */
export function announceAsyncRunSettlement(
	run: AsyncRun,
	notify: ((message: string, level: "info" | "error") => void) | undefined,
	enqueue: (run: AsyncRun) => void,
): void {
	const id = compactInlineText(run.id, { maxChars: 80 }) || "run";
	const agent = compactInlineText(run.agent, { maxChars: 80 }) || "agent";
	if (run.status === "stopped") notify?.(`async run ${id} (${agent}) stopped`, "info");
	else if (run.status === "failed") notify?.(`async run ${id} (${agent}) failed: ${compactInlineText(run.error ?? "(no detail)", { maxChars: 240 })}`, "error");
	enqueue(run);
}

/** Agents actually IN FLIGHT: a RUNNING node with no children of its own. "Has a parent" is not the
 *  same as "is an agent" — a flow phase is a container that also has a parent, a root-level `async:`
 *  run is a leaf that has none, and a settled leg still sits in the tree until its root is torn
 *  down. Exported for direct unit testing (mirrors `listPeersForGroup` above). */
export function inFlightAgentCount(nodes: ReadonlyArray<{ id: string; parentId?: string | undefined; status: AgentNodeStatus }>): number {
	const parents = new Set(nodes.map((n) => n.parentId));
	return nodes.filter((n) => n.status === "running" && !parents.has(n.id)).length;
}

/** Per-invocation tree root ids. Two concurrent runs of the SAME strategy or flow (two
 *  `/orchestrate`s, the `flow` tool racing `/flow`) would otherwise share one deterministic root:
 *  the first to finish clears the other's stop/steer handles and removes its live subtree, leaving
 *  invisible orphans the overlay can no longer stop. The suffix carries no `/`, so `clearStops`'s
 *  `id === root || id.startsWith(root + "/")` scoping still covers exactly one run's subtree. */
export function makeRootIdAllocator(): (prefix: string) => string {
	let seq = 0;
	return (prefix) => {
		seq += 1;
		return `${prefix}#${seq}`;
	};
}

/** Bound a burst of blocking child questions before it becomes an automatic supervisor turn. Each
 * item is already individually fenced; the line-safe completion bound preserves those quote lines. */
export function renderPendingAskBatch(asks: readonly PendingAsk[]): string {
	return boundCompletionSurface(
		asks.map((ask) => ask.text).join("\n\n"),
		"blocking-ask batch truncated; pending questions remain available through intercom inbox",
	);
}

/** The engine constructors `buildEngine` builds through. Indirected via one object so the deps
 *  each backend is actually handed are observable: the child engine can be watched through a fake
 *  `pi` binary, but the in-process one — the DEFAULT backend — creates a real session that needs a
 *  live model and provider, so its wiring would otherwise have no witness at all. */
export type { EngineFactories } from "./extension/engine.ts";

/** Activation-scoped overrides. Pi's `ExtensionFactory` is `(pi) => void`, so it never passes a
 *  second argument and this is absent in production; a caller that does supply it substitutes
 *  for that activation ALONE — nothing process-wide to restore, and nothing left behind for the
 *  next one if the caller dies mid-way. */
export interface PiPersonaOptions {
	engineFactories?: EngineFactories;
	/** Activation-local test seam for read-only legacy-spine inspection. */
	spineLegacyIO?: SpineLegacyIO;
	/** Activation-local test seam for exact seeded-default migrations. */
	seedMigration?: SeedMigrationOptions;
	/** Activation-local argv seam for Pi's boolean `--exocom=<code>` compatibility parser. */
	exocomArgv?: readonly string[];
}

export default function piPersona(pi: ExtensionAPI, options: PiPersonaOptions = {}): void {
	// Cross-process broker (v0.5, spec B3): a child spawned with `PI_PERSONA_BUS` set is a
	// broker-connected sub-agent, not a supervisor — load ONLY the bridge (comm-plane tools +
	// inbound follow-ups) and skip the entire persona/delegate/orchestration surface. Checked
	// before anything else (even config resolution) so bridge mode can never be shadowed by
	// the fork-bomb guard's `PI_PERSONA_DISABLE=1` short-circuit below, or by any other early
	// return. `PI_PERSONA_BUS` unset (the default, and every existing test) ⇒ this branch never
	// runs — zero behavior change.
	if (isBridgeMode()) {
		pi.on("session_start", (_event, ctx) => installBridge(pi, ctx));
		return;
	}

	const config = resolveConfig(process.env);
	if (config.disabled) return;
	const exocomArgs = parseExocomArgv(options.exocomArgv ?? process.argv);
	const registerFollowUpRenderer = (customType: "pi-persona" | "exocom_received", label: string): void => {
		pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
			const raw = typeof message.content === "string"
				? message.content
				: message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
			const full = sanitizeTerminalText(raw);
			const preview = compactVisibleText(full, { maxLines: 4, maxLineChars: 100 });
			const firstLine = full.split("\n", 1)[0] ?? "";
			// External peer text is data and must never choose our UI chrome. Internal follow-ups own
			// their first status line; parse only that line and do not turn a healthy "0 failed" red.
			const isFailure = customType === "pi-persona"
				&& !/\b0 failed\b/i.test(firstLine)
				&& /\b(?:failed|failure|error|rejected|unresolved)\b/i.test(firstLine);
			const titleColor = isFailure ? "error" : customType === "exocom_received" ? "accent" : "success";
			const title = theme.fg(titleColor, theme.bold(label));
			if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", full || "(no output)")}`, outputPad, 0);
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, outputPad, 0);
		});
	};
	// These follow-ups remain complete in the model context, but the human-facing card starts as a
	// bounded digest. This is the central progressive-disclosure boundary for async completions and
	// external peer messages; expanding the card reveals the exact sanitized payload.
	registerFollowUpRenderer("pi-persona", "pi-persona · update");
	registerFollowUpRenderer("exocom_received", "exocom · inbound");
	pi.registerEntryRenderer("pi-persona-result", (entry, { expanded }, theme) => {
		const data = entry.data as CommandResultEntry;
		const full = sanitizeTerminalText(data.content || "(no output)");
		const cause = compactVisibleText(
			[data.failureKind, data.error].filter((part): part is string => !!part).join(" · "),
			{ maxLines: 1, maxLineChars: 80 },
		).text;
		const status = data.ok ? "complete" : "failed";
		const label = compactInlineText(data.label, { maxChars: 96 }) || "result";
		const title = theme.fg(data.ok ? "success" : "error", theme.bold(`${label} · ${status}${!data.ok && cause !== "(no output)" ? ` · ${cause}` : ""}`));
		if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", full)}`, 0, 0);
		const preview = compactVisibleText(full, { maxLines: 3, maxLineChars: 100 });
		const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
		return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
	});
	const appendCommandResult = (
		label: string,
		content: string,
		ok: boolean,
		meta: { failureKind?: FailureKind; error?: string } = {},
	): void => {
		pi.appendEntry("pi-persona-result", {
			label,
			content,
			ok,
			...(meta.failureKind ? { failureKind: meta.failureKind } : {}),
			...(meta.error ? { error: meta.error } : {}),
		} satisfies CommandResultEntry);
	};
	const enabledSpineRoles = (): SpineLegacySelection => ({
		supervisor: config.spine === "on",
		worker: config.spineLegs === "on",
	});
	const migrateSeededDefaults = (): SeedMigrationResult => {
		try {
			return migratePristineSeededDefaults(BUNDLED_DIR, personaDataDir(), options.seedMigration);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { migrated: [], installed: [], skipped: [], warnings: [`seed migration failed: ${message}`] };
		}
	};
	// Version migrations are byte-exact and independent of first-run seeding. Run before the first
	// definition discovery so a pristine old built-in can never become the active prompt for even
	// one turn; custom bytes, unknown files and unsafe filesystem shapes remain untouched.
	let seedMigration = migrateSeededDefaults();
	const refreshSeedMigration = (): SeedMigrationResult => {
		const current = migrateSeededDefaults();
		seedMigration = {
			migrated: [...new Set([...seedMigration.migrated, ...current.migrated])],
			installed: [...new Set([...seedMigration.installed, ...current.installed])],
			skipped: current.skipped,
			warnings: current.warnings,
		};
		return current;
	};
	const reportSeedMigration = (ctx: ExtensionContext, result: SeedMigrationResult): void => {
		if (result.migrated.length > 0) {
			const message = `pi-persona: upgraded ${result.migrated.length} exact pristine seeded default(s): ${result.migrated.join(", ")}`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else process.stderr.write(`${message}\n`);
		}
		if (result.installed.length > 0) {
			const message = `pi-persona: installed ${result.installed.length} required default dependency file(s): ${result.installed.join(", ")}`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else process.stderr.write(`${message}\n`);
		}
		for (const warning of result.warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else process.stderr.write(`${warning}\n`);
		}
	};
	// v1.8.1 rewrote the spine pair, but `on` deliberately prefers a seeded user copy and the
	// one-shot seed marker means a normal package upgrade never calls runSeed(). Detect ONLY the
	// exact v1.8.0 bytes and bypass them during `on` resolution; never rewrite a user-controlled file
	// automatically. Each role is inspected only when its selector consults that user-dir file.
	const activationLegacy = inspectLegacySeededSpines(
		personaDataDir(),
		enabledSpineRoles(),
		options.spineLegacyIO ?? {},
	);

	// The engine constructors THIS activation builds through (see PiPersonaOptions).
	const engineFactories = options.engineFactories ?? DEFAULT_ENGINE_FACTORIES;

	// The spine (docs/SPINE.md): the shared behavioral layer that sits between Pi's base prompt
	// and the persona body, with the WORKER variant leading every delegated leg's prompt (a leg
	// runs headless, so the supervisor text's "confirm before irreversible" would have it stall
	// on a user it does not have). Resolved ONCE — a layer that could change mid-conversation
	// would let two turns run under different rules; `/persona reload`, `seed`, and `restore` are
	// the deliberate refresh gestures. Off by default ⇒
	// both texts stay "" and every composition below is byte-identical to a pre-spine pi-persona.
	const spineSources = (): SpineSources => ({
		selector: config.spine,
		workerSelector: config.spineLegs,
		userPath: join(personaDataDir(), "spine.md"),
		bundledPath: bundledSpinePath(),
		workerUserPath: join(personaDataDir(), "spine.worker.md"),
		workerBundledPath: bundledWorkerSpinePath(),
		skipUserPath: spineLegacy.legacy.includes(join(personaDataDir(), "spine.md")),
		skipWorkerUserPath: spineLegacy.legacy.includes(join(personaDataDir(), "spine.worker.md")),
		read: readSpineFile,
	});
	let spineLegacy = activationLegacy;
	let spine = resolveSpine(spineSources());
	let spineText = spine.text ?? "";
	let workerSpineText = spine.worker ?? "";
	function resolveSpineNow(): void {
		spine = resolveSpine(spineSources());
		spineText = spine.text ?? "";
		workerSpineText = spine.worker ?? "";
	}
	function inspectEnabledLegacySpines(): SpineLegacyResult {
		const result = inspectLegacySeededSpines(
			personaDataDir(),
			enabledSpineRoles(),
			options.spineLegacyIO ?? {},
		);
		spineLegacy = result;
		resolveSpineNow();
		return result;
	}
	function refreshSpineAfterSeed(): void {
		inspectEnabledLegacySpines();
	}
	function currentSpineWarnings(): string[] {
		return [...new Set([...spineLegacy.warnings, ...(spine.warning ? [spine.warning] : [])])];
	}
	/** A spine was asked for and something did not supply one: say so, then carry on without it.
	 *  A missing prompt file must never cost the user their session. Emitted from the hook rather
	 *  than at resolve time — the factory has no `ctx` yet. */
	function reportSpineWarning(ctx: ExtensionContext): void {
		for (const warning of currentSpineWarnings()) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else process.stderr.write(`${warning}\n`);
		}
	}

	// exocom (opt-in, T9): `--exocom` is a per-invocation convenience alongside PI_PERSONA_EXOCOM
	// (config.exocom) — the flag declaration is inert unless either is on (see startExocom below).
	pi.registerFlag("exocom", {
		description: "Join Exocom for this workspace; use --exocom=Ab0T to join that workspace scope from another workspace (4-char case-sensitive Base62 code)",
		type: "boolean",
		default: false,
	});
	// `--persona <name>` — start with a persona active for this run, the CLI equivalent of
	// PI_PERSONA_DEFAULT (which it overrides). e.g. `pi --persona my-supervisor`.
	pi.registerFlag("persona", {
		description: "Start with this persona active for the run (e.g. `--persona my-supervisor`) — overrides PI_PERSONA_DEFAULT and the remembered persona.",
		type: "string",
		default: "",
	});

	let lastCtx: ExtensionContext | undefined;
	let disposed = false; // set on session_shutdown; gates late async-run callbacks of a torn-down instance
	let orchestrating = false; // re-entrancy guard for the mandatory input hook
	let processingDeferredOrchestration = false;
	const MAX_DEFERRED_ORCHESTRATIONS = 16;
	const deferredOrchestrations: Array<{ task: string; orchestration: OrchestrationGrammar }> = [];
	// A finished mandatory orchestration, injected (hidden) into the next turn's system prompt.
	type MandatoryOutcome = {
		label: string;
		output: string;
		ok: boolean;
		error?: string;
		failureKind?: FailureKind;
	};
	let pendingOrchestration: MandatoryOutcome | undefined;

	// The unified live tree of every in-flight agent — strategy cores, delegate
	// sub-agents, dynamic specialists — rendered as one sticky widget above the input.
	const agentTree = new AgentTree();
	// Explicit telemetry is the public observability seam consumed by pi-persona-flow. It is
	// session-scoped and starts only after persona + exocom reconciliation in session_start.
	let telemetry: TelemetryProducer | undefined;
	// callId → the open supervisor tool call. The NAME rides along because the close may happen at
	// the turn boundary rather than on a tool_result, where the event that carries it is gone.
	const telemetryToolStartedAt = new Map<string, { startedAt: number; name: string }>();
	// ask envelope id → who asked, so a supervisor reply is attributed to the child it answers
	// rather than to a "subagent" literal that names nobody. Bounded; cleared on teardown.
	const telemetryAskSenders = new Map<string, string>();
	const MAX_TRACKED_ASK_SENDERS = 256;
	type PendingExocomTelemetry = { id: string; sessionId: string; target: string; size: number };
	const telemetryExocomPending = new Map<string, PendingExocomTelemetry[]>();
	// …and the same for intercom: both channels open at tool_call and close at tool_result, so both are
	// left hanging when Pi resolves a call as "immediate" and never reaches a result.
	type PendingIntercomTelemetry = { kind: string; to: string; size: number; replyTo?: string };
	const telemetryIntercomPending = new Map<string, PendingIntercomTelemetry>();
	function telemetryKind(node: AgentNode): TelemetryAgentKind {
		if (node.kind) return node.kind;
		if (node.id.startsWith("flow:")) return "flow";
		if (node.id.startsWith("strategy:") || node.id.startsWith("council:")) return "council";
		if (node.id.startsWith("delegate:")) return "delegate";
		return "subagent";
	}
	function telemetryStatus(node: AgentNode): TelemetryAgentStatus {
		if (node.status !== "running") return node.status;
		// "queued" is a marker WE set (the seeded roster / a launched async run), so it is a real
		// state. Nothing ever sets `detail` to a waiting state — it is a usage string, an error, or
		// `toolActivity(name, args)`, which splices the tool's own argument text — so a substring
		// test for "waiting" could only ever fire on a leg that is running normally.
		if (node.detail?.trim().toLowerCase() === "queued") return "queued";
		return "running";
	}
	function telemetryAgent(node: AgentNode): TelemetryAgentInput {
		return {
			id: node.id,
			label: node.label,
			kind: telemetryKind(node),
			status: telemetryStatus(node),
			...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
			...(node.agent !== undefined ? { agent: node.agent } : {}),
			...(node.model !== undefined ? { model: node.model } : {}),
		};
	}
	/** Who an intercom action actually addresses. A REPLY carries no `to` — it goes back to the
	 *  child whose ask it answers — so the "subagent" literal it would otherwise fall back to names
	 *  nobody and merges every child's replies into one node. */
	function intercomRecipient(input: Record<string, unknown>, askId: string | undefined): string {
		const asked = askId !== undefined ? telemetryAskSenders.get(askId) : undefined;
		if (asked) return asked;
		return typeof input.to === "string" && input.to ? input.to : "subagent";
	}
	function publishAgentTool(agentId: string, event: ToolEvent): void {
		const callId = `${agentId}/${event.callId}`;
		telemetry?.publish(event.phase === "start" ? "tool.started" : "tool.finished", {
			callId,
			agentId,
			name: event.name,
			status: event.phase === "start" ? "running" : event.failed ? "failed" : "done",
		});
	}

	// node id → the last projection published for it. The tree emits "updated" whenever `detail` or
	// `output` moves — every streamed token delta — while the projection keeps neither, so an
	// unfiltered publish appends one byte-identical duplicate per chunk: a 5k-chunk leg writes
	// ~1.5MB of them and evicts genuine history from the producer's file budget.
	const lastAgentProjection = new Map<string, string>();
	function publishAgentTreeChange(change: AgentTreeChange): void {
		const producer = telemetry;
		if (!producer) return;
		if (change.type === "added") {
			lastAgentProjection.set(change.node.id, JSON.stringify(telemetryAgent(change.node)));
			producer.publishAgentAdded(telemetryAgent(change.node));
			return;
		}
		if (change.type === "updated") {
			const projection = JSON.stringify(telemetryAgent(change.node));
			if (lastAgentProjection.get(change.node.id) === projection) return;
			lastAgentProjection.set(change.node.id, projection);
			producer.publishAgentUpdated(change.node.id, telemetryAgent(change.node));
			return;
		}
		if (change.type === "removed") {
			for (const node of change.nodes) {
				lastAgentProjection.delete(node.id);
				const status = node.status === "running" ? "stopped" : telemetryStatus(node);
				producer.publish("agent.removed", { id: node.id, status });
			}
			return;
		}
		lastAgentProjection.clear();
		producer.publish("agent.cleared", {});
	}
	agentTree.onChange(publishAgentTreeChange);
	// Delegation nudge: watches the supervisor's OWN tool-result stream and reminds it to hand off
	// when it grinds heavy work by hand (config.nudge; gated to delegating personas at the hook).
	const delegationNudge = new DelegationNudge();
	// Persistence nudge: the counterweight — when a delegated leg comes back BLOCKED/UNKNOWN, remind
	// the supervisor not to bank a premature surrender (same config.nudge gate + hook as above).
	const persistenceNudge = new PersistenceNudge();
	// Every visible run (strategy, council, flow) gets its own tree root — see makeRootIdAllocator.
	const nextRootId = makeRootIdAllocator();
	// node id → abort that one agent (so the overlay can STOP a single sub-agent).
	const stopRegistry = new Map<string, () => void>();
	// A second stop is an explicit force-clear request. Keep the real cancel handle until the
	// run settles so that retry can signal the engine again before force-settling the UI tracker.
	const stopRequested = new Set<string>();
	const clearStops = (prefix: string): void => {
		for (const k of [...stopRegistry.keys()]) {
			if (k === prefix || k.startsWith(`${prefix}/`)) {
				stopRegistry.delete(k);
				stopRequested.delete(k);
			}
		}
	};
	function stopAgent(nodeId: string): boolean {
		const fn = stopRegistry.get(nodeId);
		if (!fn) return false;
		fn();
		stopRequested.add(nodeId);
		steerRegistry.delete(nodeId); // a hard-stopped agent is no longer steerable (mirror the strategy path)
		return true;
	}

	// node id → steer that one agent (in-process engine only): inject a live user message.
	const steerRegistry = new Map<string, SteerFn>();
	const clearSteers = (prefix: string): void => {
		for (const k of [...steerRegistry.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) steerRegistry.delete(k);
	};
	function steerAgent(nodeId: string, text: string): boolean {
		const fn = steerRegistry.get(nodeId);
		if (!fn || !text.trim()) return false;
		try {
			const delivered = fn(text);
			return delivered !== false;
		} catch {
			// the handle may point at a just-finished/disposed session — treat as "not steerable"
			return false;
		}
	}

	// The live count of agents in flight (leaf cores/legs), published as a status so a
	// custom UI (e.g. pi-1337's frame) can show "N agents" — covers strategy/council
	// cores too, which pi-1337's own delegate-only counter misses.
	function agentCount(): number {
		return inFlightAgentCount(agentTree.snapshot());
	}

	function renderAgentWidget(): void {
		if (!lastCtx) return;
		const empty = agentTree.isEmpty();
		try {
			const lines = empty ? undefined : renderAgentTreeSummary(agentTree.snapshot());
			lastCtx.ui.setWidget("persona-agents", lines, { placement: "aboveEditor" });
		} catch {
			/* cosmetic — the widget is best-effort */
		}
		try {
			lastCtx.ui.setStatus("persona-agents", empty ? undefined : String(agentCount()));
		} catch {
			/* cosmetic */
		}
	}
	agentTree.onChange(renderAgentWidget);

	// The navigable agent overlay (f9 / /agents): ↑↓ navigate, ⏎ drill into an
	// agent's output, esc back/close. Live — it re-renders as the tree changes.
	async function openAgentOverlay(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("agents: the navigable overlay needs the interactive TUI", "warning");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) =>
				new AgentOverlay(agentTree, tui, theme, () => done(undefined), stopAgent, steerAgent, (id) => steerRegistry.has(id)),
			// Near-fullscreen: watching sub-agents work is a reading surface, not a popup.
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
		);
	}
	let personas: Persona[] = [];
	let agents: AgentConfig[] = [];
	let teams: Record<string, RosterMember[]> = {};
	let contractDefs: Record<string, ContractDef> = {};
	let shadowed: Array<{ name: string; scope: string; path: string }> = [];
	let definitionCollisions: LoadResult["collisions"] = [];
	let definitionWarnings: string[] = [];
	let seedSourceCollisions: string[] = [];

	// Remembered selection lives in the persona data folder; only user gestures write it.
	const stateFile = config.stateFile ?? join(personaDataDir(), "state.json");
	const readRememberedPersona = (): string | undefined => {
		if (!config.persist) return undefined;
		return readLastPersona(stateFile);
	};
	const persist = (name: string | undefined): void => {
		if (config.persist) writeLastPersona(stateFile, name);
	};

	// Per-persona config (model assignments today, open-ended), indexed by persona name.
	const configFile = join(personaDataDir(), "config.json");
	const readConfigStore = (): PersonaConfigStore => {
		return readPersonaConfigs(configFile);
	};
	let personaConfigs: PersonaConfigStore = {};
	const modelsPrompted = new Set<string>(); // ask-once-per-session guard

	// Personas/agents load ONLY from the user dir (populated by `/persona seed|restore`) and the
	// project `.pi/agents`. The bundled defaults are a *seed source*, NOT a live discovery layer,
	// so a fresh install shows no personas until the user opts in — if you don't want them, or want
	// only your own, they simply aren't there. (Contracts/presets/teams keep a builtin layer below:
	// they aren't "personas" and are needed by strategies once personas are installed.)
	const defDirs = (cwd: string): ScopedDir[] => [
		{ path: join(personaDataDir(), "agents"), scope: "user" },
		{ path: join(cwd, ".pi", "agents"), scope: "project" },
		...config.extraDirs.map((p) => ({ path: p, scope: "env" })),
	];
	const teamFiles = (cwd: string): string[] => [
		join(BUNDLED_DIR, "teams.yaml"),
		join(personaDataDir(), "teams.yaml"),
		join(cwd, ".pi", "teams.yaml"),
	];
	const contractDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "contracts"), scope: "builtin" },
		{ path: join(personaDataDir(), "contracts"), scope: "user" },
		{ path: join(cwd, ".pi", "contracts"), scope: "project" },
	];
	const presetDirs = (cwd: string): ScopedDir[] => [
		{ path: join(BUNDLED_DIR, "presets"), scope: "builtin" },
		{ path: join(personaDataDir(), "presets"), scope: "user" },
		{ path: join(cwd, ".pi", "presets"), scope: "project" },
	];
	function reload(cwd: string): void {
		const result = loadDefinitions(defDirs(cwd));
		// Expand each persona's council `preset` into concrete strategy/roster/params.
		const presets = loadPresets(presetDirs(cwd));
		personas = result.personas.map((p) => (p.council?.preset ? { ...p, council: expandCouncilPreset(p.council, presets) } : p));
		agents = result.agents;
		shadowed = result.shadowed.map((f) => ({ name: f.name, scope: f.scope, path: f.path }));
		definitionCollisions = result.collisions;
		teams = loadTeams(teamFiles(cwd));
		const contractsLoad = loadContracts(contractDirs(cwd));
		contractDefs = contractsLoad.contracts;
		definitionWarnings = [...result.warnings, ...contractsLoad.warnings];
	}

	// Install the bundled defaults into the user's agent dir — this is the ONLY way personas/agents
	// become active (they are not a live builtin layer). `/persona seed` pulls in missing defaults,
	// `/persona restore` force-overwrites them back to the originals. First-run auto-install is
	// OPT-IN (PI_PERSONA_SEED=on) and happens once (guarded by the marker); by default nothing is
	// installed. Best-effort — never block startup on a write error.
	const seedMarker = (): string => join(personaDataDir(), ".pi-persona-seeded");
	function runSeed(force: boolean): SeedResult {
		const result = seedDefaults(BUNDLED_DIR, personaDataDir(), force);
		seedSourceCollisions = result.collisions ?? [];
		try {
			mkdirSync(personaDataDir(), { recursive: true });
			writeFileSync(seedMarker(), "pi-persona: bundled defaults seeded. Delete this file to re-seed on next start.\n");
		} catch {
			/* marker is best-effort */
		}
		return result;
	}

	function reportDefinitionCollisions(ctx: ExtensionContext): void {
		if (definitionCollisions.length > 0) {
			const names = definitionCollisions.map((collision) => collision.name).join(", ");
			const message = `pi-persona: ${definitionCollisions.length} persona/agent definition collision(s) were omitted: ${names}. Run /doctor for source paths.`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		if (definitionWarnings.length > 0) {
			const shown = definitionWarnings.slice(0, 5).join("; ");
			const more = definitionWarnings.length > 5 ? ` (+${definitionWarnings.length - 5} more)` : "";
			const message = `pi-persona: ${definitionWarnings.length} definition problem(s): ${shown}${more}. Run /doctor for details.`;
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
	}

	function reportSeedSourceCollisions(ctx: ExtensionContext, result: SeedResult): void {
		if (!result.collisions?.length) return;
		const message = `pi-persona: bundled persona/agent name collision(s): ${result.collisions.join(", ")}. The persona file was seeded; the ambiguous agent was omitted.`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else process.stderr.write(`${message}\n`);
	}

	const host: PersonaHost = {
		allToolNames: () => {
			try {
				return pi.getAllTools().map((t) => t.name);
			} catch {
				return [];
			}
		},
		knownAgents: () => agents.map((a) => a.name),
		setActiveTools: (names) => {
			try {
				pi.setActiveTools(names);
			} catch {
				/* ignore */
			}
		},
		getThinkingLevel: () => {
			try {
				return pi.getThinkingLevel();
			} catch {
				return "medium";
			}
		},
		setThinkingLevel: (level) => {
			try {
				// `level` is our local ThinkingLevel — a SUPERSET that may include an upstream level
				// (e.g. `max`) the installed pi predates. Cast to pi's parameter type at the boundary:
				// we can't statically match every pi version's union, and pi clamps an unknown level.
				// (A wider level only ever reaches here on a pi that actually supports it, since it
				// originates from pi.getThinkingLevel() — so the cast is safe in practice, not just typed.)
				pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
			} catch {
				/* clamped/ignored */
			}
		},
		getModel: () => {
			const m = lastCtx?.model;
			return m ? { provider: m.provider, id: m.id } : undefined;
		},
		findModel: (ref) => {
			try {
				const all = lastCtx?.modelRegistry.getAll() ?? [];
				const m = all.find((x) => `${x.provider}/${x.id}` === ref || x.id === ref);
				return m ? { provider: m.provider, id: m.id } : undefined;
			} catch {
				return undefined;
			}
		},
		setModel: async (handle: ModelHandle) => {
			try {
				const all = lastCtx?.modelRegistry.getAll() ?? [];
				const m = all.find((x) => x.provider === handle.provider && x.id === handle.id);
				if (m) await pi.setModel(m);
			} catch {
				/* keep current */
			}
		},
		setStatus: (text) => {
			try {
				lastCtx?.ui.setStatus("persona", text === undefined ? undefined : compactInlineText(text, { maxChars: 80 }));
			} catch {
				/* cosmetic */
			}
		},
		warn: (message) => {
			try {
				if (lastCtx?.hasUI) lastCtx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			} catch {
				/* cosmetic */
			}
		},
	};

	const controller = new PersonaController(host, config.delegateDefaultAllow);

	// The semantic comm plane (guardrails §4.2/§4.9): the in-process bus carries a child's
	// `contact_supervisor` messages to the supervisor (handle "supervisor"). Distinct from
	// engine events (runtime) and the agent-tree ProgressView (derived). The `intercom` tool
	// is the supervisor's read/reply side; coaching personas inject `contact_supervisor`.
	const SUPERVISOR = "supervisor";
	const bus = new InProcessBus();
	bus.register(SUPERVISOR);
	// Sub-agent output is UNTRUSTED: it surfaces to the supervisor as follow-up user turns and
	// tool results, so a sub-agent could otherwise inject "ignore your instructions…". Fence it
	// (core/fence.ts) in a tagged data block with a standing do-not-obey clause.
	/** Drain child→supervisor messages into a compact block for a sync tool result (push). */
	const drainBusBlock = (): string => {
		const msgs = bus.takeWhere(SUPERVISOR, (e) => !e.expectsReply);
		return msgs.length > 0 ? `\n\n📨 from sub-agents:\n${fenceUntrusted(formatInbox(msgs))}` : "";
	};

	// Shared "deliver to the supervisor only when it is idle" plumbing (see IdleCoalescingNotifier).
	// Both async-run completions and a child's blocking intercom ask flow through it so they reach
	// the supervisor as a fresh turn instead of stranding as orphaned "sticky" follow-ups in pi's
	// queue (pi only drains that queue from an active turn, one-at-a-time, skipping errored turns).
	const idleDelivery = {
		isIdle: () => canDeliverPersonaNotification(orchestrating, processingDeferredOrchestration, lastCtx?.isIdle?.() === true),
		deliver: (message: string) => sendPersonaFollowUp(pi, message),
		setTimer: (fn: () => void, ms: number) => {
			const h = setTimeout(fn, ms);
			h.unref?.();
			return h;
		},
		clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	// Async runs outlive the turn that launched them; on completion we surface the result(s) back as
	// ONE coalesced notice so the (idle) supervisor can react — e.g. retry a failure with another model.
	// With delegate now background-by-default (interactive), this is the COMMON delivery path, so the
	// premature-surrender counterweight must ride it too: a settled leg whose report carries a
	// [BLOCKED]/FLAG:UNKNOWN marker gets the persistence note appended (the sync tool_result hook can't
	// see a background run — its report arrives here as a fresh follow-up, not a delegate result).
	const completionNotifier = new IdleCoalescingNotifier<AsyncRun>({
		...idleDelivery,
		render: (runs) => {
			const report = renderCompletion(runs, fenceUntrusted, (t) => scanForSurrender(t));
			// Retention is a bound, not a promise: a fan-out wider than it settles more payloads than the
			// tracker can hold. Name the ids this very report points at that can no longer be fetched,
			// while their summaries are still in front of the supervisor — the alternative is a bare
			// "no retained async run" later, when nothing can be recovered.
			const dropped = runs.filter((r) => tracker.wasDropped(r.id)).map((r) => r.id);
			const overflow = buildRetentionOverflowNote(dropped, tracker.retention);
			return overflow ? boundCompletionSurface(`${report}\n\n${overflow}`) : report;
		},
	});
	// A child's blocking ask (decision/interview) — coalesced and idle-gated so it can't strand and
	// leave the child blocked until its 10-minute ask timeout (bus.ask default).
	const intercomNotifier = new IdleCoalescingNotifier<PendingAsk>({
		...idleDelivery,
		render: renderPendingAskBatch,
	});
	// Supervisor-armable alarms: when a timer expires it WAKES the session by routing the fire
	// through the same idle-delivery path (an idle delivery starts a fresh turn, so the supervisor
	// resumes on its own — no token-burning poll loop). Coalesced so several timers firing close
	// together arrive as one wake. The scheduler itself is the pure core kernel (src/core/timer.ts).
	const timerNotifier = new IdleCoalescingNotifier<TimerEntry>({
		...idleDelivery,
		render: (entries) => renderTimerFire(entries),
	});
	const timerScheduler = new TimerScheduler({
		now: () => Date.now(),
		setTimer: (fn, ms) => {
			const h = setTimeout(fn, ms);
			h.unref?.(); // never keep the host process alive just for a pending alarm
			return h;
		},
		clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		onFire: (entry) => timerNotifier.notify(entry),
	});
	const tracker = new AsyncRunTracker({ maxRetained: config.asyncRetain });
	// The premature-surrender counterweight rides the SAME kill switch as the by-hand nudge
	// (PI_PERSONA_NUDGE=off). Both completion surfaces — the background follow-up and `intercom wait` —
	// go through here, so "off" means off wherever a settled leg is collected, not just on the
	// synchronous tool_result hook.
	const scanForSurrender = (text: string): string | undefined => (config.nudge ? persistenceNudge.scan(text) : undefined);
	// A run id that is neither live nor retained has two very different meanings: it never existed, or
	// its payload was evicted under retention pressure. Only the second deserves an explanation — and a
	// bare "no such run" for a result the supervisor was just TOLD to fetch is exactly the dead end
	// this distinction exists to prevent.
	function missingRunMessage(id: string, display: string | undefined): string {
		if (!tracker.wasDropped(id)) return `No retained async run "${display}".`;
		return (
			`Async run "${display}" settled, but its full payload is gone: more runs settled than the ${tracker.retention}-run retention bound keeps. ` +
			"Its summary was delivered in the completion follow-up. Raise PI_PERSONA_ASYNC_RETAIN, or fan out in narrower waves and collect as you go, to keep more."
		);
	}
	// Turns the periodic peek from a poll into an exception signal: it surfaces a leg only when it
	// NEWLY crosses the stall window, so a healthy background run produces no wakeup at all.
	const peekWatcher = new PeekWatcher();
	tracker.onComplete((run) => {
		agentTree.update(`async:${run.id}`, { status: run.status, detail: run.error ?? run.result?.error ?? "" });
		agentTree.remove(`async:${run.id}`); // clear the async node from the tree on completion
		steerRegistry.delete(`async:${run.id}`); // its steer handle is dead once it finishes
		stopRegistry.delete(`async:${run.id}`); // …and so is its stop handle
		stopRequested.delete(`async:${run.id}`);
		if (disposed) return; // instance torn down — don't notify the next session or re-arm a cancelled timer
		// Immediate human feedback + one semantic completion. Explicit stops are informational,
		// while natural failures retain the error toast and every terminal result is still delivered.
		announceAsyncRunSettlement(
			run,
			lastCtx ? (message, level) => lastCtx?.ui.notify(message, level) : undefined,
			(settled) => completionNotifier.notify(settled),
		);
		if (tracker.running().length === 0) stopPeek(); // no live runs → stop the idle peek
	});

	// Event wake (default on): a child's BLOCKING question (decision/interview) surfaces at once
	// as a follow-up so the free (async) supervisor can answer it via the `intercom` tool.
	bus.onMessage((env) => {
		telemetry?.publish("message.received", {
			id: env.id,
			channel: "intercom",
			from: env.from,
			to: env.to,
			kind: env.kind,
			status: "delivered",
			expectsReply: env.expectsReply,
			size: Buffer.byteLength(env.text, "utf8"),
		});
		if (disposed || env.to !== SUPERVISOR || !env.expectsReply) return;
		// Only an ask can be replied to, so only an ask needs its sender remembered. Oldest first
		// out: a long session must not grow this without bound.
		if (telemetryAskSenders.size >= MAX_TRACKED_ASK_SENDERS) {
			const oldest = telemetryAskSenders.keys().next();
			if (!oldest.done) telemetryAskSenders.delete(oldest.value);
		}
		telemetryAskSenders.set(env.id, env.from);
		// Idle-gated so the ask reaches the (free) supervisor as a turn it can answer via the
		// intercom tool, rather than stranding mid-stream as a sticky follow-up.
		intercomNotifier.notify({
			askId: env.id,
			text: `[pi-persona] sub-agent ${sanitizeDisplayLabel(env.from)} needs a ${sanitizeDisplayLabel(env.kind, "decision", 32)}:\n\n${fenceUntrusted(env.text)}\n\nAnswer with the intercom tool: { action: "reply", askId: "${sanitizeDisplayLabel(env.id, "ask")}", message: "…" }`,
		});
	});

	// Peek watchdog (the timed supervisor wakeup, on by default — PI_PERSONA_PEEK_MS=0 opts out): while
	// async children run, a tick checks their progress but stays SILENT unless there is something to act
	// on, so a healthy background run never interrupts the supervisor. It wakes on two signals: a leg
	// that NEWLY looks stalled or an unread message (fast, PI_PERSONA_PEEK_MS granularity), and a routine
	// direction check-in (slow, PI_PERSONA_CHECKIN_MS) to catch a leg going off-track. Bounded: unref'd,
	// self-stops when no runs remain.
	let peekTimer: ReturnType<typeof setInterval> | undefined;
	// When the supervisor was last woken about a run (a stall alert, a message, or a routine check-in).
	// Gates the slow check-in cadence so it counts from the last time we actually surfaced something.
	let lastPeekAt = 0;
	function stopPeek(): void {
		if (peekTimer) {
			clearInterval(peekTimer);
			peekTimer = undefined;
		}
	}
	function startPeek(): void {
		// The two signals opt out independently: the fast stall/message wakeup follows PI_PERSONA_PEEK_MS,
		// the routine check-in follows PI_PERSONA_CHECKIN_MS. The carrier timer runs while EITHER is on and
		// ticks at the faster of the two (a disabled one is Infinity, so it never drives).
		const fastMs = config.peekEveryMs > 0 ? config.peekEveryMs : Number.POSITIVE_INFINITY;
		const checkMs = config.checkInEveryMs > 0 ? config.checkInEveryMs : Number.POSITIVE_INFINITY;
		const tickMs = Math.min(fastMs, checkMs);
		if (!Number.isFinite(tickMs) || peekTimer) return;
		lastPeekAt = Date.now(); // first routine check-in lands checkInEveryMs after the runs begin
		peekTimer = setInterval(() => {
			const runs = tracker.running();
			if (runs.length === 0) {
				stopPeek();
				return;
			}
			// Only peek a free, unqueued supervisor: an idle delivery triggers a clean turn, while a
			// busy one would pile up as a sticky follow-up. Skipping is safe — the next tick re-surfaces.
			if (!canDeliverPersonaNotification(orchestrating, processingDeferredOrchestration, lastCtx?.isIdle?.() === true) || lastCtx?.hasPendingMessages?.() === true) return;
			// The peek is NOT a poll. Two signals, two cadences: (1) the FAST wakeup (PI_PERSONA_PEEK_MS) —
			// a leg that NEWLY crossed the stall window, or an unread sub-agent message — the "is it dead or
			// wedged" check; (2) the SLOW routine check-in (PI_PERSONA_CHECKIN_MS) — a progress digest that
			// catches a leg going off-track (not stalled, just wrong) early. A healthy, quiet run between
			// check-ins produces no wakeup. Completions always arrive on their own (completionNotifier), and
			// the full status view stays on demand via `/peek`.
			const now = Date.now();
			const fast = config.peekEveryMs > 0;
			const stuck = fast ? peekWatcher.poll(runs, now, STALL_FLAG_MS) : [];
			// Drain only progress messages; blocking asks (expectsReply) are surfaced by the intercom
			// notifier and left for the `intercom inbox` tool — so peek never double-shows them.
			const unread = fast ? bus.takeWhere(SUPERVISOR, (e) => !e.expectsReply) : [];
			const dueCheckIn = config.checkInEveryMs > 0 && now - lastPeekAt >= config.checkInEveryMs;
			if (stuck.length === 0 && unread.length === 0 && !dueCheckIn) return; // healthy + quiet ⇒ stay silent
			const parts: string[] = [];
			if (stuck.length > 0) parts.push(buildPeekAlert(stuck, { now }));
			else if (dueCheckIn) parts.push(buildCheckIn(runs, { now, stallMs: STALL_FLAG_MS }));
			if (unread.length > 0) parts.push(`📨 from sub-agents:\n${fenceUntrusted(formatInbox(unread))}`);
			// Reset the check-in cadence only on a PROGRESS surfacing (a stall alert or a check-in), NOT on a
			// message-only wake — else a chatty child would postpone the routine off-track glance forever.
			if (stuck.length > 0 || dueCheckIn) lastPeekAt = now;
			try {
				sendPersonaFollowUp(pi, `[pi-persona] ${parts.join("\n\n")}`);
			} catch {
				/* ignore */
			}
		}, tickMs);
		peekTimer.unref?.();
	}

	// Cross-process broker (v0.5, spec B1-B7): on by default so MCP/worktree/child-engine
	// legs expose steer. Off (`PI_PERSONA_BROKER=off`) ⇒ none of the state below is ever
	// touched, so `deps.broker` stays undefined and the child engine spawns byte-identical
	// to pre-broker pi-persona.
	let brokerHost: BrokerHost | undefined;
	let brokerHostPromise: Promise<BrokerHost> | undefined;
	// Pre-spawn peer registrations (handle → {label, group}): the child's env carries no group
	// (the wire register frame stays minimal, spec B6), so the host's own client-populated
	// registry can't scope `list` per engine instance. `EngineAdapterBroker.register` is called
	// BEFORE spawn with the correct `group` (adapter.ts's per-engine-instance `peerGroup`) —
	// recorded here and used to override the host's default peer lookup, mirroring
	// `engine/inproc.ts`'s per-engine-instance `peerLabels` map (this one is process-wide since
	// several engine instances share the ONE host, each contributing its own group).
	const brokerPeers = new Map<string, { label: string; group: string }>();

	// Lazily starts the host on the FIRST child-engine build (fire-and-forget — the child's own
	// capped-backoff connect tolerates the brief startup race; `endpoint` is a pure function of
	// the session id, so it's known and handed to the child immediately, without waiting on the
	// listen to complete). Idempotent; a failed bind clears the promise so a later build retries.
	const expectedBrokerHandles = new Set<string>();
	const preHostSteers = new Map<string, string[]>();

	function ensureBrokerHost(endpoint: string): void {
		if (brokerHostPromise) return;
		if (process.platform !== "win32") {
			try {
				mkdirSync(dirname(endpoint), { recursive: true }); // POSIX sockets are filesystem paths
			} catch {
				/* best-effort — a failed mkdir surfaces as a listen error below */
			}
		}
		brokerHostPromise = startBrokerHost({
			bus,
			supervisorHandle: SUPERVISOR,
			endpoint,
			// Ignore the wire-supplied `group` (always "" — the child's env carries no group,
			// spec B6) — see `listPeersForGroup`'s header for why deriving scope from `self`'s
			// own `brokerPeers` entry is required instead.
			listPeersFor: (_group, self) => listPeersForGroup(brokerPeers, self),
		});
		brokerHostPromise.then(
			(h) => {
				brokerHost = h;
				for (const handle of expectedBrokerHandles) h.expect(handle);
				for (const [handle, texts] of preHostSteers) {
					for (const text of texts) h.steer(handle, text);
				}
				preHostSteers.clear();
			},
			(err) => {
				brokerHostPromise = undefined; // never started — a later build gets another chance
				if (process.env.PI_PERSONA_DEBUG) {
					process.stderr.write(`[pi-persona] broker: host failed to start on ${endpoint}: ${err instanceof Error ? err.message : String(err)}\n`);
				}
			},
		);
	}

	// The `EngineAdapterBroker` handed to every child-engine build while the flag is on (spec
	// B1-B7's supervisor-side face — register/unregister run directly against the LOCAL bus +
	// peer map; a remote child is otherwise indistinguishable from an in-process one, by
	// construction). `steerFrame` degrades to a silent no-op before the host has finished
	// starting or after the target has disconnected — "sends report undelivered", never a throw.
	// construction). `steerFrame` returns false when the handle was never expected (unknown /
	// already forgotten). An expected handle that has not connected yet buffers the steer
	// (host.expect + pending flush on register), so spawn→connect is reported as delivered.
	function makeBrokerDeps(ctx: ExtensionContext): EngineAdapterBroker {
		const sessionId = (ctx as ExtensionContext & { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ?? "";
		const endpoint = brokerEndpoint(sessionId);
		ensureBrokerHost(endpoint);
		return {
			endpoint,
			register: (info) => {
				bus.register(info.handle);
				expectedBrokerHandles.add(info.handle);
				if (info.peers) brokerPeers.set(info.handle, { label: info.label ?? info.handle, group: info.group ?? "" });
				brokerHost?.expect(info.handle);
			},
			unregister: (handle) => {
				expectedBrokerHandles.delete(handle);
				preHostSteers.delete(handle);
				brokerPeers.delete(handle);
				bus.unregister(handle);
				brokerHost?.forget(handle);
			},
			steerFrame: (handle, text) => {
				if (brokerHost) return brokerHost.steer(handle, text);
				if (!expectedBrokerHandles.has(handle) || !text.trim()) return false;
				const queued = preHostSteers.get(handle) ?? [];
				queued.push(text);
				preHostSteers.set(handle, queued);
				return true;
			},
		};
	}

	const exocom = installExocom(pi, {
		pi,
		get config() { return config; },
		get controller() { return controller; },
		get lastCtx() { return lastCtx; },
		get disposed() { return disposed; },
		get orchestrating() { return orchestrating; },
		get processingDeferredOrchestration() { return processingDeferredOrchestration; },
		get telemetry() { return telemetry; },
		get delegationNudge() { return delegationNudge; },
		exocomArgs,
		userAgentDir,
	});

	const innerBuildEngine = createBuildEngine(() => ({
		agents,
		contractDefs,
		controller,
		host,
		config,
		personaConfigs,
		lastCtx,
		workerSpineText,
		engineFactories,
		makeBrokerDeps,
		userAgentDir,
		childPiSettingsEnv,
		runLimits: RUN_LIMITS,
		bus,
		supervisorHandle: SUPERVISOR,
	}));
	const childUsage = new ChildUsageLedger();
	const publishPersonaCost = (): void => {
		try {
			lastCtx?.ui.setStatus(PERSONA_COST_STATUS_KEY, formatPersonaCostStatus(childUsage.pending()));
		} catch {
			/* cosmetic — the status is best-effort */
		}
	};
	const buildEngine: typeof innerBuildEngine = (signal, onProgress, engOpts) => {
		const engine = innerBuildEngine(signal, onProgress, engOpts);
		return {
			run: async (spec, progress, sig, steer) => {
				const result = await engine.run(spec, progress, sig, steer);
				childUsage.add(result.usage);
				publishPersonaCost();
				return result;
			},
		};
	};

	async function ensurePersonaModels(ctx: ExtensionContext, roster: RosterMember[]): Promise<void> {
		const persona = controller.activePersona?.name;
		if (!persona || !ctx.hasUI) return;
		// A member that carries its own inline model needs no picked one; dedupe by agent name.
		const pickable = [...new Set(roster.map((m) => rosterSpec(m)).filter((s) => !s.model).map((s) => s.agent))];
		if (pickable.length < 2) return; // an ensemble of one distinct core can't be diversified
		if (modelsPrompted.has(persona)) return;
		const configured = personaConfigs[persona]?.models ?? {};
		const missing = pickable.filter((a) => !configured[a]);
		if (missing.length === 0) return;
		const available = configuredModels(ctx);
		if (available.length < 2) return; // can't diversify with a single configured model
		modelsPrompted.add(persona);
		const options = orderModelRefs(available.map((m) => `${m.provider}/${m.id}`), ctx.model?.provider);
		const chosen: Record<string, string> = {};
		try {
			for (const agent of missing) {
				// Name the core's verticalization in the picker too: choosing a model for "the
				// Conservatore" is a different judgement than choosing one for a bare "balthasar".
				const purpose = corePurpose(agent);
				const title = `Model for "${agent}"${purpose ? ` (${purpose})` : ""}  ·  ${persona}`;
				// In the TUI: a searchable picker (type to filter) whose viewport follows the
				// selection — the built-in select can't scroll a hundreds-long provider list
				// usefully. Outside the TUI (RPC), fall back to the built-in select.
				const pick =
					ctx.mode === "tui"
						? await ctx.ui.custom<string | undefined>(
								(tui, theme, _kb, done) =>
									new ModelPicker(tui, theme, title, options, ctx.model?.provider, (ref) => done(ref)),
								{ overlay: true },
							)
						: await ctx.ui.select(title, options);
				if (pick) chosen[agent] = pick;
			}
		} catch {
			/* dismissed / no UI → fall back to the default model */
		}
		if (Object.keys(chosen).length === 0) return;
		// The picks are live for this session either way (the in-memory store is updated first), so
		// a save failure costs only PERSISTENCE — but silently swallowing it would re-prompt on every
		// future session with no hint that the assignment never landed.
		personaConfigs = withPersonaModels(personaConfigs, persona, chosen);
		try {
			writePersonaConfigs(configFile, personaConfigs);
		} catch (err) {
			ctx.ui.notify(
				`pi-persona: could not save the model assignment for "${persona}" (${err instanceof Error ? err.message : String(err)}) — it applies to this session only.`,
				"error",
			);
		}
	}

	/** A core's declared verticalization ("Propulsore", "Critico") — the lens it argues from, so a
	 *  council reads as a set of ROLES rather than a set of names. Absent for an agent that declares
	 *  none, and the label simply omits it. */
	function corePurpose(agent: string): string | undefined {
		return agents.find((a) => a.name === agent)?.purpose;
	}

	/** The session's own model, for a strategy's last-resort recovery of a member whose model broke
	 *  with no healthy peer to borrow from (`orchestration/model-retry.ts`). */
	function sessionModelDep(ctx: ExtensionContext): { sessionModel?: string } {
		return ctx.model ? { sessionModel: `${ctx.model.provider}/${ctx.model.id}` } : {};
	}

	// Each core's model beside its name: per-persona assignment → agent default → session.
	function coreModel(ctx: ExtensionContext, agent: string): string | undefined {
		const persona = controller.activePersona?.name;
		const configured = persona ? personaModels(personaConfigs, persona) : {};
		return configured[agent] ?? agents.find((a) => a.name === agent)?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	}
	function coreTelemetryMeta(ctx: ExtensionContext, agent: string): { agent: string; model?: string } {
		const model = coreModel(ctx, agent);
		return { agent, ...(model ? { model } : {}) };
	}
	function coreLabel(ctx: ExtensionContext, agent: string, key: string = agent): string {
		const short = shortModel(coreModel(ctx, agent));
		// `key` is the disambiguated node id (`agent` for a solo member, `agent · HINT` for a
		// roster-role one) — display that + what the core is FOR + the model, so a watcher reads the
		// council as roles rather than names, and three `reviewer` lenses still read distinctly.
		// A roster-ROLE member already carries its lens in `key` (`agent · HINT`) and its standing
		// purpose would repeat it — but a plain repeat (`melchior#2`) is the same core twice and
		// still wants its lens, so key off the role separator, not off `key !== agent`.
		const purpose = key.includes(" · ") ? undefined : corePurpose(agent);
		return [key, purpose, short].filter(Boolean).join(" · ");
	}

	// The SDK lifecycle callbacks that drive the unified tree for one strategy run rooted at
	// `rootId` — shared by /orchestrate, the council tool, and each flow phase. Seeds running
	// cores, flips ⏳ → ✓/✗ with usage, streams progress, and registers stop/steer handles.
	function strategyTreeDeps(ctx: ExtensionContext, rootId: string) {
		return {
			onAgentStart: (agent: string, abort: () => void, key?: string) => {
				stopRegistry.set(`${rootId}/${key ?? agent}`, abort);
			},
			onAgentSteerable: (agent: string, steer: SteerFn, key?: string) => {
				steerRegistry.set(`${rootId}/${key ?? agent}`, steer);
			},
			onAgentStatus: (agent: string, st: AgentStatus, result?: AgentResult, key?: string) => {
				const nodeKey = key ?? agent;
				const id = `${rootId}/${nodeKey}`;
				if (st === "running") {
					// detail "" clears the seeded "queued" marker — this core is actually live now.
					agentTree.add({ id, label: coreLabel(ctx, agent, nodeKey), parentId: rootId, status: "running", kind: "subagent", ...coreTelemetryMeta(ctx, agent), detail: "" });
					return;
				}
				stopRegistry.delete(id);
				steerRegistry.delete(id);
				const patch: { status: AgentNodeStatus; detail?: string; output?: string } = { status: st };
				if (result) {
					const u = formatUsage(result.usage);
					if (u) patch.detail = u;
					if (result.output || result.structured) patch.output = compactMemberResult(result);
				}
				agentTree.update(id, patch);
			},
			onAgentProgress: (agent: string, p: AgentProgress, key?: string) => {
				const id = `${rootId}/${key ?? agent}`;
				if (p.toolEvent) publishAgentTool(id, p.toolEvent);
				const patch: { output?: string; detail?: string } = {
					detail: p.activity || (p.tokens ? `${compactTokens(p.tokens)} tok` : ""),
				};
				if (p.output) patch.output = p.output;
				agentTree.update(id, patch);
			},
		};
	}

	function strategySpawnGate(): { canSpawn?: (agent: string) => boolean } {
		const caps = controller.capabilities;
		return caps ? { canSpawn: (agent) => canDelegateTo(caps, agent) } : {};
	}

	// Run a persona strategy with the unified tree wired in: assign models on first run,
	// seed the roster (cores show by name at once), flip ⏳ → ✓/✗ live, clear when done.
	async function runStrategyVisible(
		ctx: ExtensionContext,
		orch: OrchestrationGrammar,
		task: string,
		idPrefix: string,
		signal?: AbortSignal,
	) {
		const label = resolveStrategyName(orch) ?? "strategy";
		const roster = orch.roster ? (teams[orch.roster] ?? []) : [];
		await ensurePersonaModels(ctx, roster);
		const rootId = nextRootId(`${idPrefix}:${label}`);
		agentTree.add({ id: rootId, label, status: "running", kind: "council" });
		// Seed the whole roster at once (cores show by name immediately); "queued" until the
		// engine actually starts each one — an honest view under the concurrency limit.
		const seedKeys = rosterNodeKeys(roster);
		roster.forEach((m, i) => {
			const a = rosterSpec(m).agent;
			const key = seedKeys[i] ?? a;
			agentTree.add({ id: `${rootId}/${key}`, label: coreLabel(ctx, a, key), parentId: rootId, status: "running", kind: "subagent", ...coreTelemetryMeta(ctx, a), detail: "queued" });
		});
		try {
			// The signal goes to the STRATEGY as well as the engine: a multi-round strategy checks it
			// cooperatively between rounds, so an aborted run stops convening instead of running every
			// remaining round against an already-cancelled engine (docs/STRATEGIES.md).
			const result = await runPersonaStrategy(orch, task, { engine: buildEngine(signal), teams, limits: RUN_LIMITS, ...sessionModelDep(ctx), ...(signal ? { signal } : {}), ...strategyTreeDeps(ctx, rootId), ...strategySpawnGate() });
			agentTree.update(rootId, { status: signal?.aborted ? "stopped" : result?.ok === false ? "failed" : "done" });
			return result ?? undefined;
		} catch (error) {
			agentTree.update(rootId, { status: signal?.aborted ? "stopped" : "failed" });
			throw error;
		} finally {
			clearStops(rootId);
			clearSteers(rootId);
			agentTree.remove(rootId);
		}
	}

	// ── flows (v0.5): a DAG over strategies, discovered as *.flow.json ────────────
	const flowDirs = (cwd: string): string[] => [
		join(BUNDLED_DIR, "flows"),
		join(personaDataDir(), "flows"),
		join(cwd, ".pi", "flows"),
	];
	function listFlows(cwd: string): string[] {
		const names = new Set<string>();
		for (const dir of flowDirs(cwd)) {
			try {
				for (const f of readdirSync(dir)) if (f.endsWith(".flow.json")) names.add(f.replace(/\.flow\.json$/, ""));
			} catch {
				/* dir absent */
			}
		}
		return [...names].sort();
	}
	function loadFlow(cwd: string, name: string): ReturnType<typeof parseFlow> | undefined {
		// Later dirs win (project > user > builtin) — keep the last readable file's content.
		let found: string | undefined;
		for (const dir of flowDirs(cwd)) {
			try {
				found = readFileSync(join(dir, `${name}.flow.json`), "utf8");
			} catch {
				/* not here */
			}
		}
		if (found === undefined) return undefined;
		return parseFlow(found);
	}

	// Run a flow's DAG with the unified tree (phases as nodes, cores beneath) + journaled
	// resume: a prior run's journal (keyed by flow@hash) skips already-done phases; the
	// journal is cleared on a fully-successful run.
	async function runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, baseTask: string, signal?: AbortSignal): Promise<FlowOutcome> {
		const hash = flowHash(spec);
		const journalDir = join(personaDataDir(), "flows");
		try {
			mkdirSync(journalDir, { recursive: true });
		} catch {
			/* best effort */
		}
		const journalPath = join(journalDir, journalFileName(spec)); // encodes the name — any name is storable
		const resume = readJournal(journalPath, hash);

		const rosterMembers = spec.phases.flatMap((p) => (p.roster ? (teams[p.roster] ?? []) : []));
		await ensurePersonaModels(ctx, rosterMembers);

		const flowRoot = nextRootId(`flow:${spec.name}`);
		agentTree.add({ id: flowRoot, label: `flow ${spec.name}`, status: "running", kind: "flow" });
		for (const p of spec.phases) {
			const pid = `${flowRoot}/${p.id}`;
			const node: AddNodeInput = { id: pid, label: `${p.id} · ${p.strategy}`, parentId: flowRoot, status: resume[p.id] ? "done" : "running", kind: "phase" };
			if (resume[p.id]) node.detail = "resumed";
			agentTree.add(node);
		}
		try {
			// Yield so a concurrent flow can seed its own tree before we fail-closed on refs —
			// the check still runs BEFORE any phase/engine work.
			await Promise.resolve();
			const refs = verifyFlowRefs(spec, {
				strategies: strategyNames(),
				teams: new Set(Object.keys(teams)),
			});
			if (!refs.ok) {
				agentTree.update(flowRoot, { status: "failed", detail: refs.error });
				const failed: FlowOutcome = {
					ok: false,
					results: {},
					output: refs.error,
					error: refs.error,
					failureKind: "contract",
				};
				if (spec.phases[0]?.id) failed.failedPhase = spec.phases[0].id;
				return failed;
			}
			const outcome = await runFlow(spec, baseTask, {
				hash,
				resume,
				...(signal ? { signal } : {}),
				journal: journalWriter(journalPath),
				onPhase: (id, status, result) => {
					const patch: { status: AgentNodeStatus; output?: string; detail?: string } = {
						status: status === "running" ? "running" : status === "done" ? "done" : "failed",
					};
					if (result?.output) patch.output = result.output;
					if (result?.error) patch.detail = result.error;
					agentTree.update(`${flowRoot}/${id}`, patch);
				},
				runPhase: async ({ phase, task }) => {
					const pid = `${flowRoot}/${phase.id}`;
					const roster = phase.roster ? (teams[phase.roster] ?? []) : [];
					const seedKeys = rosterNodeKeys(roster);
					roster.forEach((m, i) => {
						const a = rosterSpec(m).agent;
						const key = seedKeys[i] ?? a;
					agentTree.add({ id: `${pid}/${key}`, label: coreLabel(ctx, a, key), parentId: pid, status: "running", kind: "subagent", ...coreTelemetryMeta(ctx, a), detail: "queued" });
					});
					const orch: OrchestrationGrammar = { mode: "strategy", strategy: phase.strategy, params: phase.params ?? {} };
					if (phase.roster) orch.roster = phase.roster;
					const r = await runPersonaStrategy(orch, task, {
						engine: buildEngine(signal),
						teams,
						limits: RUN_LIMITS,
						...sessionModelDep(ctx),
						...(signal ? { signal } : {}), // cooperative per-round abort inside the phase's strategy, not just the engine
						...strategyTreeDeps(ctx, pid),
						...strategySpawnGate(),
					});
					return r ?? { agent: phase.id, output: `unknown strategy: ${phase.strategy}`, usage: emptyUsage(), ok: false, error: "unknown strategy" };
				},
				// Checkpoint gate: only an explicit interactive approval may release dependents.
				// Headless, dismissal, and UI failure all reject: a human checkpoint is a safety
				// boundary, never an informational prompt. Approval is journaled for resume.
				approveGate: async (phase, result) => {
					if (!ctx.hasUI) return false;
					const preview = result.output.replace(/\s+/g, " ").slice(0, 160);
					try {
						const pick = await ctx.ui.select(`Checkpoint "${phase.id}" — approve and continue the flow?\n${preview}`, ["Approve", "Reject"]);
						return pick === "Approve";
					} catch {
						return false;
					}
				},
			});
			if (outcome.ok) {
				try {
					rmSync(journalPath, { force: true }); // clean journal once the whole flow succeeds
				} catch {
					/* ignore */
				}
			}
			agentTree.update(flowRoot, { status: signal?.aborted ? "stopped" : outcome.ok ? "done" : "failed" });
			return outcome;
		} catch (error) {
			agentTree.update(flowRoot, { status: signal?.aborted ? "stopped" : "failed" });
			throw error;
		} finally {
			clearStops(flowRoot);
			clearSteers(flowRoot);
			agentTree.remove(flowRoot);
		}
	}

	// Search/list available models (provider/id), session provider first (★).
	function searchModels(ctx: ExtensionContext, query?: string): { lines: string[]; total: number; capped: boolean } {
		const session = ctx.model?.provider;
		const isSession = (ref: string): boolean => session !== undefined && ref.startsWith(`${session}/`);
		const all = configuredModels(ctx).map((m) => `${m.provider}/${m.id}`);
		const filtered = orderModelRefs(filterModels(all, query ?? ""), session);
		const cap = 40;
		const lines = filtered.slice(0, cap).map((r) => `${isSession(r) ? "★ " : "  "}${r}`);
		return { lines, total: filtered.length, capped: filtered.length > cap };
	}

	// The per-turn delegation brief (core/brief.ts): live roster + standing hand-off default,
	// appended to the TAIL of the system prompt each turn — where a decayed top-of-prompt
	// persona line has no force, and regenerated from the live registry so it cannot desync.
	// Capability-aware: a persona that denies `delegate` gets none, and the agent list is
	// filtered to the persona's allowed targets.
	function delegationBrief(ctx: ExtensionContext): string | undefined {
		const caps = controller.capabilities;
		if (caps && !canFanOut(caps)) return undefined;
		const targets = caps ? agents.filter((a) => canDelegateTo(caps, a.name)) : agents;
		const delegation = controller.activePersona?.delegation;
		const teamAgents: Record<string, string[]> = {};
		for (const [name, members] of Object.entries(teams)) teamAgents[name] = members.map((m) => rosterSpec(m).agent);
		return buildDelegationBrief({
			agents: targets.map((a) => ({
				name: a.name,
				...(a.description ? { description: a.description } : {}),
				...(a.tools ? { tools: a.tools } : {}),
				...(a.excludeTools ? { excludeTools: a.excludeTools } : {}),
				...(a.mcp ? { mcp: true } : {}),
				...(a.isolation ? { isolation: a.isolation } : {}),
			})),
			teams: teamAgents,
			flows: listFlows(ctx.cwd),
			standing: controller.activePersona !== undefined,
			// Interactive sessions delegate in the background by default; headless (`pi -p`)
			// stays sync (the single turn must carry the result) — mirror that in the copy.
			asyncDefault: ctx.hasUI === true,
			...(delegation?.requireBrief !== undefined ? { requireBrief: delegation.requireBrief } : {}),
			...(delegation?.outputContract ? { outputContract: delegation.outputContract } : {}),
			...(delegation?.requireDisjointWrites !== undefined ? { requireDisjointWrites: delegation.requireDisjointWrites } : {}),
			...(delegation?.requireFreshVerification !== undefined ? { requireFreshVerification: delegation.requireFreshVerification } : {}),
			// The FULL registry count (pre capability-filter): lets the brief tell "nothing installed
			// yet (seed)" from "this persona's allowlist filtered every target away (widen it)" when
			// `targets` came back empty — otherwise a restrictive persona gets the fresh-install lie.
			installedCount: agents.length,
		});
	}

	// `resolveStrategyName` fails loudly on a grammar that names a MODE without naming what to run
	// (`mode: strategy` with no `strategy:`, `mode: flow` with no `flow:`) — a persona-file error,
	// not a runtime one. Every entry point that calls it as a guard renders this instead of letting
	// it propagate out of a hook or command handler.
	function personaGrammarError(err: unknown): string {
		const who = controller.activePersona?.name ?? "(none)";
		return `pi-persona: persona "${who}" has an invalid orchestration — ${err instanceof Error ? err.message : String(err)}`;
	}

	function doctorReport(): string {
		const lines: string[] = [];
		lines.push(`pi-persona — active: ${controller.activePersona?.label ?? "none"}`);
		lines.push(`engine backend: ${config.engine === "child" ? "child-process" : "in-process"}`);
		const spineRole = (selector: string, source: string | undefined): string => {
			if (!selector) return "off";
			return source ? `${selector} -> ${source}` : `${selector} -> degraded`;
		};
		lines.push(`spine: supervisor=${spineRole(config.spine, spine.source)}; worker=${spineRole(config.spineLegs, spine.workerSource)}`);
		if (spineLegacy.legacy.length > 0) {
			lines.push(`spine legacy bypass: ${spineLegacy.legacy.join(", ")} (pristine v1.8.0 left untouched; using current bundle — /persona restore updates disk)`);
		}
		for (const warning of currentSpineWarnings()) {
			lines.push(warning.startsWith("spine legacy inspection warning:") ? warning : `spine warning: ${warning}`);
		}
		if (seedMigration.migrated.length > 0) {
			lines.push(`seed migration: upgraded ${seedMigration.migrated.join(", ")} (exact known-pristine defaults only)`);
		}
		if (seedMigration.installed.length > 0) {
			lines.push(`seed migration dependencies: installed ${seedMigration.installed.join(", ")}`);
		}
		for (const warning of seedMigration.warnings) {
			lines.push(warning.startsWith("seed migration") ? warning : `seed migration warning: ${warning}`);
		}
		lines.push(`personas (${personas.length}): ${personas.map((p) => p.name).join(", ") || "—"}`);
		lines.push(`agents (${agents.length}): ${agents.map((a) => a.name).join(", ") || "—"}`);
		if (definitionCollisions.length > 0) {
			lines.push(`definition collisions (${definitionCollisions.length}, omitted): ${definitionCollisions.map((collision) => collision.name).join(", ")}`);
			for (const collision of definitionCollisions) {
				lines.push(`  - ${collision.name}: persona=${collision.persona.path}; agent=${collision.agent.path}`);
			}
		}
		if (definitionWarnings.length > 0) {
			lines.push(`definition warnings (${definitionWarnings.length}):`);
			for (const w of definitionWarnings) lines.push(`  - ${w}`);
		}
		if (seedSourceCollisions.length > 0) {
			lines.push(`bundled seed collisions (${seedSourceCollisions.length}): ${seedSourceCollisions.join(", ")}`);
		}
		const teamNames = Object.keys(teams);
		lines.push(`teams (${teamNames.length}): ${teamNames.join(", ") || "—"}`);
		const flows = lastCtx ? listFlows(lastCtx.cwd) : [];
		lines.push(`flows (${flows.length}): ${flows.join(", ") || "—"}`);
		const contractNames = [...new Set(["default", ...Object.keys(contractDefs)])];
		lines.push(`contracts (${contractNames.length}): ${contractNames.join(", ")}`);
		if (shadowed.length > 0) {
			lines.push("shadowed (lower-precedence, overridden):");
			for (const s of shadowed) lines.push(`  - ${s.name} [${s.scope}] ${s.path}`);
		}
		const caps = controller.capabilities;
		if (caps) {
			lines.push(`effective-capabilities: tools=${caps.tools.size}, delegate-targets=${caps.delegateTargets.size}, canFanOut=${canFanOut(caps)}`);
		}
		lines.push(`run limits: children≤${RUN_LIMITS.maxChildren}, concurrency≤${RUN_LIMITS.maxConcurrency}, timeout=${RUN_LIMITS.timeoutMs}ms`);
		lines.push("strategies:");
		for (const name of strategyNames()) {
			const schema = knownParams(name);
			const entries = schema
				? Object.entries(schema).map(([k, p]) => `${k} (${p.type}${p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : ""})`)
				: [];
			const params = entries.length > 0 ? entries.join(", ") : "(no params)";
			lines.push(`  - ${name}: ${params}`);
		}
		const coaching = controller.activePersona?.coaching ?? false;
		const peek = config.peekEveryMs > 0 ? `${config.peekEveryMs}ms` : "off";
		const checkIn = config.checkInEveryMs > 0 ? `${config.checkInEveryMs}ms` : "off";
		lines.push(`comm plane: coaching=${coaching ? "on (children get contact_supervisor)" : "off"}, peek-watchdog=${peek}, check-in=${checkIn}, bus-peers=${bus.participants().length}`);
		if (config.broker) {
			const status = brokerHost ? brokerHost.endpoint : brokerHostPromise ? "(starting…)" : "(not started — no child-engine build yet)";
			lines.push(`broker: on — endpoint ${status}, connected children: ${brokerHost?.connectedHandles().length ?? 0}`);
		}
		return lines.join("\n");
	}

	const hookHost: HookHost = {
		get config() { return config; },
		get controller() { return controller; },
		get personaHost() { return host; },
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		get disposed() { return disposed; },
		set disposed(value) { disposed = value; },
		get orchestrating() { return orchestrating; },
		set orchestrating(value) { orchestrating = value; },
		get processingDeferredOrchestration() { return processingDeferredOrchestration; },
		set processingDeferredOrchestration(value) { processingDeferredOrchestration = value; },
		get pendingOrchestration() { return pendingOrchestration; },
		set pendingOrchestration(value) { pendingOrchestration = value; },
		MAX_DEFERRED_ORCHESTRATIONS,
		deferredOrchestrations,
		get telemetry() { return telemetry; },
		set telemetry(value) { telemetry = value; },
		telemetryToolStartedAt,
		telemetryExocomPending,
		telemetryIntercomPending,
		lastAgentProjection,
		telemetryAskSenders,
		agentTree,
		telemetryAgent,
		delegationNudge,
		persistenceNudge,
		completionNotifier,
		intercomNotifier,
		timerNotifier,
		timerScheduler,
		peekWatcher,
		stopPeek,
		stopRegistry,
		stopRequested,
		steerRegistry,
		get brokerHost() { return brokerHost; },
		set brokerHost(value) { brokerHost = value as typeof brokerHost; },
		get brokerHostPromise() { return brokerHostPromise; },
		set brokerHostPromise(value) { brokerHostPromise = value as typeof brokerHostPromise; },
		brokerPeers,
		get spineText() { return spineText; },
		delegationBrief,
		get agents() { return agents; },
		get personas() { return personas; },
		reload,
		readConfigStore,
		get personaConfigs() { return personaConfigs; },
		set personaConfigs(value) { personaConfigs = value; },
		readRememberedPersona,
		runSeed,
		seedMarker,
		personaDataDir,
		reportSeedSourceCollisions,
		refreshSpineAfterSeed,
		inspectEnabledLegacySpines,
		reportSeedMigration,
		get seedMigration() { return seedMigration; },
		reportSpineWarning,
		reportDefinitionCollisions,
		userAgentDir,
		loadFlow,
		runFlowVisible,
		runStrategyVisible,
		personaGrammarError,
		intercomRecipient,
		idleDelivery,
		drainBusBlock,
		childUsage,
		publishPersonaCost,
	};
	installHooks(pi, hookHost, exocom);

	registerDelegateTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		controller,
		get agents() { return agents; },
		buildEngine,
		agentTree,
		nextRootId,
		tracker,
		config: { ledgerV2: config.ledgerV2 },
		RUN_LIMITS,
		publishAgentTool,
		stopRegistry,
		steerRegistry,
		stopRequested,
		ensurePersonaModels,
		clearStops,
		clearSteers,
		drainBusBlock,
		startPeek,
		childUsage,
		publishPersonaCost,
	});

// ── f8 cycle ────────────────────────────────────────────────────────────────
	const cycleShortcut = {
		description: "Cycle persona (pi-persona)",
		handler: async (ctx: ExtensionContext) => {
			lastCtx = ctx;
			if (personas.length === 0) return;
			const current = controller.activePersona;
			const idx = current ? personas.findIndex((p) => p.name === current.name) : -1;
			const next = idx + 1;
			if (next >= personas.length) {
				await controller.deactivate();
				persist(undefined);
			} else {
				await controller.activate(personas[next]!);
				persist(personas[next]!.name);
			}
			await exocom.onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
		},
	};
	type KeyId = Parameters<ExtensionAPI["registerShortcut"]>[0];
	// PI_PERSONA_KEY is user-supplied; an unrecognised key must not break extension load. Try it,
	// and fall back to the default "f8" if Pi rejects it.
	try {
		pi.registerShortcut(config.keybinding as KeyId, cycleShortcut);
	} catch {
		try {
			pi.registerShortcut("f8" as KeyId, cycleShortcut);
		} catch {
			/* no shortcut available — /persona still works */
		}
	}

	registerIntercomTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		tracker,
		completionNotifier,
		intercomNotifier,
		controller,
		bus,
		SUPERVISOR,
		STALL_FLAG_MS,
		missingRunMessage,
		stopAgent,
		steerAgent,
		steerRegistry,
		stopRequested,
		drainBusBlock,
		scanForSurrender,
		get disposed() { return disposed; },
		childUsage,
		publishPersonaCost,
	});

	registerTimerTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		timerScheduler,
	});

	registerCouncilTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		controller,
		get personas() { return personas; },
		runStrategyVisible,
		drainBusBlock,
		childUsage,
		publishPersonaCost,
	});

	registerFlowTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		loadFlow,
		listFlows,
		runFlowVisible,
		childUsage,
		publishPersonaCost,
	});

// ── f9: navigable agent overlay ──────────────────────────────────────────────
	pi.registerShortcut("f9" as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Open the navigable agent tree (pi-persona)",
		handler: async (ctx) => {
			lastCtx = ctx;
			await openAgentOverlay(ctx);
		},
	});
	pi.registerCommand("agents", {
		description: "Open the navigable agent tree overlay (↑↓ navigate, ⏎ open, esc close)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			await openAgentOverlay(ctx);
		},
	});

	// ── /persona ─────────────────────────────────────────────────────────────────
	pi.registerCommand("persona", {
		description: "Switch the active supervisor persona: /persona [name|off|list|reload|seed|restore]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const arg = args.trim();
			if (arg === "off" || arg === "none") {
				await controller.deactivate();
				persist(undefined);
				await exocom.onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
				ctx.ui.notify("persona: cleared (default supervisor)", "info");
				return;
			}
			if (arg === "reload") {
				const activeName = controller.activePersona?.name;
				const migration = refreshSeedMigration();
				reload(ctx.cwd);
				// Resolve-once-per-session is what keeps two turns of one conversation under the
				// same rules; an explicit reload is the user asking for exactly this file to be
				// re-read, so the spine comes along with the personas.
				inspectEnabledLegacySpines();
				reportSpineWarning(ctx);
				reportSeedMigration(ctx, migration);
				reportDefinitionCollisions(ctx);
				if (activeName) {
					const fresh = personas.find((p) => p.name === activeName);
					if (fresh) await controller.activate(fresh);
					else await controller.deactivate();
				}
				await exocom.onPersonaChanged(ctx);
				ctx.ui.notify(`persona: reloaded ${personas.length} personas, ${agents.length} agents`, "info");
				return;
			}
			// seed = copy any MISSING bundled defaults into the user dir (pull new ones);
			// restore = force-overwrite them back to the bundled originals (discards your edits).
			if (arg === "seed" || arg === "restore") {
				const force = arg === "restore";
				const r = runSeed(force);
				reportSeedSourceCollisions(ctx, r);
				const migration = refreshSeedMigration();
				// These commands can create, migrate, preserve, or overwrite either prompt file. Refresh
				// both cached roles now so the very next supervisor turn and delegated leg agree without
				// requiring a second `/persona reload` or a process restart.
				refreshSpineAfterSeed();
				reportSpineWarning(ctx);
				reportSeedMigration(ctx, migration);
				reload(ctx.cwd);
				reportDefinitionCollisions(ctx);
				// Re-apply the active persona so a restored definition takes effect immediately.
				const active = controller.activePersona?.name;
				const fresh = active ? personas.find((p) => p.name === active) : undefined;
				if (fresh) await controller.activate(fresh);
				await exocom.onPersonaChanged(ctx); // a restored persona file may have changed canUseBus — re-gate; clear the by-hand run
				const kept = r.skipped.length > 0 ? `, kept ${r.skipped.length} existing` : "";
				ctx.ui.notify(`persona: ${force ? "restored" : "seeded"} ${r.copied.length} default(s) to ${userAgentDir()}${kept}.`, "info");
				return;
			}
			if (arg === "" || arg === "list") {
				// Empty by design on a fresh install: personas load only from the user dir, which the
				// user populates on purpose. Point them at the install gesture rather than leaving a
				// bare "(none)" that reads like something is broken.
				if (personas.length === 0) {
					ctx.ui.notify(
						"No personas installed. pi-persona does not auto-install — run `/persona seed` to copy the bundled defaults into your agent dir (edit them freely; `/persona restore` re-installs the originals).",
						"info",
					);
					return;
				}
				const lines = personas.map(
					(p) => `${p.name === controller.activePersona?.name ? "▶ " : "  "}${p.label} (${p.name})`,
				);
				ctx.ui.notify(
					[`Personas (active: ${controller.activePersona?.label ?? "none"}):`, ...lines].join("\n"),
					"info",
				);
				return;
			}
			const persona = personas.find((p) => p.name === arg || p.label === arg);
			if (!persona) {
				ctx.ui.notify(`persona: "${arg}" not found. Try /persona list`, "error");
				return;
			}
			await controller.activate(persona);
			persist(persona.name);
			await exocom.onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
			ctx.ui.notify(`persona: ${persona.label} active`, "info");
		},
	});

	// ── /doctor ──────────────────────────────────────────────────────────────────
	pi.registerCommand("doctor", {
		description: "Explain pi-persona resolution (personas/agents/teams/shadowed)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			ctx.ui.notify(doctorReport(), "info");
		},
	});

	// ── /exocom (T9): the external peer-to-peer plane's live pool ─────────────────
	pi.registerCommand("exocom", {
		description: "Show the active Exocom scope, workspace code, and peers: /exocom",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (!exocom.plane) {
				ctx.ui.notify(
					"exocom: not active — use --exocom for this workspace or --exocom=Ab0T to join another workspace, with a persona that allows the bus (canUseBus).",
					"warning",
				);
				return;
			}
			exocom.renderWidget();
			const peers = exocom.plane.listPeers();
			const scope = exocom.scope;
			const lines = peers.map(
				(p) => {
					const name = sanitizePeerField(p.displayName, 48) || "peer";
					const persona = sanitizePeerField(p.persona, 48) || "—";
					const model = sanitizePeerField(p.model, 96) || "?";
					const contextPct = Number.isFinite(p.context_pct) ? Math.max(0, Math.min(100, Math.round(p.context_pct))) : 0;
					const workspaceId = p.workspace_id ?? scope?.scopeWorkspaceId;
					const workspaceCode = p.workspace_code ?? (scope && workspaceId === scope.scopeWorkspaceId ? scope.scopeCode : "?");
					const workspaceLabel = sanitizePeerField(
						p.workspace_label ?? (scope && workspaceId === scope.homeWorkspaceId ? scope.homeWorkspaceLabel : "workspace"),
						80,
					) || "workspace";
					const locality = workspaceId === scope?.homeWorkspaceId ? "same workspace" : "external workspace";
					return `• ${name} (${persona} · ${model}, ctx ${contextPct}%) · ${workspaceLabel} [${workspaceCode}] · ${locality}`;
				},
			);
			const scopeLine = scope
				? scope.joined
					? `joined scope [${scope.scopeCode}] · home ${scope.homeWorkspaceLabel} [${scope.homeWorkspaceCode}] · advisory for writes`
					: `workspace ${scope.homeWorkspaceLabel} [${scope.scopeCode}]`
				: "scope unavailable";
			appendCommandResult(
				`exocom ${exocom.name}`,
				peers.length === 0
					? `${scopeLine}\nno other peers in this scope right now`
					: `${scopeLine}\n${peers.length} peer${peers.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
				true,
			);
		},
	});

	// ── /models + a `models` tool — discover/search model ids ─────────────────────
	pi.registerCommand("models", {
		description: "List or search available models (provider/id): /models [query]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const { lines, total, capped } = searchModels(ctx, args);
			if (lines.length === 0) {
				ctx.ui.notify(`models: no match for "${args.trim()}"`, "warning");
				return;
			}
			const head = `models (${total}${capped ? ", showing 40" : ""})${ctx.model ? ` · session ★ ${ctx.model.provider}/${ctx.model.id}` : ""}`;
			ctx.ui.notify(`${head}\n${lines.join("\n")}${capped ? "\n…refine with /models <query>" : ""}`, "info");
		},
	});

	registerModelsTool(pi, {
		get lastCtx() { return lastCtx; },
		set lastCtx(value) { lastCtx = value; },
		searchModels,
	});

	// ── /peek (async run progress) ───────────────────────────────────────────────
	pi.registerCommand("peek", {
		description: "Show background async runs and their progress: /peek [runId]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const id = args.trim();
			if (id) {
				const run = tracker.peek(id);
				ctx.ui.notify(run ? buildPeekDigest([run], { now: Date.now(), stallMs: STALL_FLAG_MS }) : `peek: no run "${id}"`, run ? "info" : "warning");
			} else {
				ctx.ui.notify(buildPeekDigest(tracker.list(), { now: Date.now(), stallMs: STALL_FLAG_MS }), "info");
			}
		},
	});

	// ── /orchestrate (run the active persona's strategy) ──────────────────────────
	pi.registerCommand("orchestrate", {
		description: "Run the active persona's strategy on a task: /orchestrate <task>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const task = args.trim();
			const orch = controller.activePersona?.orchestration;
			if (!task) {
				ctx.ui.notify("orchestrate: provide a task — /orchestrate <task>", "warning");
				return;
			}
			// A flow persona (`mode: flow`) is just as runnable — run its flow, like the input hook does.
			if (orch?.mode === "flow" && orch.flow) {
				const parsed = loadFlow(ctx.cwd, orch.flow);
				if (!parsed) {
					ctx.ui.notify(`orchestrate: no flow named "${orch.flow}"`, "error");
					return;
				}
				if (!parsed.ok) {
					ctx.ui.notify(`orchestrate: flow "${orch.flow}" is invalid: ${parsed.error}`, "error");
					return;
				}
				try {
					const outcome = await runFlowVisible(ctx, parsed.flow, task);
					appendCommandResult(`flow ${orch.flow}`, outcome.output || "(flow produced no output)", outcome.ok, {
						...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
						...(outcome.error ? { error: outcome.error } : {}),
					});
				} catch (err) {
					ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}
			let strategyName: string | undefined;
			try {
				strategyName = orch ? resolveStrategyName(orch) : undefined;
			} catch (err) {
				ctx.ui.notify(personaGrammarError(err), "error");
				return;
			}
			if (!orch || !strategyName) {
				ctx.ui.notify("orchestrate: the active persona declares no runnable strategy/mode", "warning");
				return;
			}
			try {
				const result = await runStrategyVisible(ctx, orch, task, "orchestrate");
				appendCommandResult(
					`orchestrate ${strategyName}`,
					result?.output || "(no output)",
					result?.ok ?? false,
					{
						...(result?.failureKind ? { failureKind: result.failureKind } : {}),
						...(result?.error ? { error: result.error } : {}),
					},
				);
			} catch (err) {
				ctx.ui.notify(`orchestrate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ── /flow (run a *.flow.json DAG over strategies; journaled resume) ───────────
	pi.registerCommand("flow", {
		description: "Run a flow (DAG over strategies): /flow <name> <task> — or /flow to list",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed || trimmed === "list") {
				const flows = listFlows(ctx.cwd);
				ctx.ui.notify(
					flows.length ? `flows: ${flows.join(", ")}  ·  /flow <name> <task>` : "no flows — add a *.flow.json under .pi/flows/",
					"info",
				);
				return;
			}
			const sp = trimmed.search(/\s/);
			const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
			const task = sp < 0 ? "" : trimmed.slice(sp + 1).trim();
			if (!task) {
				ctx.ui.notify(`flow: provide a task — /flow ${name} <task>`, "warning");
				return;
			}
			const parsed = loadFlow(ctx.cwd, name);
			if (!parsed) {
				ctx.ui.notify(`flow: no flow named "${name}" (try /flow to list)`, "warning");
				return;
			}
			if (!parsed.ok) {
				ctx.ui.notify(`flow "${name}" is invalid: ${parsed.error}`, "error");
				return;
			}
			try {
				const outcome = await runFlowVisible(ctx, parsed.flow, task);
				appendCommandResult(`flow ${name}`, outcome.output || "(flow produced no output)", outcome.ok, {
					...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
					...(outcome.error ? { error: outcome.error } : {}),
				});
			} catch (err) {
				ctx.ui.notify(`flow failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

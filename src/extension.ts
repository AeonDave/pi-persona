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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import type { AgentConfig } from "./agents/agent.ts";
import { installBridge, isBridgeMode } from "./bridge.ts";
import { resolveConfig } from "./core/config.ts";
import { resolveModelRef } from "./core/models.ts";
import { isThinkingLevel } from "./core/types.ts";
import { type ContractDef, DEFAULT_CONTRACT } from "./core/contract.ts";
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
import { buildDelegationBrief, buildExocomBrief } from "./core/brief.ts";
import { buildSessionAnchor } from "./core/time.ts";
import { canDelegateTo, canFanOut, EXOCOM_TOOL_NAMES, type RunLimits } from "./core/capabilities.ts";
import { fenceUntrusted } from "./core/fence.ts";
import { sanitizeDisplayLabel } from "./core/display-label.ts";
import { DelegationNudge, PersistenceNudge } from "./core/nudge.ts";
import { type EngineAdapterBroker, type EngineAdapterDeps, makeEngine } from "./engine/adapter.ts";
import { withModelFallback } from "./engine/fallback.ts";
import { captureWorktreeArtifact, defaultGitExec, withWorktree, worktreePreflight } from "./engine/worktree.ts";
import { type InProcessDeps, makeInProcessEngine } from "./engine/inproc.ts";
import { type AsyncRun, AsyncRunTracker, boundCompletionSurface, buildCheckIn, buildPeekAlert, buildPeekDigest, buildRetentionOverflowNote, buildWaitTimeoutNote, compactTokens, dedupeRunsById, getFullRunOutput, IdleCoalescingNotifier, MAX_COMPLETION_REPORT_CHARS, PeekWatcher, renderCompletion, runDurationLabel } from "./engine/async.ts";
import { emptyUsage, type ProgressSnapshot } from "./engine/stream.ts";
import { type BrokerHost, startBrokerHost } from "./bus/broker/host.ts";
import { brokerEndpoint } from "./bus/broker/paths.ts";
import { InProcessBus } from "./bus/inproc.ts";
import { buildInboundDelivery, type InboundDecision } from "./exocom/inbound.ts";
import { SeenMessages, SenderBudget } from "./exocom/guards.ts";
import { EXOCOM } from "./exocom/limits.ts";
import { endpoint as exocomEndpointFor, workspaceHash } from "./exocom/paths.ts";
import { ExocomPlane, type DisplayPeer, type ExocomInboundResult } from "./exocom/plane.ts";
import { prune as pruneExocom, type RegistryEntry } from "./exocom/registry.ts";
import { registerExocomTools } from "./tools/exocom.ts";
import { loadContracts, loadDefinitions, loadPresets, loadTeams, type LoadResult, type ScopedDir } from "./loader.ts";
import { type FlowSpec, flowHash, parseFlow } from "./orchestration/flow.ts";
import { journalFileName, journalWriter, readJournal } from "./orchestration/flow-journal.ts";
import { runFlow } from "./orchestration/flow-run.ts";
import { Semaphore } from "./orchestration/parallel.ts";
import { type RosterMember, rosterNodeKeys, rosterSpec } from "./orchestration/roster.ts";
import type { AgentProgress, AgentRunSpec, AgentStatus, SteerFn, StrategyEngine } from "./orchestration/sdk.ts";
import { knownParams, strategyNames } from "./orchestration/strategy.ts";
import { compactMemberResult, formatCouncilResult, humanizeAggregateResult } from "./orchestration/render.ts";
import type { AgentResult, FailureKind } from "./orchestration/types.ts";
import { type ModelHandle, PersonaController, type PersonaHost } from "./persona/controller.ts";
import { resolveStrategyName, runPersonaStrategy } from "./persona/orchestrate.ts";
import { expandCouncilPreset, resolveCouncilInvocation, type OrchestrationGrammar, type Persona } from "./persona/persona.ts";
import { bundledSpinePath, bundledWorkerSpinePath, readSpineFile, resolveSpine, type SpineSources } from "./persona/spine.ts";
import { readLastPersona, writeLastPersona } from "./persona/state.ts";
import {
	type PersonaConfigStore,
	personaModels,
	readPersonaConfigs,
	withPersonaModels,
	writePersonaConfigs,
} from "./persona/config-store.ts";
import {
	CODENAMES,
	DelegationLedger,
	type DelegateView,
	nameFor,
	normalizeDelegateConcurrency,
	runDelegate,
	shortModel,
	shouldRecordDelegationOutcome,
	specOf,
	unknownAgentError,
	validateDelegationBrief,
	validateParallelWriteSets,
	wantsAsyncRun,
} from "./tools/delegate.ts";
import { formatInbox, type IntercomParams, MAX_INTERCOM_MESSAGE_CHARS, MAX_INTERCOM_REF_CHARS, runIntercom } from "./tools/intercom.ts";
import { formatRemaining, renderTimerFire, TimerScheduler, type TimerEntry } from "./core/timer.ts";
import { AgentOverlay } from "./ui/agent-overlay.ts";
import { type AddNodeInput, AgentTree, type AgentNodeStatus, renderAgentTreeSummary } from "./ui/agent-tree.ts";
import { filterModels, ModelPicker, orderModelRefs } from "./ui/model-picker.ts";
import { boundDisplayRows, compactInlineText, compactVisibleText, sanitizeTerminalText } from "./ui/presentation.ts";
import { formatUsage } from "./ui/usage.ts";

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

/**
 * Pi 0.84.x deliberately ignores an `isError` property returned by a tool's `execute()`.
 * Recoverable pi-persona failures still need their rich `details` for the compact renderers, so
 * throwing would discard useful operator context. Mark the result in details and repair the
 * host-visible error bit from the `tool_result` hook, where Pi explicitly supports it.
 */
const PI_PERSONA_TOOL_ERROR = "__piPersonaToolError";

function failureDetails<T extends object>(details: T): T & { __piPersonaToolError: true } {
	return { ...details, [PI_PERSONA_TOOL_ERROR]: true };
}

export function piPersonaToolErrorPatch(details: unknown): { isError: true; details: Record<string, unknown> } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	if (record[PI_PERSONA_TOOL_ERROR] !== true) return undefined;
	const clean = { ...record };
	delete clean[PI_PERSONA_TOOL_ERROR];
	return { isError: true, details: clean };
}

export function canDeliverPersonaNotification(orchestrating: boolean, processingDeferred: boolean, hostIdle: boolean): boolean {
	return !orchestrating && !processingDeferred && hostIdle;
}

/** The Pi global agent dir, overridable via PI_AGENT_DIR (handy for tests/sandboxes). */
function userAgentDir(): string {
	return process.env.PI_AGENT_DIR || getAgentDir();
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

/** exocom attribution-label sanitizer (I2): the resolved label is PEER-CONTROLLED registry data
 *  (`fromEntry.name`/`persona` — a peer writes its own registry entry) and is rendered OUTSIDE
 *  the quoted body. A CR/LF-laden name could otherwise inject pseudo-instructions into the
 *  supervisor's context. Reduce it to a bounded identifier before it reaches the canonical
 *  inbound builder. Exported for direct unit testing (mirrors `listPeersForGroup` above). */
function sanitizePeerField(value: string, max: number): string {
	return value
		.normalize("NFKC")
		.replace(/[^A-Za-z0-9._/@:+#-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._/@:+#]+|[-._/@:+#]+$/g, "")
		.slice(0, max);
}

export function sanitizeLabel(s: string): string {
	return sanitizePeerField(s, 80) || "peer";
}

/** Translate the local guard decision into the transport ACK contract. An ACK means queued (or an
 * idempotent duplicate), never rendered or consumed by the receiving model. */
export function exocomInboundDisposition(decision: InboundDecision): ExocomInboundResult {
	if ("deliver" in decision) return { accepted: true };
	if ("duplicate" in decision) return { accepted: true, duplicate: true };
	return { accepted: false, reason: decision.drop };
}

export function formatExocomQueuedToast(label: string, inReplyTo: string | undefined): string {
	return `exocom: ${inReplyTo === undefined ? "message" : "reply"} from ${label} queued`;
}

export interface ExocomQueuedToast {
	label: string;
	inReplyTo: string | undefined;
}

interface CommandResultEntry {
	label: string;
	content: string;
	ok: boolean;
	failureKind?: FailureKind;
	error?: string;
}

/** One human toast for a burst; the semantic messages themselves remain in the idle-gated card. */
export function formatExocomQueuedBatchToast(items: readonly ExocomQueuedToast[]): string {
	if (items.length === 0) return "";
	const first = items[0]!;
	if (items.length === 1) return formatExocomQueuedToast(first.label, first.inReplyTo);
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
	const senders = [...counts.entries()];
	const visible = senders.slice(0, 3).map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
	const omitted = senders.length - visible.length;
	return `exocom: ${items.length} messages/replies queued from ${visible.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`;
}

/** Bound the model-facing external-inbound burst while retaining the already-built attribution
 * and peer fence on every complete line that survives the head/tail sample. */
export function boundExocomInboundBatch(items: readonly string[]): string {
	return boundCompletionSurface(
		items.join("\n\n"),
		"exocom inbound batch truncated; remaining peer messages stay queued for later delivery",
	);
}

/**
 * How many leading queued peer messages one inbound wake may carry. exocom has no receiver-side
 * inbox or result retrieval, so a message truncated INSIDE a delivery is lost outright — the batch
 * is therefore sized to what {@link boundExocomInboundBatch} renders whole, and the rest stays
 * queued in FIFO order for the next wake. Sizing by content rather than by a fixed item count is
 * what lets the drain keep pace with ordinary chatter: the wake gates (R6: 10s apart, 6/min) cap
 * the number of DELIVERIES, while each sender may send EXOCOM.SENDER_MAX_MSGS per minute, so a
 * one-message-per-wake drain falls permanently behind a handful of peers talking normally. A single
 * item over the whole budget still goes out alone (it is already head-truncated to
 * EXOCOM.INJECT_MAX_BYTES on arrival), so the queue can never wedge.
 */
export function exocomInboundBatchSize(items: readonly string[]): number {
	let chars = 0;
	let count = 0;
	for (const item of items) {
		const withItem = chars + (count > 0 ? 2 : 0) + item.length; // 2 = the "\n\n" join
		if (count > 0 && withItem > MAX_COMPLETION_REPORT_CHARS) break;
		chars = withItem;
		count += 1;
	}
	return Math.max(1, count);
}

/**
 * How many undelivered peer messages the inbox holds before further inbound messages are REFUSED
 * at the ACK (a signed nack the sender surfaces, not a silent drop). Sustained large messages drain
 * one per wake, which is slower than a single sender's permitted rate, so without a ceiling the
 * queue grows monotonically: memory climbs, every fresh message waits behind the whole backlog, and
 * a persona downgrade or shutdown discards all of it at once. This depth still absorbs a full
 * minute of bursting from three peers at their maximum permitted rate.
 */
export const EXOCOM_INBOX_MAX = 3 * EXOCOM.SENDER_MAX_MSGS;

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

/** Project a delegate leg without conflating an explicit abort with an execution failure. */
export function agentNodeStatusForDelegate(view: Pick<DelegateView, "running" | "ok" | "failureKind">): AgentNodeStatus {
	if (view.running) return "running";
	if (view.failureKind === "abort") return "stopped";
	return view.ok ? "done" : "failed";
}

/** One race-safe path for every extension-originated wake. */
export function sendPersonaFollowUp(
	pi: Pick<ExtensionAPI, "sendMessage">,
	content: string,
	customType = "pi-persona",
): void {
	const body = customType === "pi-persona" ? content.replace(/^\[pi-persona\]\s*/, "") : content;
	pi.sendMessage(
		{ customType, content: body, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function expandDetailHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		// Renderers are also exercised by headless/test hosts where Pi's interactive theme and
		// keybinding registry do not exist. The production TUI takes the branch above.
		return "expand to see full detail";
	}
}

export function formatCouncilCallLabel(strategy: string, roster: string): string {
	const safeStrategy = compactInlineText(strategy, { maxChars: 80 }) || "?";
	const safeRoster = compactInlineText(roster, { maxChars: 80 }) || "?";
	return `council ${safeStrategy}${strategy === roster ? "" : ` · ${safeRoster}`}`;
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

/** One buffered blocking ask — carried with its `askId` so an answered ask can be reconciled out
 *  of the notifier (see {@link reconcileAnsweredAsk}) instead of waking the supervisor for a
 *  decision it has already made. */
export interface PendingAsk {
	askId: string;
	text: string;
}

/** Bound a burst of blocking child questions before it becomes an automatic supervisor turn. Each
 * item is already individually fenced; the line-safe completion bound preserves those quote lines. */
export function renderPendingAskBatch(asks: readonly PendingAsk[]): string {
	return boundCompletionSurface(
		asks.map((ask) => ask.text).join("\n\n"),
		"blocking-ask batch truncated; pending questions remain available through intercom inbox",
	);
}

/** A child's blocking ask lands on TWO surfaces — the idle-gated notifier wake and the supervisor's
 *  bus inbox — and answering one leaves the other stale (a re-wake for an answered ask, or an
 *  envelope that re-surfaces in the next `inbox` with its "reply with id" tag). Answering IS the
 *  reconciliation point: drop the ask from both. Mirrors `completionNotifier.discard` on
 *  `intercom wait`. */
export function reconcileAnsweredAsk(
	askId: string,
	notifier: { discard: (pred: (item: PendingAsk) => boolean) => void },
	inbox: { takeWhere: (handle: string, pred: (env: { id: string }) => boolean) => unknown },
	handle: string,
): void {
	notifier.discard((item) => item.askId === askId);
	inbox.takeWhere(handle, (env) => env.id === askId);
}

/** Whether an exocom heartbeat failure is worth telling the user about. The tick runs on a timer,
 *  so reporting every one would spam a session that is otherwise fine; reporting none would hide a
 *  plane that has silently dropped out of every peer's pool (its entry goes stale after
 *  EXOCOM.STALE_AFTER_MS and never comes back). So: the first failure at once, then one reminder
 *  per ~10 ticks for as long as it keeps failing. A single successful tick resets the count. */
export function shouldReportHeartbeatFailure(consecutiveFailures: number): boolean {
	return consecutiveFailures === 1 || consecutiveFailures % 10 === 0;
}

/** The `intercom` bus actions echo text of two different provenances: `inbox` carries CHILD-authored
 *  message bodies (untrusted — the same text `drainBusBlock`/`peek` fence), while `list`/`reply`/
 *  `send` (and the empty-inbox placeholder) are supervisor-side. Fence only the former. */
export function fenceIntercomOutcome(out: { text: string; details: { action: string; messages?: unknown[] } }, fence: (t: string) => string): string {
	const untrusted = out.details.action === "inbox" && (out.details.messages?.length ?? 0) > 0;
	return untrusted ? fence(out.text) : out.text;
}

export function coachingDisabledHint(personaName: string | undefined): string {
	const who = sanitizeDisplayLabel(personaName ?? "default", "default");
	return `(coaching is OFF for persona "${who}" — sub-agents get no contact_supervisor tool, so the message bus is empty. To just watch or redirect them use action "peek"/"steer"; to exchange messages, add \`coaching: true\` or switch to a coaching persona.)`;
}

/** The engine constructors `buildEngine` builds through. Indirected via one object so the deps
 *  each backend is actually handed are observable: the child engine can be watched through a fake
 *  `pi` binary, but the in-process one — the DEFAULT backend — creates a real session that needs a
 *  live model and provider, so its wiring would otherwise have no witness at all. */
export interface EngineFactories {
	makeEngine: typeof makeEngine;
	makeInProcessEngine: typeof makeInProcessEngine;
}

/** Frozen, so the production table is a constant rather than something a later import can swap
 *  out from under a running session. */
const DEFAULT_ENGINE_FACTORIES: EngineFactories = Object.freeze({ makeEngine, makeInProcessEngine });

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
		description: "Join the exocom peer-to-peer plane for this run (external agent-to-agent collaboration between independent pi instances in this workspace)",
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
			fn(text);
		} catch {
			// the handle may point at a just-finished/disposed session — treat as "not steerable"
			return false;
		}
		return true;
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
		contractDefs = loadContracts(contractDirs(cwd));
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
		if (definitionCollisions.length === 0) return;
		const names = definitionCollisions.map((collision) => collision.name).join(", ");
		const message = `pi-persona: ${definitionCollisions.length} persona/agent definition collision(s) were omitted: ${names}. Run /doctor for source paths.`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else process.stderr.write(`${message}\n`);
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
				lastCtx?.ui.setStatus("persona", text);
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
		const msgs = bus.take(SUPERVISOR);
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
		if (disposed || env.to !== SUPERVISOR || !env.expectsReply) return;
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

	// Cross-process broker (v0.5, spec B1-B7): opt-in (PI_PERSONA_BROKER), off by default — see
	// `config.broker`. Off ⇒ none of the state below is ever touched, so `deps.broker` stays
	// undefined and the child engine spawns byte-identical to pre-broker pi-persona.
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
	function makeBrokerDeps(ctx: ExtensionContext): EngineAdapterBroker {
		const endpoint = brokerEndpoint(ctx.sessionManager.getSessionId());
		ensureBrokerHost(endpoint);
		return {
			endpoint,
			register: (info) => {
				bus.register(info.handle);
				if (info.peers) brokerPeers.set(info.handle, { label: info.label ?? info.handle, group: info.group ?? "" });
			},
			unregister: (handle) => {
				brokerPeers.delete(handle);
				bus.unregister(handle);
			},
			steerFrame: (handle, text) => {
				brokerHost?.steer(handle, text);
			},
		};
	}

	// ── exocom (opt-in, T9): the EXTERNAL peer-to-peer plane ─────────────────────
	// Independent top-level pi instances in this workspace discover + message each other
	// directly (flat) — distinct from the broker/intercom plane above, which is strictly
	// hierarchical (a supervisor and its OWN spawned children). Off by default (config.exocom /
	// --exocom), additionally gated by the active persona's canUseBus capability; no active
	// persona ⇒ unrestricted (mirrors delegationBrief's own reading of an absent capability set,
	// rather than silently refusing to join for an unpersona'd session — see startExocom below).
	let exocomPlane: ExocomPlane | undefined;
	let exocomName = "";
	let exocomBudget: SenderBudget | undefined;
	let exocomSeen: SeenMessages | undefined;
	let exocomNotifier: IdleCoalescingNotifier<string> | undefined;
	/** Latched while the inbox is at EXOCOM_INBOX_MAX, so a peer hammering a full inbox produces one
	 *  operator warning rather than one per refused message. */
	let exocomInboxFull = false;
	let exocomToastNotifier: IdleCoalescingNotifier<ExocomQueuedToast> | undefined;
	let exocomHeartbeat: ReturnType<typeof setInterval> | undefined;
	let exocomHeartbeatFailures = 0; // consecutive failed ticks — drives the report cadence, reset by any success
	let exocomResetTimer: ReturnType<typeof setInterval> | undefined;

	// A tiny, stable name→color hash for the pool widget's swatch — exocom peers carry no
	// persona "label colour" of their own to read, so this derives one deterministically
	// instead of hardcoding one default for every peer.
	const EXOCOM_PALETTE = ["#36F9F6", "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF", "#C780FA", "#FF9F1C", "#00C2A8"];
	function exocomColorFor(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
		return EXOCOM_PALETTE[h % EXOCOM_PALETTE.length]!;
	}
	// A distinctive per-instance call-sign (orion/vega/…) drawn from the delegate CODENAMES pool,
	// derived by hashing the session_id so it's stable for the session (never re-randomises on a
	// plane restart) yet spreads across the pool. Independent of the active persona — the persona
	// is displayed alongside it, not baked into the name.
	function exocomCodename(sessionId: string, taken: Set<string>): string {
		// A deterministic starting point from the session, then the first call-sign NOT already held
		// by a live peer — so N concurrent instances get N DISTINCT names (`hash % 16` alone collides
		// ~18% of the time at just 3 instances). Only a >16-live run, or a rare simultaneous-start
		// race (both read the registry before either registered), falls back to the hashed one and
		// the display dedup ("orion#2").
		let h = 0;
		for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
		const start = h % CODENAMES.length;
		for (let i = 0; i < CODENAMES.length; i++) {
			const name = CODENAMES[(start + i) % CODENAMES.length]!;
			if (!taken.has(name)) return name;
		}
		return CODENAMES[start]!;
	}

	// One row per live peer (the registry read itself IS the pool — each peer refreshes its
	// own entry on its own heartbeat, so no ping fan-out is needed here). Best-effort/cosmetic,
	// mirrors renderAgentWidget above.
	function renderExocomWidget(): void {
		if (!lastCtx || !exocomPlane) return;
		// The pool read is disk I/O (readdir + a read per entry) and can fail like any other, so it
		// is guarded too — otherwise "best-effort" would be false of the very first statement, and
		// a registry hiccup would escape into whatever tick asked for a repaint. There is nothing
		// to draw without it; the next heartbeat repaints.
		let peers: DisplayPeer[];
		try {
			peers = exocomPlane.listPeers();
		} catch {
			return;
		}
		try {
			const now = Date.now();
			const selfPersona = sanitizePeerField(controller.activePersona?.name ?? "", 48);
			const selfModel = sanitizePeerField(lastCtx.model ? `${lastCtx.model.provider}/${lastCtx.model.id}` : "", 96);
			const selfContextPct = Math.max(0, Math.min(100, Math.round(lastCtx.getContextUsage()?.percent ?? 0)));
			const local = `📡 ${exocomName} (you)${selfPersona ? ` · ${selfPersona}` : ""} · ${shortModel(selfModel) || "?"} · ctx ${selfContextPct}%`;
			const peerRows = peers.map((p) => {
							const quiet = now - Date.parse(p.heartbeat_at) > EXOCOM.QUIET_AFTER_MS;
							const name = sanitizePeerField(p.displayName, 48) || "peer";
							const persona = sanitizePeerField(p.persona, 48);
							const model = sanitizePeerField(p.model, 96);
							const contextPct = Number.isFinite(p.context_pct) ? Math.max(0, Math.min(100, Math.round(p.context_pct))) : 0;
							// Viewer-centric: THIS row's in/out is what WE exchanged with THIS peer, not
							// the peer's own global self-report (which reads inverted from our side).
							return `${quiet ? "💤" : "📡"} ${name}${persona ? ` (${persona})` : ""} · ${shortModel(model) || "?"} · ctx ${contextPct}% · recv ${exocomPlane?.receivedFromPeer(p.session_id) ?? 0} · sent ${exocomPlane?.sentToPeer(p.session_id) ?? 0}`;
						});
			const lines = boundDisplayRows(local, peerRows, 7, "exocom_list for the full pool");
			lastCtx.ui.setWidget("persona-exocom", lines, { placement: "aboveEditor" });
		} catch {
			/* cosmetic — the widget is best-effort */
		}
		try {
			lastCtx.ui.setStatus(
				"persona-exocom",
				`📡 ${exocomName} · ${peers.length} peer${peers.length === 1 ? "" : "s"} · ${exocomPlane?.totalReceived ?? 0} in · ${exocomPlane?.totalSent ?? 0} out`,
			);
		} catch {
			/* cosmetic */
		}
	}

	// Re-register with the CURRENT persona/model/context% (so a `/persona` switch or a model change
	// is reflected, not a stale snapshot from session_start) and prune dead peers — one unref'd tick
	// covers both heartbeat AND pool refresh. Routed through `plane.heartbeat` rather than a bare
	// `writeEntry`: the plane re-attaches its ed25519 public key on every re-registration, including
	// one that RE-CREATES an entry a peer deleted underneath us (plane.ts) — the key lives nowhere
	// but this process, and an entry without it makes every frame we sign unverifiable.
	function exocomHeartbeatTick(agentDir: string, hash: string, sessionId: string, ep: string, cwd: string): void {
		const plane = exocomPlane;
		if (!plane) return;
		const persona = sanitizePeerField(controller.activePersona?.name ?? "", 48);
		const model = sanitizePeerField(lastCtx?.model ? `${lastCtx.model.provider}/${lastCtx.model.id}` : "", 96);
		const entry: RegistryEntry = {
			session_id: sessionId,
			name: exocomName,
			persona,
			purpose: controller.activePersona?.description ?? "",
			color: exocomColorFor(exocomName),
			model,
			pid: process.pid,
			endpoint: ep,
			cwd,
			context_pct: Math.round(lastCtx?.getContextUsage()?.percent ?? 0),
			inbox: exocomNotifier?.peekPending().length ?? 0,
			heartbeat_at: new Date().toISOString(),
		};
		plane.heartbeat(entry);
		// Everything past the re-registration is local upkeep: sweeping OTHER instances' dead entries
		// and repainting our own widget. Letting a failure there out would be counted as a heartbeat
		// failure and tell the user "peers drop this instance from the pool" — which would be false,
		// since the write above is exactly what keeps us in it. Only the registration decides that.
		try {
			pruneExocom(agentDir, hash, { now: Date.now(), staleMs: EXOCOM.STALE_AFTER_MS });
			renderExocomWidget();
		} catch (err) {
			if (process.env.PI_PERSONA_DEBUG) {
				process.stderr.write(`[pi-persona] exocom: pool upkeep failed after a good heartbeat: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
	}

	// Join the plane for this session — called from session_start ONCE the persona is applied,
	// so identity + the canUseBus gate reflect the persona actually active. Never throws: a
	// bind/registry failure degrades to "exocom inactive", it must never block a normal session
	// from starting (mirrors the broker host's own fire-and-forget-on-failure discipline).
	async function startExocom(ctx: ExtensionContext): Promise<void> {
		if (!(config.exocom || pi.getFlag("exocom") === true)) return;
		if (!(controller.capabilities?.canUseBus ?? true)) return;
		try {
			const hash = workspaceHash(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();
			const agentDir = userAgentDir();
			// Default instance name: a distinctive CALL-SIGN (orion/vega/…, the same pool a delegated
			// sub-agent draws from), INDEPENDENT of the persona (shown separately) — picked collision-
			// free against the LIVE peers so N instances get N distinct names. It is only a DEFAULT:
			// the model can rebrand itself creatively via the `exocom_name` tool. The registry FILE is
			// keyed by session_id, not by name, so the name is purely a display label.
			const liveAtStart = pruneExocom(agentDir, hash, { now: Date.now(), staleMs: EXOCOM.STALE_AFTER_MS });
			const desired = exocomCodename(sessionId, new Set(liveAtStart.map((e) => e.name)));
			exocomName = desired;
			const ep = exocomEndpointFor(agentDir, hash, sessionId, process.platform);
			const persona = sanitizePeerField(controller.activePersona?.name ?? "", 48);
			const model = sanitizePeerField(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", 96);
			exocomBudget = new SenderBudget({ windowMs: EXOCOM.SENDER_WINDOW_MS, maxMsgs: EXOCOM.SENDER_MAX_MSGS, maxBytes: EXOCOM.SENDER_MAX_BYTES });
			exocomSeen = new SeenMessages({ ttlMs: EXOCOM.SEEN_TTL_MS });
			// Fenced, attributed follow-up delivery — idle-gated + rate-limited (R6), the same
			// discipline completionNotifier/intercomNotifier/timerNotifier apply above, but through
			// pi.sendMessage (a distinct, labellable custom message) rather than pi.sendUserMessage
			// (mirrors the bridge's own `sendFollowUp` for inbound cross-process text).
			exocomNotifier = new IdleCoalescingNotifier<string>({
				isIdle: () => canDeliverPersonaNotification(orchestrating, processingDeferredOrchestration, lastCtx?.isIdle?.() === true),
				deliver: (message) => sendPersonaFollowUp(pi, message, "exocom_received"),
				// A burst of independent peers must not turn one idle wake into an unbounded model
				// payload. Each item is already attributed and peer-fenced by buildInboundDelivery;
				// boundCompletionSurface keeps complete lines (including quote prefixes) intact while
				// retaining a bounded head/tail sample and an actionable drill-down marker.
				render: boundExocomInboundBatch,
				// Deliver whole peer messages — as many as one wake renders untruncated — and retain the
				// rest in FIFO order; truncating a coalesced burst would silently lose communication that
				// has no other retrieval path. Sized by content, so the drain keeps pace with ordinary
				// traffic instead of being pinned to one message per wake (see exocomInboundBatchSize).
				maxBatchItems: exocomInboundBatchSize,
				setTimer: (fn, ms) => {
					const h = setTimeout(fn, ms);
					h.unref?.();
					return h;
				},
				clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
				minIntervalMs: EXOCOM.DELIVER_MIN_INTERVAL_MS,
				maxDeliveries: EXOCOM.DELIVER_MAX_PER_MIN,
			});
			exocomToastNotifier = new IdleCoalescingNotifier<ExocomQueuedToast>({
				// This channel is human-only and deliberately independent from model idleness: it folds a
				// burst of arrivals into one small receipt instead of emitting one toast per peer message.
				isIdle: () => true,
				deliver: (message) => {
					try {
						lastCtx?.ui.notify(message, "info");
					} catch {
						/* cosmetic */
					}
				},
				render: formatExocomQueuedBatchToast,
				setTimer: (fn, ms) => {
					const h = setTimeout(fn, ms);
					h.unref?.();
					return h;
				},
				clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
				debounceMs: 200,
			});
			exocomPlane = new ExocomPlane({
				agentDir,
				hash,
				identity: {
					session_id: sessionId,
					name: exocomName,
					persona,
					purpose: controller.activePersona?.description ?? "",
					color: exocomColorFor(exocomName),
					model,
					endpoint: ep,
					cwd: ctx.cwd,
				},
				getCard: () => ({
					name: exocomName,
					persona: sanitizePeerField(controller.activePersona?.name ?? "", 48),
					model: sanitizePeerField(lastCtx?.model ? `${lastCtx.model.provider}/${lastCtx.model.id}` : "", 96),
					context_pct: Math.round(lastCtx?.getContextUsage()?.percent ?? 0),
					inbox: exocomNotifier?.peekPending().length ?? 0,
				}),
				onInbound: (msg, fromEntry) => {
					// A full inbox is REFUSED, never silently queued forever: the sender's budget
					// (SENDER_MAX_MSGS per sender, unbounded senders) can outrun what an idle-gated
					// receiver drains, and an unbounded queue would grow monotonically, delay every fresh
					// message behind the backlog, and lose the lot at the next teardown. The nack tells
					// the peer its message did not land, so it can retry — checked BEFORE
					// buildInboundDelivery so the refused message is not recorded as seen and the retry
					// is not swallowed as a duplicate.
					const queued = exocomNotifier?.peekPending().length ?? 0;
					if (queued >= EXOCOM_INBOX_MAX) {
						if (!exocomInboxFull) {
							exocomInboxFull = true;
							try {
								lastCtx?.ui.notify(`exocom: inbox full (${queued} undelivered peer messages) — refusing further messages until it drains.`, "warning");
							} catch {
								/* cosmetic */
							}
						}
						return { accepted: false, reason: `receiver inbox full (${queued} queued) — retry once it drains` };
					}
					exocomInboxFull = false;
					// Attribution from the REGISTRY entry keyed by the connecting session — never from
					// msg.from_name (the envelope's own self-report, not to be trusted; see inbound.ts).
					// Sanitized (I2): fromEntry.name/persona are PEER-WRITTEN registry fields, and
					// The inbound builder places this label OUTSIDE the quote — a CR/LF-laden name must
					// not be able to inject pseudo-instructions there.
					const peerName = sanitizePeerField(
						fromEntry ? (exocomPlane?.humanDisplayLabelFor(fromEntry) ?? fromEntry.name) : msg.from_session,
						48,
					) || "peer";
					const peerPersona = sanitizePeerField(fromEntry?.persona ?? "", 48);
					const label = peerPersona ? `${peerName} (${peerPersona})` : peerName;
					// The reply hint is a stable qualified token from the authenticated registry entry,
					// not the human display name. Raw names are shared by live twins and can become stale
					// between delivery and the model's reply; the plane caches this token with the sender's
					// endpoint/key so it remains routable even after registry pruning. Attribution remains
					// the separate sanitized human label above.
					const replyTarget = fromEntry ? exocomPlane?.replyTargetFor(fromEntry) : undefined;
					const decision = buildInboundDelivery(msg, label, {
						budget: exocomBudget!,
						seen: exocomSeen!,
						injectMaxBytes: EXOCOM.INJECT_MAX_BYTES,
						...(replyTarget ? { replyTarget } : {}),
					});
					const disposition = exocomInboundDisposition(decision);
					if ("deliver" in decision) {
						exocomNotifier?.notify(decision.deliver);
						// Never inject peer text into a live model turn. A compact human-only toast makes
						// receipt visible while a long tool loop keeps the follow-up idle-gated.
						if (lastCtx?.isIdle?.() !== true) {
							exocomToastNotifier?.notify({ label, inReplyTo: msg.in_reply_to });
						}
					}
					// Plane accounting happens after this callback returns. Defer the render one
					// microtask so the inbound counter shown in the widget is the post-ACK value.
					queueMicrotask(() => {
						if (disposed) return;
						try {
							renderExocomWidget();
						} catch {
							/* cosmetic */
						}
					});
					return disposition;
				},
				onPoolChange: () => renderExocomWidget(),
			});
			await exocomPlane.start();
			renderExocomWidget();
			// A throw from a bare timer callback is an uncaughtException — it would take the whole host
			// session down over a transient registry write error (a full volume, an AV-held destination,
			// a prune racing our rename). exocom failures must never block a normal session, so the tick
			// is contained here; a failure that PERSISTS is still surfaced (see the report policy) rather
			// than leaving the user with a plane no peer can see.
			exocomHeartbeat = setInterval(() => {
				try {
					exocomHeartbeatTick(agentDir, hash, sessionId, ep, ctx.cwd);
					exocomHeartbeatFailures = 0;
				} catch (err) {
					exocomHeartbeatFailures += 1;
					const message = err instanceof Error ? err.message : String(err);
					if (process.env.PI_PERSONA_DEBUG) {
						process.stderr.write(`[pi-persona] exocom: heartbeat failed (${exocomHeartbeatFailures}×): ${message}\n`);
					}
					if (shouldReportHeartbeatFailure(exocomHeartbeatFailures)) {
						try {
							lastCtx?.ui.notify(
								`exocom: heartbeat failed ${exocomHeartbeatFailures}× in a row (${message}) — peers drop this instance from the pool until it recovers.`,
								"warning",
							);
						} catch {
							/* cosmetic */
						}
					}
				}
			}, EXOCOM.HEARTBEAT_MS);
			exocomHeartbeat.unref?.();
			// Makes maxDeliveries a per-MINUTE ceiling (R6) instead of a one-shot lifetime cap.
			exocomResetTimer = setInterval(() => exocomNotifier?.resetDeliveries(), 60_000);
			exocomResetTimer.unref?.();
			// I3: a LIVE accessor, not the plane object itself — `stopExocom` nulls `exocomPlane` on a
			// `canUseBus` downgrade, and the tool bodies re-read it on every call, failing closed
			// once it's gone (pi has no `unregisterTool`, so this is how revocation is made real).
			registerExocomTools(pi, () => exocomPlane, (raw) => {
				// The model's free-choice call-sign. Sanitized (a display label — strip control chars
				// via sanitizeLabel, clamp to 32) so a crafted name can't break the widget/attribution;
				// empty after sanitizing ⇒ keep the current one. Rewrite the entry at once so peers see it.
				const chosen = sanitizePeerField(raw, 32);
				if (chosen) {
					exocomName = chosen;
					exocomHeartbeatTick(agentDir, hash, sessionId, ep, ctx.cwd);
				}
				return exocomName;
			});
		} catch (err) {
			// `plane.start()` may have bound its server before a later registry write failed.
			// Teardown while the reference is still owned; this also cancels notifier/timers.
			await stopExocom();
			const message = err instanceof Error ? err.message : String(err);
			try {
				ctx.ui.notify(`exocom failed to start: ${message}`, "error");
			} catch {
				/* the session may already be tearing down */
			}
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] exocom: failed to start: ${message}\n`);
		}
	}

	function syncExocomActiveTools(): void {
		try {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const active = new Set(pi.getActiveTools());
			const enabled = exocomPlane !== undefined && (controller.capabilities?.canUseBus ?? true);
			let changed = false;
			for (const name of EXOCOM_TOOL_NAMES) {
				if (!available.has(name)) continue;
				if (enabled && !active.has(name)) {
					active.add(name);
					changed = true;
				} else if (!enabled && active.delete(name)) {
					changed = true;
				}
			}
			if (changed) pi.setActiveTools([...active]);
		} catch {
			/* a stale runtime is already shutting down; live tool getters still fail closed */
		}
	}

	// Idempotent: recompute the gate and start/stop the plane to match. `startExocom` only ever
	// runs at `session_start`, so a mid-session persona change (a/persona switch, the f8 cycle)
	// would otherwise leave a stale decision in place until the next heartbeat (up to
	// HEARTBEAT_MS later) — or, worse, never revoke a plane that should now be denied
	// (containment leak: the persona changed to one whose canUseBus is false, but the plane, its
	// tools, and inbound delivery all keep running under the OLD identity). Every other canUseBus
	// consumer (engine/adapter.ts, engine/inproc.ts, the buildEngine call sites) reads
	// `controller.capabilities` FRESH at bind time — this does the same for exocom. Already
	// running and still gated on ⇒ a no-op (the heartbeat already relabels under the new persona).
	async function applyExocomGate(ctx: ExtensionContext): Promise<void> {
		const shouldRun = (config.exocom || pi.getFlag("exocom") === true) && (controller.capabilities?.canUseBus ?? true);
		if (shouldRun && !exocomPlane) await startExocom(ctx);
		else if (!shouldRun && exocomPlane) await stopExocom();
		syncExocomActiveTools();
	}
	// Lifecycle transitions run ONE AT A TIME. `startExocom` publishes `exocomPlane` synchronously
	// but then suspends inside `plane.start()`'s bind, so an overlapping transition (rapid f8
	// cycling into a canUseBus:false persona; a Ctrl+C during startup) would otherwise tear down a
	// plane that has not finished starting: `plane.stop()` closes nothing (no server assigned yet),
	// then `start()` resumes and keeps a bound socket plus a fresh registry entry for a plane the
	// extension has already discarded. EVERY start/stop goes through this queue — the shutdown
	// teardown included, since it is the transition most likely to race a still-pending start.
	let exocomReconcile: Promise<void> = Promise.resolve();
	function queueExocom(op: () => Promise<void>): Promise<void> {
		const next = exocomReconcile.then(op);
		// A rejected transition must not wedge every later one behind it (startExocom already
		// degrades on its own; this only keeps the queue's tail alive).
		exocomReconcile = next.catch(() => {});
		return next;
	}
	function reconcileExocom(ctx: ExtensionContext): Promise<void> {
		return queueExocom(() => applyExocomGate(ctx));
	}

	// Every mid-session persona change funnels through here. Besides re-gating exocom, the incoming
	// persona starts with a clean by-hand run: the nudge's streak, cumulative burn, and backoff
	// belong to the persona that accumulated them (nudge.ts's reset contract), so leaving them in
	// place would bill persona A's sweep to B's first command — and let A's fired nudges suppress
	// B's legitimate early ones.
	async function onPersonaChanged(ctx: ExtensionContext): Promise<void> {
		delegationNudge.reset();
		await reconcileExocom(ctx);
	}

	// Clean shutdown: stop timers, best-effort `bye` + registry cleanup (plane.stop()). Pi's own
	// session_shutdown already fires on Ctrl+C/SIGHUP/SIGTERM (not just a normal exit), so wiring
	// teardown only here — like the broker teardown above — covers every exit path without a
	// redundant raw process.on(SIGINT/SIGTERM) handler.
	async function stopExocom(): Promise<void> {
		if (exocomHeartbeat) {
			clearInterval(exocomHeartbeat);
			exocomHeartbeat = undefined;
		}
		exocomHeartbeatFailures = 0; // a later re-start reports its own first failure, not this plane's tail
		if (exocomResetTimer) {
			clearInterval(exocomResetTimer);
			exocomResetTimer = undefined;
		}
		exocomNotifier?.cancel();
		exocomNotifier = undefined;
		exocomInboxFull = false; // a later plane reports its own first full inbox, not this one's tail
		exocomToastNotifier?.cancel();
		exocomToastNotifier = undefined;
		exocomBudget = undefined;
		exocomSeen = undefined;
		if (exocomPlane) {
			const plane = exocomPlane;
			exocomPlane = undefined;
			try {
				await plane.stop();
			} catch {
				/* never block shutdown on a teardown error */
			}
		}
		try {
			lastCtx?.ui.setWidget("persona-exocom", undefined, { placement: "aboveEditor" });
		} catch {
			/* cosmetic */
		}
		try {
			lastCtx?.ui.setStatus("persona-exocom", undefined);
		} catch {
			/* cosmetic */
		}
	}

	function buildEngine(signal?: AbortSignal, onProgress?: (s: ProgressSnapshot) => void, engOpts?: { async?: boolean }): StrategyEngine {
		const resolveAgent = (n: string): AgentConfig | undefined => agents.find((a) => a.name === n);
		// A named contract file (contracts/<name>.contract.json) wins; "default" is the built-in.
		const contracts = (n: string): ContractDef | undefined => contractDefs[n] ?? (n === "default" ? DEFAULT_CONTRACT : undefined);
		const modelFor = (agent: string): string | undefined => {
			const persona = controller.activePersona?.name;
			return persona ? personaModels(personaConfigs, persona)[agent] : undefined;
		};
		// The main model thinks adaptively (it picks effort by difficulty); a spawned child
		// can't inherit "adaptive" if its model doesn't support it, so give children an
		// explicit level — the supervisor's (if concrete) or a sane default, overridable.
		const supLevel = host.getThinkingLevel();
		const childThinking = config.childThinking ?? (isThinkingLevel(supLevel) ? supLevel : "high");

		// A persona that opted out of the layer (`spine: false`) opts its legs out too — otherwise
		// a short verdict persona (judge/verify/audit) would still pay for the baseline on every
		// sub-agent it spawns. The per-AGENT opt-out applies on top, inside each engine.
		const legSpine = controller.activePersona?.spine === false ? "" : workerSpineText;

		// Cross-process broker (spec B1-B7): lazily built on the FIRST actual child-engine
		// construction below (worktree leg OR `PI_PERSONA_ENGINE=child`) — NOT on every
		// `buildEngine` call, most of which build the (default) in-process engine and never
		// touch a child at all; starting a host for those would be neither lazy nor needed.
		// Memoized so both call sites below share ONE broker object (and its `peerGroup`
		// registration) per `buildEngine` invocation. `config.broker` off (default) or no live
		// `ctx` yet ⇒ stays undefined forever, so `deps.broker` is never set (the default-OFF pin).
		let brokerDepsMemo: EngineAdapterBroker | undefined;
		let brokerDepsBuilt = false;
		const getBrokerDeps = (): EngineAdapterBroker | undefined => {
			if (!brokerDepsBuilt) {
				brokerDepsBuilt = true;
				if (config.broker && lastCtx) brokerDepsMemo = makeBrokerDeps(lastCtx);
			}
			return brokerDepsMemo;
		};

		// A child-process engine pinned to a specific cwd — the seam worktree isolation runs
		// through (a worktree needs its own working dir, i.e. a separate process).
		const childEngineAt = (cwd: string): StrategyEngine => {
			const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking, cwd };
			deps.listAgents = () => agents.map((a) => a.name);
			if (legSpine) deps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
			if (signal) deps.signal = signal;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs, hardTimeoutMs: config.agentHardTimeoutMs, startupTimeoutMs: config.agentStartupTimeoutMs };
			// Feed progress here too (mirrors the plain-child branch): without it a worktree/mcp async leg
			// never advances its tracker snapshot, so lastAdvanceAt freezes at launch and the leg is falsely
			// flagged stalled while a genuine later wedge goes undetected.
			if (onProgress) deps.childOptions.onProgress = onProgress;
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
			// only for async runs — same guards as the inproc engine below (spec B7 / §4.9).
			const caps = controller.capabilities;
			if (caps) deps.canUseBus = caps.canUseBus;
			if (engOpts?.async) deps.allowBlocking = true;
			return engineFactories.makeEngine(deps);
		};

		// v0.4: run sub-agents in-process (createAgentSession) instead of spawning `pi -p`.
		let base: StrategyEngine;
		if (config.engine === "inproc" && lastCtx) {
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=inproc\n");
			const ideps: InProcessDeps = { resolveAgent, contracts, modelFor, childThinking, modelRegistry: lastCtx.modelRegistry, cwd: lastCtx.cwd, agentDir: userAgentDir() };
			ideps.listAgents = () => agents.map((a) => a.name);
			if (legSpine) ideps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
			ideps.timeoutMs = RUN_LIMITS.timeoutMs; // idle watchdog — a hung session must settle, like the child engine's idle kill
			ideps.hardTimeoutMs = config.agentHardTimeoutMs; // hard lifetime ceiling — catches a busy loop the idle watchdog never would
			ideps.startupTimeoutMs = config.agentStartupTimeoutMs; // first-progress deadline — fast-fail a child that never started
			if (signal) ideps.signal = signal;
			if (onProgress) ideps.onProgress = onProgress;
			if (lastCtx.model) ideps.defaultModel = `${lastCtx.model.provider}/${lastCtx.model.id}`;
			// Comm plane: a `coaching: on` persona gives its children `contact_supervisor`.
			// Blocking asks are honoured only for async runs (a sync run holds the turn → it
			// can't answer, so blocking there would deadlock; the tool downgrades to one-way).
			ideps.bus = bus;
			ideps.supervisorHandle = SUPERVISOR;
			if (controller.activePersona?.coaching) ideps.coaching = true;
			// Peer messaging obeys the persona's bus capability (canUseBus; Task: sibling peer comm).
			const caps = controller.capabilities;
			if (caps) ideps.canUseBus = caps.canUseBus;
			if (engOpts?.async) ideps.allowBlocking = true;
			base = engineFactories.makeInProcessEngine(ideps);
		} else {
			if (process.env.PI_PERSONA_DEBUG) process.stderr.write("[pi-persona] engine=child\n");
			const deps: EngineAdapterDeps = { resolveAgent, contracts, modelFor, childThinking };
			deps.listAgents = () => agents.map((a) => a.name);
			if (legSpine) deps.spine = legSpine; // legs get the worker variant (docs/SPINE.md)
			if (signal) deps.signal = signal;
			if (lastCtx?.cwd) deps.cwd = lastCtx.cwd;
			deps.childOptions = { timeoutMs: RUN_LIMITS.timeoutMs, hardTimeoutMs: config.agentHardTimeoutMs, startupTimeoutMs: config.agentStartupTimeoutMs }; // idle watchdog + hard cap + startup deadline on every child
			if (onProgress) deps.childOptions.onProgress = onProgress;
			const brokerDeps = getBrokerDeps();
			if (brokerDeps) deps.broker = brokerDeps;
			// Peer messaging obeys the persona's bus capability, and blocking asks are honoured
			// only for async runs — same guards as the inproc engine above (spec B7 / §4.9).
			const caps = controller.capabilities;
			if (caps) deps.canUseBus = caps.canUseBus;
			if (engOpts?.async) deps.allowBlocking = true;
			base = engineFactories.makeEngine(deps);
		}

		// Worktree isolation: an agent/leg marked `isolation: worktree` runs in a throwaway git
		// worktree via the child engine (its edits never touch the main tree), regardless of the
		// default backend. This branch is deliberately fail-closed: a missing/dirty repository or
		// failed worktree creation is a contract failure, never permission to run in the real cwd.
		// Provider fallback (outermost): a run whose model PROVIDER fails at call time (auth,
		// outage, 5xx, model-not-supported) is retried on the same model id under another
		// authenticated provider — "priority to the supervisor's provider, but try others and
		// switch on error". No ctx (no registry) ⇒ pass through. Each attempt still runs through
		// worktree isolation + steering below.
		const wrapFallback = (eng: StrategyEngine): StrategyEngine => {
			if (!lastCtx) return eng;
			const prefer = lastCtx.model?.provider;
			return withModelFallback(eng, { models: configuredModels(lastCtx), ...(prefer ? { preferProvider: prefer } : {}) });
		};
		const root = lastCtx?.cwd;
		return wrapFallback({
			async run(spec, perProgress, perSignal, perSteer) {
				const iso = spec.isolation ?? resolveAgent(spec.agent)?.isolation;
				if (iso === "worktree") {
					if (!root) {
						return isolatedWorktreeFailure(spec, "worktree isolation requires a real Git cwd; remove isolation: \"worktree\" or run inside a Git checkout");
					}
					const preflight = worktreePreflight(root, defaultGitExec);
					if (!preflight.ok) return isolatedWorktreeFailure(spec, preflight.error);
					try {
						return await withWorktree(root, defaultGitExec, async (dir) => {
							const result = await childEngineAt(dir).run({ ...spec, isolation: "none" }, perProgress, perSignal, perSteer);
							const artifact = captureWorktreeArtifact(dir, defaultGitExec);
							const hasOutputArtifact = hasUnifiedDiff(result.output);
							if (!result.ok) {
								return artifact.ok && artifact.diff.trim().length > 0
									? appendWorktreeArtifact(result, artifact.diff)
									: result;
							}
							if (!artifact.ok) {
								if (hasOutputArtifact) return result;
								return isolatedWorktreeFailure(spec, `${artifact.error}; the isolated leg returned success without an exportable diff/artifact`);
							}
							if (artifact.diff.trim().length > 0) return appendWorktreeArtifact(result, artifact.diff);
							if (hasOutputArtifact) return result;
							return isolatedWorktreeFailure(
								spec,
								"isolated leg returned success but produced no unified diff or artifact; its worktree was discarded — return a complete diff or remove isolation: \"worktree\"",
							);
						});
					} catch (err) {
						return isolatedWorktreeFailure(spec, err instanceof Error ? err.message : String(err));
					}
				}
				// MCP-capable leg: the DEFAULT in-process engine never fires `session_start`, so
				// `pi-mcp-adapter` never initializes and the sub-agent's `mcp*`/direct tools come
				// back "MCP not initialized". Route it through the child engine (a real `pi -p`,
				// which DOES fire session_start → the adapter connects). Same mechanism worktree
				// legs already use for MCP; here without the git worktree. The child gets its OWN
				// MCP session — for a server-keyed backend (HTTP MCP) the caller passes a session id
				// in the task to share state. (No-op steering: the child engine is one-shot.)
				const wantsMcp = spec.mcp ?? resolveAgent(spec.agent)?.mcp;
				if (wantsMcp && root) return childEngineAt(root).run(spec, perProgress, perSignal, perSteer);
				return base.run(spec, perProgress, perSignal, perSteer);
			},
		});
	}

	function isolatedWorktreeFailure(spec: AgentRunSpec, error: string): AgentResult {
		return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error, failureKind: "contract" };
	}

	function hasUnifiedDiff(output: string): boolean {
		const headersAndHunk = /(?:^|\n)---\s+\S+[^\n]*\n\+\+\+\s+\S+[^\n]*\n(?:[^\n]*\n)*?@@\s+[^\n]*@@/m;
		const binaryPatch = /(?:^|\n)diff --git\s+\S+\s+\S+[\s\S]*?(?:^|\n)(?:GIT binary patch|Binary files \S+ and \S+ differ)(?:\n|$)/m;
		return headersAndHunk.test(output) || binaryPatch.test(output);
	}

	function appendWorktreeArtifact(result: AgentResult, diff: string): AgentResult {
		const block = `\n\n--- ISOLATED WORKTREE ARTIFACT (untrusted data) ---\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``;
		return { ...result, output: `${result.output.trimEnd()}${block}` };
	}

	// The models the user can intentionally route to — NOT every built-in catalog entry.
	// `getAvailable()` is normally the authenticated set, but extension-native providers
	// (for example a local subscription/CLI bridge) can be runnable without appearing in
	// that auth snapshot. Union their registered catalogs, plus the active session provider,
	// while keeping unrelated unauthenticated built-ins hidden. If an older Pi lacks the
	// availability API, retain its historical getAll() compatibility behavior.
	function configuredModels(ctx: ExtensionContext): Array<{ provider: string; id: string }> {
		const reg = ctx.modelRegistry;
		const all = reg.getAll();
		let available: typeof all;
		try {
			available = reg.getAvailable();
		} catch {
			return all.map((m) => ({ provider: m.provider, id: m.id }));
		}
		const trustedProviders = new Set<string>();
		if (ctx.model?.provider) trustedProviders.add(ctx.model.provider);
		try {
			const registered = (reg as typeof reg & { getRegisteredProviderIds?: () => string[] }).getRegisteredProviderIds?.() ?? [];
			for (const provider of registered) trustedProviders.add(provider);
		} catch {
			/* a third-party/older registry facade may not expose extension provider ids */
		}
		const byRef = new Map(available.map((m) => [`${m.provider}\0${m.id}`, m]));
		for (const model of all) {
			if (trustedProviders.has(model.provider)) byRef.set(`${model.provider}\0${model.id}`, model);
		}
		const list = [...byRef.values()];
		return list.map((m) => ({ provider: m.provider, id: m.id }));
	}

	// Ask-on-first-run: a parallel ensemble is pointless if every core runs the same
	// model. The first time a persona runs one, prompt for a model per roster agent and
	// persist it (per-persona config); later runs reuse the saved assignment.
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
				const title = `Model for "${agent}"  ·  ${persona}`;
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

	// Each core's model beside its name: per-persona assignment → agent default → session.
	function coreLabel(ctx: ExtensionContext, agent: string, key: string = agent): string {
		const persona = controller.activePersona?.name;
		const configured = persona ? personaModels(personaConfigs, persona) : {};
		const model =
			configured[agent] ?? agents.find((a) => a.name === agent)?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const short = shortModel(model);
		// `key` is the disambiguated node id (`agent` for a solo member, `agent · HINT` for a
		// roster-role one) — display that + the model, so three `reviewer` lenses read distinctly.
		return short ? `${key} · ${short}` : key;
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
					agentTree.add({ id, label: coreLabel(ctx, agent, nodeKey), parentId: rootId, status: "running", detail: "" });
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
				const patch: { output?: string; detail?: string } = {
					detail: p.activity || (p.tokens ? `${compactTokens(p.tokens)} tok` : ""),
				};
				if (p.output) patch.output = p.output;
				agentTree.update(id, patch);
			},
		};
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
		agentTree.add({ id: rootId, label, status: "running" });
		// Seed the whole roster at once (cores show by name immediately); "queued" until the
		// engine actually starts each one — an honest view under the concurrency limit.
		const seedKeys = rosterNodeKeys(roster);
		roster.forEach((m, i) => {
			const a = rosterSpec(m).agent;
			const key = seedKeys[i] ?? a;
			agentTree.add({ id: `${rootId}/${key}`, label: coreLabel(ctx, a, key), parentId: rootId, status: "running", detail: "queued" });
		});
		try {
			// The signal goes to the STRATEGY as well as the engine: a multi-round strategy checks it
			// cooperatively between rounds, so an aborted run stops convening instead of running every
			// remaining round against an already-cancelled engine (docs/STRATEGIES.md).
			return await runPersonaStrategy(orch, task, { engine: buildEngine(signal), teams, limits: RUN_LIMITS, ...(signal ? { signal } : {}), ...strategyTreeDeps(ctx, rootId) });
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
		return found === undefined ? undefined : parseFlow(found);
	}

	// Run a flow's DAG with the unified tree (phases as nodes, cores beneath) + journaled
	// resume: a prior run's journal (keyed by flow@hash) skips already-done phases; the
	// journal is cleared on a fully-successful run.
	async function runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, baseTask: string, signal?: AbortSignal) {
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
		agentTree.add({ id: flowRoot, label: `flow ${spec.name}`, status: "running" });
		for (const p of spec.phases) {
			const pid = `${flowRoot}/${p.id}`;
			const node: AddNodeInput = { id: pid, label: `${p.id} · ${p.strategy}`, parentId: flowRoot, status: resume[p.id] ? "done" : "running" };
			if (resume[p.id]) node.detail = "resumed";
			agentTree.add(node);
		}
		try {
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
						agentTree.add({ id: `${pid}/${key}`, label: coreLabel(ctx, a, key), parentId: pid, status: "running", detail: "queued" });
					});
					const orch: OrchestrationGrammar = { mode: "strategy", strategy: phase.strategy, params: phase.params ?? {} };
					if (phase.roster) orch.roster = phase.roster;
					const r = await runPersonaStrategy(orch, task, {
						engine: buildEngine(signal),
						teams,
						limits: RUN_LIMITS,
						...(signal ? { signal } : {}), // cooperative per-round abort inside the phase's strategy, not just the engine
						...strategyTreeDeps(ctx, pid),
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
			return outcome;
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

	// ── lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		delegationNudge.reset(); // a fresh session starts with a clean by-hand run
		// Opt-in only (PI_PERSONA_SEED=on): auto-install the bundled defaults once. Default is off —
		// a fresh install shows no personas until `/persona seed` or `/persona restore`.
		if (config.seed && !existsSync(seedMarker())) {
			try {
				const r = runSeed(false);
				reportSeedSourceCollisions(ctx, r);
				// Resolution happened before session_start, when a fresh install had no user copy. Refresh
				// now so this very process uses what auto-seed just created and reports only post-seed state.
				refreshSpineAfterSeed();
				if (ctx.hasUI && r.copied.length > 0) {
					ctx.ui.notify(`pi-persona: seeded ${r.copied.length} default(s) to ${personaDataDir()} — edit them freely; /persona restore brings back the originals.`, "info");
				}
			} catch {
				// Seeding is multi-file: an error can arrive after the prompt itself was copied. Re-resolve
				// and retry only enabled legacy roles so partial progress is visible in this same process.
				inspectEnabledLegacySpines();
			}
		}
		reportSeedMigration(ctx, seedMigration);
		reportSpineWarning(ctx);
		reload(ctx.cwd);
		reportDefinitionCollisions(ctx);
		personaConfigs = readConfigStore();
		// Restore order: --persona flag > env pin (PI_PERSONA_DEFAULT) > remembered-on-disk. Read-only.
		const flagPersona = ((pi.getFlag("persona") as string) || "").trim();
		const remembered = flagPersona || config.defaultPersona || readRememberedPersona();
		const target = remembered ? personas.find((p) => p.name === remembered) : undefined;
		if (target) await controller.activate(target);
		else {
			// A name that doesn't resolve leaves the session with NO persona at all, whichever source it
			// came from — and silence there reads as "it's active" while nothing is (downstream tooling
			// keyed on the remembered name, e.g. per-persona memory, then serves a persona that was never
			// activated). An EXPLICIT `--persona` is a direct instruction, so it stays an error; an env
			// pin or a stale remembered name is a warning. The marker itself is deliberately NOT cleared:
			// personas are discovered per-cwd, so a name that is missing here may be present in the
			// project the user came from. The model (`--model`) and effort (`--thinking`) are pi's own
			// flags — pi validates those.
			if (remembered) {
				const names = personas.map((p) => p.name).sort().join(", ") || "(none installed — run /persona seed)";
				const source = flagPersona ? "--persona" : config.defaultPersona ? "PI_PERSONA_DEFAULT" : "remembered persona";
				const msg = `pi-persona: ${source} "${remembered}" is not an installed persona. Available: ${names}`;
				if (ctx.hasUI) ctx.ui.notify(msg, flagPersona ? "error" : "warning");
				else process.stderr.write(`${msg}\n`);
			}
			host.setStatus(controller.activePersona?.label);
		}
		await reconcileExocom(ctx); // after persona activation, so plane + active tools share one gate
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		disposed = true; // gate any late async-run onComplete from touching the next session's instance
		deferredOrchestrations.length = 0;
		pendingOrchestration = undefined;
		stopPeek(); // reload-hygiene: never leak the idle-peek timer across sessions
		peekWatcher.reset(); // …nor a stale "already surfaced this leg as stuck" set into the next session
		completionNotifier.cancel(); // …nor the coalesced-delivery flush timers
		intercomNotifier.cancel();
		exocomNotifier?.cancel(); // …nor a late exocom follow-up (M1) — cancelled BEFORE stopExocom tears down the plane below
		timerScheduler.cancelAll(); // …nor any armed alarms (never wake the next session)
		timerNotifier.cancel();
		// This instance is being torn down (a reload/new/resume rebinds a fresh one); abort in-flight
		// sub-agents and reset control state so nothing is left orphaned or rendered stale.
		for (const abort of [...stopRegistry.values()]) {
			try {
				abort();
			} catch {
				/* ignore */
			}
		}
		stopRegistry.clear();
		stopRequested.clear();
		steerRegistry.clear();
		agentTree.clear();
		host.setStatus(undefined);
		// Queued, not called bare: a shutdown that lands while session_start's own start is still
		// pending would otherwise see `exocomPlane` unset, no-op, and let that start bind a socket
		// and register an entry for a session that no longer exists. Idempotent either way — off
		// (or never started) ⇒ a no-op.
		await queueExocom(() => stopExocom());
		// Broker teardown (spec B1/B5): idempotent — a session that never built a broker-backed
		// child engine (flag off, or on but unused) never started a host, so this is a no-op.
		if (brokerHostPromise) {
			try {
				const h = await brokerHostPromise;
				await h.close();
			} catch {
				/* best-effort — never block shutdown on a broker teardown error */
			}
			brokerHost = undefined;
			brokerHostPromise = undefined;
			brokerPeers.clear();
		}
	});

	// Pi marks the session idle before emitting agent_settled. A deferred mandatory input owns this
	// idle window first; its replay starts the next run and the remaining FIFO entries follow one per
	// settlement. With no deferred input, flush ordinary wakes immediately.
	pi.on("agent_settled", async () => {
		if (await processNextDeferredOrchestration()) return;
		completionNotifier.kick();
		intercomNotifier.kick();
		timerNotifier.kick();
		exocomNotifier?.kick();
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		// The spine lifts persona-less turns too: with nothing active the composition is Pi's base
		// prompt + the layer. Off ⇒ `spineText` is empty and this is `event.systemPrompt` itself.
		const noPersona = spineText ? `${event.systemPrompt}\n\n${spineText}` : event.systemPrompt;
		let prompt = controller.composePrompt(event.systemPrompt, spineText) ?? noPersona;
		// The session time anchor (core/time.ts). Unconditional, unlike both briefs below: a supervisor
		// that has been working for hours needs to know it whether or not agents or peers exist. It goes
		// in the SYSTEM prompt because the prompt is re-composed and re-sent every turn rather than
		// summarized, so an anchor placed here cannot be compacted away — the same fact in the
		// conversation tail would be. Its start comes from the session HEADER, the first entry of the
		// append-only session file, so after /resume it is still the ORIGINAL start: that is what makes it
		// answer "how long have I been on this problem" across restarts and not merely across turns.
		// Placed BEFORE the briefs so the standing hand-off default keeps the last word at the tail; the
		// elapsed reading is bucketed so this block stays byte-identical across an hour of turns.
		const anchor = buildSessionAnchor(ctx.sessionManager?.getHeader?.() ?? null, Date.now());
		if (anchor) prompt = `${prompt}\n\n${anchor}`;
		const brief = delegationBrief(ctx);
		if (brief) prompt = `${prompt}\n\n${brief}`;
		// Per-turn exocom peer AWARENESS (mirrors the delegation brief above): regenerated from the
		// live registry every turn so it cannot desync, and gated implicitly — exocomPlane is only
		// set when exocom is on AND canUseBus, so this is a no-op (undefined ⇒ no prompt change)
		// whenever exocom is off, matching every other opt-in surface in this file.
		if (exocomPlane) {
			const peers = exocomPlane.listPeers();
			const xcaps = controller.capabilities;
			// Holding the bus says nothing about `delegate` (canUseBus keys off `intercom` alone), so
			// read the persona the way delegationBrief does — absent capabilities ⇒ unrestricted — but
			// gate on a REACHABLE target, which is stricter than delegationBrief: that one still renders
			// (with `installedCount`, to say "your allowlist filtered everything away") when fan-out is
			// allowed and no target survives, whereas urging a peer-vs-sub-agent split with nothing to
			// delegate to would point the model at a call the gate refuses.
			// `canFanOut(xcaps)` is defence in depth, not a live branch: `resolveCapabilities` empties
			// `delegateTargets` whenever the delegate tool is absent (core/capabilities.ts), so the
			// second conjunct already implies the first and no test can kill the first alone. Kept
			// because it states the structural rule the second conjunct only happens to encode.
			const canDelegate = xcaps ? canFanOut(xcaps) && agents.some((a) => canDelegateTo(xcaps, a.name)) : agents.length > 0;
			const xbrief = buildExocomBrief(peers.map((p) => ({ name: p.displayName, persona: p.persona })), {
				canDelegate,
				// Exocom has no UI gate, so a headless (`pi -p`) run has live peers and no way to ask
				// anyone anything. `hasUI` is pi's dialog capability, not a headcount (see the field's
				// doc) — but the clause it gates is an ask, and an ask needs a channel, not a person.
				canAskHuman: ctx.hasUI === true,
			});
			if (xbrief) prompt = `${prompt}\n\n${xbrief}`;
		}
		if (pendingOrchestration) {
			// The result is sub-agent text entering the SYSTEM prompt — fence it (I-guardrail:
			// untrusted output must never reach the supervisor unfenced, least of all here).
			if (pendingOrchestration.ok) {
				// Keep the established success hand-off byte-for-byte: successful mandatory runs are
				// still rulings the supervisor should present without spending the same council twice.
				prompt = `${prompt}\n\n[orchestration: ${pendingOrchestration.label}] The mandated multi-agent orchestration was run on the user's request and produced the result below. Present and build on it as your answer — do not re-run it:\n\n${fenceUntrusted(pendingOrchestration.output)}`;
			} else {
				const evidence = pendingOrchestration.error && pendingOrchestration.error !== pendingOrchestration.output
					? `${pendingOrchestration.output}\n\n--- RUNTIME ERROR ---\n${pendingOrchestration.error}`
					: pendingOrchestration.output;
				prompt = pendingOrchestration.failureKind === "abort"
					? `${prompt}\n\n[orchestration: ${pendingOrchestration.label}] The mandated multi-agent orchestration was CANCELLED. Report the cancellation; do not present its partial output as approved, and do not resume or re-run it unless the user explicitly asks:\n\n${fenceUntrusted(evidence)}`
					: `${prompt}\n\n[orchestration: ${pendingOrchestration.label}] The mandated multi-agent orchestration FAILED or remained unresolved. Do not present its output as approved or claim completion. Report the blocker, then repair and verify before declaring success:\n\n${fenceUntrusted(evidence)}`;
				reportMandatoryFailure(ctx, pendingOrchestration);
			}
			pendingOrchestration = undefined;
		}
		return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
	});

	pi.on("tool_call", (event, ctx) => {
		lastCtx = ctx;
		return controller.gate(event.toolName, event.input);
	});

	// Delegation nudge (config.nudge; delegating personas only): when the supervisor grinds a RUN of
	// hands-on commands by hand — a by-hand sweep with no hand-off — append a reminder to the
	// offending tool's result. It lands in RECENT context, on the very command that tripped it, where
	// a top-of-prompt persona directive has already lost its pull. Sub-agents run in their own
	// sessions, so this hook only ever sees the SUPERVISOR's own tools. A `delegate`/`council` result
	// resets the run.
	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		const errorPatch = piPersonaToolErrorPatch(event.details);
		if (!config.nudge) return errorPatch;
		// Only a supervisor that CAN delegate is nudged to — a persona without the tool can't act on it.
		if (!controller.capabilities?.tools.has("delegate")) return errorPatch;
		const notes: string[] = [];
		// Grinding-by-hand reminder: a RUN of substantive hands-on commands on the supervisor's own
		// tools (delegate/council reset the run). `size` classifies substantive vs glue + fat dump.
		const text = event.content.reduce((s, c) => (c.type === "text" ? s + c.text : s), "");
		const size = text.length;
		const sweepNote = delegationNudge.observe(event.toolName, size, !errorPatch && event.isError !== true, text);
		if (sweepNote) notes.push(sweepNote);
		// Premature-surrender reminder: a delegated leg that came back BLOCKED/UNKNOWN (delegate/council
		// results only; because delegate/council reset the run the two never fire on one event).
		const surrender = persistenceNudge.observe(event.toolName, text);
		if (surrender) notes.push(surrender);
		if (notes.length === 0) return errorPatch;
		return { ...errorPatch, content: [...event.content, { type: "text", text: notes.join("\n\n") }] };
	});

	// Mandatory orchestration: when the active persona declares a strategy/parallel/
	// pipeline mode (or a flow), run it on the user's turn (the LLM cannot skip it) and
	// fold the result into the prompt. Opportunistic personas (no orchestration) take the
	// normal turn.
	function mandatoryFailure(label: string, output: string, error: string, failureKind: FailureKind): MandatoryOutcome {
		return { label, output, ok: false, error, failureKind };
	}

	/** Make a mandatory failure visible outside the hidden system prompt too. The cause may contain
	 * provider/model text, so compact it to one bounded operator-facing line. */
	function reportMandatoryFailure(ctx: ExtensionContext, outcome: MandatoryOutcome): void {
		const label = outcome.label.replace(/\s+/g, " ").trim().slice(0, 120);
		const cause = (outcome.error ?? "unresolved result").replace(/\s+/g, " ").trim().slice(0, 500);
		const kind = outcome.failureKind ? ` [${outcome.failureKind}]` : "";
		const message = `pi-persona: mandatory orchestration ${label} failed${kind}: ${cause}`;
		try {
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
		} catch {
			// Diagnostics are best-effort; the fail-closed system-prompt hand-off remains authoritative.
		}
	}

	async function executeMandatoryOrchestration(
		ctx: ExtensionContext,
		orch: OrchestrationGrammar,
		task: string,
	): Promise<MandatoryOutcome> {
		const flowName = orch.mode === "flow" ? orch.flow : undefined;
		const label = flowName ? `flow ${flowName}` : (resolveStrategyName(orch) ?? "strategy");
		try {
			if (flowName) {
				const parsed = loadFlow(ctx.cwd, flowName);
				if (!parsed) {
					const error = `no flow named "${flowName}"`;
					return mandatoryFailure(label, error, error, "contract");
				}
				if (!parsed.ok) {
					const error = `flow "${flowName}" is invalid: ${parsed.error}`;
					return mandatoryFailure(label, error, error, "contract");
				}
				const outcome = await runFlowVisible(ctx, parsed.flow, task);
				const output = outcome.output || "(the flow returned no output)";
				if (outcome.ok) return { label, output, ok: true };
				const error = outcome.cancelled
					? "the mandatory flow was aborted"
					: (outcome.error ?? "the mandatory flow did not complete successfully");
				const failureKind = outcome.cancelled ? "abort" : (outcome.failureKind ?? "agent");
				return mandatoryFailure(label, output, error, failureKind);
			}

			const result = await runStrategyVisible(ctx, orch, task, "strategy");
			if (!result) {
				const error = "the mandatory orchestration returned no result";
				return mandatoryFailure(label, `(${error})`, error, "contract");
			}
			if (!result.ok) {
				return mandatoryFailure(
					label,
					result.output || "(the orchestration returned no output)",
					result.error ?? "the mandatory orchestration did not complete successfully",
					result.failureKind ?? "agent",
				);
			}
			return { label, output: result.output, ok: true };
		} catch (err) {
			const error = `orchestration failed: ${err instanceof Error ? err.message : String(err)}`;
			return mandatoryFailure(label, error, error, "agent");
		}
	}

	function enqueueDeferredOrchestration(
		task: string,
		orchestration: OrchestrationGrammar,
		ctx: ExtensionContext,
	): { action: "handled" } {
		if (deferredOrchestrations.length >= MAX_DEFERRED_ORCHESTRATIONS) {
			ctx.ui.notify(
				`persona orchestration queue full (${MAX_DEFERRED_ORCHESTRATIONS}); input was not accepted — retry after the current run settles.`,
				"error",
			);
			return { action: "handled" };
		}
		deferredOrchestrations.push({ task, orchestration });
		ctx.ui.notify(`persona orchestration queued (${deferredOrchestrations.length}) — it will run after the current turn settles.`, "info");
		return { action: "handled" };
	}

	async function processNextDeferredOrchestration(): Promise<boolean> {
		if (disposed || processingDeferredOrchestration || deferredOrchestrations.length === 0 || !lastCtx) return false;
		const item = deferredOrchestrations.shift()!;
		processingDeferredOrchestration = true;
		orchestrating = true;
		try {
			const result = await executeMandatoryOrchestration(lastCtx, item.orchestration, item.task);
			if (disposed) return false;
			pendingOrchestration = result;
			// Source is "extension", so the input hook will not orchestrate this replay again.
			sendPersonaFollowUp(pi, item.task, "pi-persona-deferred-input");
			return true;
		} catch (err) {
			pendingOrchestration = undefined;
			if (!disposed) {
				deferredOrchestrations.unshift(item);
				lastCtx.ui.notify(`could not replay deferred persona input: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return false;
		} finally {
			orchestrating = false;
			processingDeferredOrchestration = false;
		}
	}

	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") return undefined;
		const orch = controller.activePersona?.orchestration;
		const task = event.text?.trim();
		if (!orch || !task) return undefined;
		const flowName = orch.mode === "flow" ? orch.flow : undefined;
		let strategyName: string | undefined;
		try {
			strategyName = resolveStrategyName(orch);
		} catch (err) {
			// Only the persona FILE can fix this; take the turn normally rather than tearing the
			// input hook down on every keystroke, but say so loudly — the mandatory orchestration
			// the user configured is silently not happening.
			ctx.ui.notify(personaGrammarError(err), "error");
			return undefined;
		}
		if (!flowName && !strategyName) return undefined;
		const mainBusy = ctx.isIdle() !== true;
		// Steering belongs to the turn already in progress. Never start a competing mandatory
		// orchestration for it; Pi remains responsible for applying the steering message.
		if (mainBusy && event.streamingBehavior !== "followUp") return { action: "continue" };
		// Follow-up input must retain mandatory semantics without racing the live run. An input that
		// arrives while another orchestration is executing joins the same FIFO even if Pi is idle.
		if (mainBusy || orchestrating) return enqueueDeferredOrchestration(task, orch, ctx);
		orchestrating = true;
		try {
			pendingOrchestration = await executeMandatoryOrchestration(ctx, orch, task);
		} finally {
			orchestrating = false;
		}
		// Let the user's original prompt proceed; the ruling is injected (hidden) into the
		// turn's system prompt via before_agent_start — no internal plumbing in the chat.
		return undefined;
	});

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
			Type.String({ description: "Short codename for this sub-agent, `<call-sign>-<purpose>`: a distinctive call-sign you invent + what the leg does — e.g. 'orion-recon', 'hermes-debug', 'atlas-fuzz'. Pick a DIFFERENT call-sign for EVERY leg so two of the same kind stay apart (orion-recon vs vega-recon). A UI label only — not a task description." }),
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
		name: Type.Optional(Type.String({ description: "Short codename for the sub-agent, `<call-sign>-<purpose>`: a distinctive call-sign you invent + what the leg does — e.g. 'orion-recon', 'hermes-debug'. A UI label, not a task description (single mode)." })),
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
			Type.Integer({ minimum: 1, description: `Max children to run at once (default ${RUN_LIMITS.maxConcurrency}; larger requests are clamped)` }),
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
	const asyncSlots = new Semaphore(RUN_LIMITS.maxConcurrency);
	let asyncNameSequence = 0;

	// Runtime anti-loop guard: an identical (agent, model, task) delegation that failed
	// twice is vetoed BEFORE it spawns — the completion report's "don't re-issue" guidance
	// is advice; this is the enforcement (capabilities are never prompt-only).
	const ledger = new DelegationLedger({ ledgerV2: config.ledgerV2 });

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
		const configured = agents.find((agent) => agent.name === spec.agent);
		const effectiveTools = spec.tools !== undefined ? spec.tools : configured?.tools;
		const effectiveMcp = spec.mcp ?? configured?.mcp;
		return effectiveMcp === true || effectiveTools === undefined || effectiveTools.some((tool) => !readOnlyTools.has(tool));
	}

	// Launch one agent in the background (tracked) and add its live async node to the tree.
	// `label` is the bare codename (nameFor) — the model is folded in here (and stored on the
	// tracker entry) so the tree node and every intercom digest show the SAME composed name.
	function launchAsyncRun(agent: string, task: string, runSpec: AgentRunSpec, label: string, batchSlots?: Semaphore): string {
		const model = shortModel(runSpec.model);
		// The writer classification travels WITH the run (tracker metadata), not in a side Set keyed by
		// the returned id: a thunk that throws synchronously settles the run inside launch(), so a
		// registration after launch() returns would re-insert an already-dead run and leak it.
		const id = tracker.launch({ agent, task, label, ...(model ? { model } : {}), mutates: mayMutateWorkspace(runSpec) }, (onProgress, runId) => {
			const nodeId = `async:${runId}`;
			// A real, HARD stop for the async run (a steer is only a soft request the child may
			// ignore): aborting this signal makes the engine call the sub-agent's `agent.abort()`.
			const ac = new AbortController();
			stopRegistry.set(nodeId, () => ac.abort());
			const execute = () =>
				asyncSlots.with(() =>
					buildEngine(
						undefined,
						(snap) => {
							onProgress(snap);
							const patch: { output?: string; detail?: string } = {};
							if (snap.output) patch.output = snap.output;
							// Mirrors the main subscription's onAgentProgress fallback: activity (e.g. the
							// "✉ from …" transparency tick) wins over a bare token count.
							if (snap.activity) patch.detail = snap.activity;
							else if (snap.tokens) patch.detail = `${compactTokens(snap.tokens)} tok`;
							if (patch.output !== undefined || patch.detail !== undefined) agentTree.update(nodeId, patch);
						},
						{ async: true },
						// STOP via `ac.signal` (hard abort) and STEER via the run-id key (soft redirect) —
						// both work for the supervisor (intercom `stop`/`steer`) and the f9 overlay (`x`/`s`),
						// for ANY persona (these are supervisor→child controls, not child tools).
					).run(runSpec, undefined, ac.signal, (steer) => {
						steerRegistry.set(nodeId, steer);
						agentTree.update(nodeId, { detail: "" }); // live now — clear the "queued" marker
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
		agentTree.add({ id: nodeId, label: model ? `${label} · ${model}` : label, status: "running", detail: "queued" });
		startPeek(); // arm the timed supervisor wakeup while this run is in flight (no-op if PI_PERSONA_PEEK_MS=0)
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
			lastCtx = ctx;
			const policy = controller.activePersona?.delegation;
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
				const effectiveConcurrency = normalizeDelegateConcurrency(params.concurrency, RUN_LIMITS.maxConcurrency);
				const classified = params.tasks.map((task, index) => ({ task, index, mayWrite: mayMutateWorkspace(task) }));
				const writing = classified.filter((entry) => entry.mayWrite);
				if (policy?.requireFreshVerification && policy.verificationAgents && policy.verificationAgents.length > 0) {
					const verifierNames = new Set(policy.verificationAgents);
					const droppedVerifiers = params.tasks
						.slice(RUN_LIMITS.maxChildren)
						.filter((task) => verifierNames.has(task.agent));
					if (droppedVerifiers.length > 0) {
						const names = [...new Set(droppedVerifiers.map((task) => `"${task.agent}"`))].join(", ");
						const message =
							`delegate: the max-children limit (${RUN_LIMITS.maxChildren}) would truncate declared fresh verifier ${names}. ` +
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
					const liveMutations = tracker.writers().filter((run) => !verifierNames.has(run.agent));
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
				agents.map((a) => a.name),
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
				const tasks = params.tasks.slice(0, RUN_LIMITS.maxChildren);
				const dropped = params.tasks.length - tasks.length;
				const effectiveConcurrency = normalizeDelegateConcurrency(params.concurrency, RUN_LIMITS.maxConcurrency);
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
				const droppedNote = dropped > 0 ? ` ${dropped} task(s) beyond the max-children limit (${RUN_LIMITS.maxChildren}) were dropped.` : "";
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
			agentTree.add({ id: delRoot, label: "delegate", status: "running" });
			try {
				const delegateLimits = { maxConcurrency: RUN_LIMITS.maxConcurrency, maxChildren: RUN_LIMITS.maxChildren };
				const outcome = await runDelegate(
					params,
					buildEngine(signal),
					delegateLimits,
					(views) => {
						views.forEach((v, i) => {
							const id = `${delRoot}/${i}`;
							if (!v.running) {
								stopRegistry.delete(id);
								stopRequested.delete(id);
								steerRegistry.delete(id);
							}
							const status = agentNodeStatusForDelegate(v);
							const node: AddNodeInput = { id, label: v.label, parentId: delRoot, status };
							node.detail = v.running ? v.activity : formatUsage(v.usage);
							if (v.output) node.output = v.output;
							agentTree.add(node);
						});
						const done = views.filter((v) => !v.running).length;
						onUpdate?.({ content: [{ type: "text", text: `delegate: ${done}/${views.length} done` }], details: { views } });
					},
					(i, abort) => stopRegistry.set(`${delRoot}/${i}`, abort),
					(i, steer) => steerRegistry.set(`${delRoot}/${i}`, steer),
					// The same run signal the engine was built with: a leg whose engine REJECTS under a
					// whole-run stop must file as "abort", not as an agent failure the user never caused.
					signal,
				);
				// Feed the anti-loop ledger (results align with the requested tasks by index).
				outcome.results.forEach((r, i) => {
					const t = requested[i];
					if (t && shouldRecordDelegationOutcome(r)) ledger.record(t, r.ok);
				});
				return {
					// Sub-agent text is untrusted even as a tool result (guardrails §: fence
					// before it reaches the supervisor) — the async path already fences via
					// buildCompletionReport; the sync path must match.
					content: [{ type: "text", text: `${fenceUntrusted(outcome.text)}${drainBusBlock()}` }],
					details: outcome.ok ? { views: outcome.views } : failureDetails({ views: outcome.views }),
					isError: !outcome.ok,
				};
			} finally {
				clearStops(delRoot);
				clearSteers(delRoot);
				agentTree.remove(delRoot);
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
			await onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
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

	// ── intercom tool (supervisor side of the comm plane: read/answer children) ───
	const IntercomToolParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("peek"),
				Type.Literal("result"),
				Type.Literal("wait"),
				Type.Literal("steer"),
				Type.Literal("stop"),
				Type.Literal("list"),
				Type.Literal("inbox"),
				Type.Literal("reply"),
				Type.Literal("send"),
			],
			{
				description:
					"peek = watch async sub-agents · result = retrieve one complete settled result by run id · wait = BLOCK until async run(s) settle and collect their bounded reports (a join) · steer = soft redirect into one by run id (it may ignore it) · stop = HARD-abort one by run id · list/inbox/reply/send = the coaching message bus (needs a coaching persona)",
			},
		),
		to: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "result/steer/stop/peek/wait: the async run id (e.g. 'run-1'; wait without it = all running) · send: the child bus handle (from `list`)" })),
		askId: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "reply: the message id of the child's pending question" })),
		message: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_MESSAGE_CHARS, description: "steer/reply/send: the text to deliver" })),
		timeoutMs: Type.Optional(Type.Number({ description: "wait: max ms to hold your turn (default 600000, cap 600000) — on timeout you get what settled + what's still running" })),
	});
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: [
			"See, steer, message, and JOIN your running sub-agents.",
			"`peek` watches what your async sub-agents are doing; `result` retrieves one complete settled",
			"payload by run id; `wait` blocks until runs settle and returns a bounded join report;",
			"`steer` injects a course-correction into one (by run id) mid-run — all for ANY persona on",
			"in-process async runs.",
			"`list`/`inbox`/`reply`/`send` are the message bus (a child reaching you via `contact_supervisor`)",
			"and need a `coaching: on` persona.",
		].join(" "),
		parameters: IntercomToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			// `to` comes from model-authored tool arguments. Use the exact value for routing, but never
			// interpolate it into trusted prose without reducing it to compact identifier metadata.
			const displayTarget = params.to === undefined ? undefined : sanitizeDisplayLabel(params.to, "run");
			// peek + wait + steer + stop are supervisor→child controls over the async tracker /
			// steer handles — available to EVERY persona (no dependency on the coaching bus).
			if (params.action === "peek") {
				// No `to` → running legs PLUS any settled-but-not-yet-delivered ones (the settle→deliver
				// gap), so a peek right after a leg finishes shows its result instead of "No async runs".
				const runs = params.to
					? [tracker.peek(params.to)].filter((r): r is AsyncRun => !!r)
					: dedupeRunsById([...tracker.running(), ...completionNotifier.peekPending()]);
				return { content: [{ type: "text", text: buildPeekDigest(runs, { now: Date.now(), stallMs: STALL_FLAG_MS }) }], details: { action: "peek", ok: true }, isError: false };
			}
			if (params.action === "result") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom result needs { to: <run id> }." }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				const run = tracker.peek(params.to);
				if (!run) {
					return { content: [{ type: "text", text: missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				if (run.status === "running") {
					return {
						content: [{ type: "text", text: `${displayTarget} is still running. Use intercom peek/wait, or request result after it settles.` }],
						details: failureDetails({ action: "result", ok: false, status: run.status }),
						isError: true,
					};
				}
				// Explicit collection owns this delivery: remove a still-buffered passive completion so the
				// same result cannot appear again as a follow-up a moment later. Telling the tracker too
				// makes this retained copy the first thing retention evicts — the supervisor has read it,
				// so it is the cheapest payload in the map to lose.
				completionNotifier.discard((pending) => pending.id === run.id);
				tracker.markCollected(run.id);
				const full = getFullRunOutput(run);
				const body = full === "(no output)" ? full : fenceUntrusted(full);
				// The cause is engine/child-authored text too. Keep the run id/status as trusted compact
				// metadata, but put the diagnostic inside the same untrusted fence as the payload.
				const cause = run.error ? `\nFailure detail:\n${fenceUntrusted(run.error)}` : "";
				const displayRun = sanitizeDisplayLabel(run.label ?? run.agent);
				// The wall time this leg took: an explicit collection is one of the paths a completion reaches
				// the supervisor through, so it carries the same reading the passive/join reports do.
				const took = runDurationLabel(run);
				return {
					content: [{ type: "text", text: `${run.id} (${displayRun}) · ${run.status}${took ? ` · ${took}` : ""}${cause}\n${body}` }],
					details: { action: "result", ok: true, status: run.status, runId: run.id },
					isError: false,
				};
			}
			if (params.action === "wait") {
				// No `to` → wait on running legs AND collect settled legs still queued for follow-up
				// delivery, so a wait in the settle→deliver gap returns their results (not "nothing").
				if (params.to && !tracker.peek(params.to)) {
					return { content: [{ type: "text", text: missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "wait", ok: false }), isError: true };
				}
				const ids = params.to
					? [params.to]
					: dedupeRunsById([...tracker.running(), ...completionNotifier.peekPending()]).map((r) => r.id);
				if (ids.length === 0) {
					return { content: [{ type: "text", text: "No async runs to wait for." }], details: { action: "wait", ok: true }, isError: false };
				}
				// Bounded join: never longer than a child's ask timeout (bus `ask` default 600s),
				// so a coaching child blocking on OUR reply can't deadlock us past its own timeout.
				// Default matches that ceiling — heavy sub-agents (30+ turns) routinely outlast a
				// short window, and a premature "still running" forces a needless re-wait.
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 600_000, 1_000), 600_000);
				const runs = await tracker.waitFor(ids, timeoutMs, _signal);
				const settled = runs.filter((r) => r.status !== "running");
				const still = runs.filter((r) => r.status === "running");
				// These results are delivered HERE — drop them from the pending follow-up
				// notifier so they aren't reported a second time. Render through the SAME
				// renderCompletion the passive path uses, so a leg that came back BLOCKED still
				// carries the premature-surrender note when it is collected via `wait`.
				const settledIds = new Set(settled.map((r) => r.id));
				completionNotifier.discard((run) => settledIds.has(run.id));
				const report = settled.length > 0 ? renderCompletion(settled, fenceUntrusted, (t) => scanForSurrender(t)) : "";
				const stillNote = still.length > 0 ? buildWaitTimeoutNote(still.map((r) => r.id), timeoutMs) : "";
				const joined = [report, stillNote].filter(Boolean).join("\n\n") || "Nothing to report (unknown run ids?).";
				const text = boundCompletionSurface(joined);
				return {
					content: [{ type: "text", text }],
					details: { action: "wait", ok: true, settled: [...settledIds], running: still.map((r) => r.id) },
					isError: false,
				};
			}
			if (params.action === "steer") {
				if (!params.to || params.message === undefined) {
					return { content: [{ type: "text", text: "intercom steer needs { to: <run id>, message }." }], details: failureDetails({ action: "steer", ok: false }), isError: true };
				}
				const nodeId = `async:${params.to}`;
				if (!steerRegistry.has(nodeId)) {
					return {
						content: [{ type: "text", text: `Cannot steer "${displayTarget}" — no live steer handle is available (the run may have finished or not started yet, or its engine/broker does not expose steering).` }],
						details: failureDetails({ action: "steer", ok: false }),
						isError: true,
					};
				}
				// Routed through the guarded steerAgent so a just-finished/disposed handle can't throw.
				const steered = steerAgent(nodeId, params.message);
				return steered
					? { content: [{ type: "text", text: `Steered ${displayTarget} (soft request; use action "stop" to hard-abort).` }], details: { action: "steer", ok: true }, isError: false }
					: { content: [{ type: "text", text: `Could not steer "${displayTarget}" — it may have just finished, or the message was empty.` }], details: failureDetails({ action: "steer", ok: false }), isError: true };
			}
			if (params.action === "stop") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom stop needs { to: <run id> }." }], details: failureDetails({ action: "stop", ok: false }), isError: true };
				}
				// HARD stop: aborts the run's signal → the engine calls the sub-agent's agent.abort()
				// (child.ts escalates SIGTERM → force tree-kill, so this DOES kill a child-engine process).
				const nodeId = `async:${params.to}`;
				const repeated = stopRequested.has(nodeId);
				const stopped = stopAgent(nodeId);
				if (stopped && !repeated) {
					return { content: [{ type: "text", text: `Aborting ${displayTarget} — the sub-agent is being hard-stopped; its run will settle as aborted shortly.` }], details: { action: "stop", ok: true }, isError: false };
				}
				// A repeated stop has just invoked the REAL cancel handle again. Only now force-clear
				// tracker state if engine settlement is still lagging; the handle remains registered
				// until onComplete so cancellation can never be replaced by UI-only bookkeeping.
				if (stopped && repeated && tracker.forceSettle(params.to, "force-stopped by supervisor after repeated engine cancellation")) {
					return {
						content: [{ type: "text", text: `Force-cleared ${displayTarget} after repeating the engine cancellation; it will no longer be tracked as running.` }],
						details: { action: "stop", ok: true },
						isError: false,
					};
				}
				return {
					content: [{ type: "text", text: `Cannot stop "${displayTarget}" — no such running run (it already finished).` }],
					details: failureDetails({ action: "stop", ok: false }),
					isError: true,
				};
			}

			// The message bus (coaching): list / inbox / reply / send.
			const out = runIntercom(params as IntercomParams, bus, SUPERVISOR);
			// An answered ask is settled on every surface it reached — never woken again, never
			// re-listed (the ask envelope is NOT drained by the peek path, which skips expectsReply).
			if (params.action === "reply" && out.details.ok && params.askId) {
				reconcileAnsweredAsk(params.askId, intercomNotifier, bus, SUPERVISOR);
			}
			// Child-authored inbox bodies are untrusted, exactly like the drainBusBlock/peek copies.
			let text = fenceIntercomOutcome(out, fenceUntrusted);
			if ((params.action === "list" || params.action === "inbox") && !controller.activePersona?.coaching) {
				text += `\n\n${coachingDisabledHint(controller.activePersona?.name)}`;
			}
			return { content: [{ type: "text", text }], details: out.details.ok ? out.details : failureDetails(out.details), isError: !out.details.ok };
		},
		renderCall(args, theme) {
			const action = compactInlineText(args.action ?? "?", { maxChars: 24 }) || "?";
			let target = "";
			if (action === "wait" || action === "peek") target = compactInlineText(args.to ?? "all", { maxChars: 80 }) || "all";
			else if (["result", "steer", "stop", "send"].includes(action)) target = compactInlineText(args.to ?? "?", { maxChars: 80 }) || "?";
			else if (action === "reply") target = compactInlineText(args.askId ?? "?", { maxChars: 80 }) || "?";
			const timeout = action === "wait" && Number.isFinite(args.timeoutMs) && args.timeoutMs !== undefined
				? ` · ${Math.max(0, Math.floor(args.timeoutMs))}ms`
				: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("intercom "))}${theme.fg("accent", action)}${target ? theme.fg("dim", ` ${target}${timeout}`) : ""}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = (result.details ?? {}) as { action?: string; ok?: boolean };
			const first = result.content[0];
			const full = sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)");
			const failed = details.ok === false;
			const prefix = failed ? `${theme.fg("error", theme.bold("failed"))}\n` : "";
			if (expanded) return new Text(`${prefix}${theme.fg("toolOutput", full)}`, 0, 0);
			const preview = compactVisibleText(full, { maxLines: 4, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${prefix}${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
	});

	// ── timer tool (arm a wall-clock alarm that WAKES the session when it fires) ───
	// Solves the "wait N minutes for a release / rate-limit window" problem WITHOUT a poll loop:
	// arm an alarm, end your turn, and when it expires the extension injects a follow-up that
	// resumes you (idle-gated so it starts a fresh turn instead of stranding). Arm as many as you
	// want; cancel/list them. In-memory per session (a reload/new session clears armed alarms).
	const TimerToolParams = Type.Object({
		action: Type.Union([Type.Literal("arm"), Type.Literal("cancel"), Type.Literal("list")], {
			description: "arm = schedule a wakeup · cancel = drop one by id · list = show armed alarms",
		}),
		message: Type.Optional(
			Type.String({ description: "arm: the follow-up injected into the session when the timer fires (what to do on wake, e.g. 'spawn Paperwork and start nmap'). Required for arm." }),
		),
		delaySeconds: Type.Optional(Type.Number({ description: "arm: fire this many seconds from now. Give this OR atIso, not both." })),
		atIso: Type.Optional(Type.String({ description: "arm: fire at this absolute time, ISO-8601 (e.g. '2026-07-11T19:00:00Z'). Give this OR delaySeconds, not both." })),
		label: Type.Optional(Type.String({ description: "arm: a short human label for the alarm (e.g. 'Paperwork release')." })),
		id: Type.Optional(Type.String({ description: "cancel: the timer id to cancel (e.g. 'timer-1')." })),
	});
	pi.registerTool({
		name: "timer",
		label: "Timer",
		description: [
			"Arm a wall-clock ALARM that wakes you when it fires — the token-cheap way to wait for a",
			"fixed moment (a machine release, a rate-limit reset, a scheduled re-check) instead of a",
			"poll loop. `arm` with { message, delaySeconds } or { message, atIso }; end your turn; when",
			"it expires a follow-up carrying your message is injected and you resume. `cancel` by id,",
			"`list` the armed ones. Arm as many as you need. Alarms are per-session (cleared on reload).",
		].join(" "),
		parameters: TimerToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (params.action === "list") {
				const timers = timerScheduler.list();
				const text =
					timers.length === 0
						? "(no armed timers)"
						: `Armed timers:\n${timers
								.map((t) => `• ${t.id} (${t.label}) — fires in ${formatRemaining(t.remainingMs)} [${new Date(t.fireAtEpochMs).toISOString()}]: ${t.message}`)
								.join("\n")}`;
				return { content: [{ type: "text", text }], details: { action: "list", count: timers.length, ok: true }, isError: false };
			}
			if (params.action === "cancel") {
				if (!params.id) {
					return { content: [{ type: "text", text: "timer cancel needs { id } (see `list`)." }], details: failureDetails({ action: "cancel", ok: false }), isError: true };
				}
				const cancelled = timerScheduler.cancel(params.id);
				return cancelled
					? { content: [{ type: "text", text: `Cancelled ${params.id}.` }], details: { action: "cancel", ok: true }, isError: false }
					: { content: [{ type: "text", text: `No armed timer with id "${params.id}" (it may have already fired or been cancelled).` }], details: failureDetails({ action: "cancel", ok: false }), isError: true };
			}
			// action === "arm"
			const arm: { message: string; label?: string; delayMs?: number; atEpochMs?: number } = { message: params.message ?? "" };
			if (params.label !== undefined) arm.label = params.label;
			if (params.atIso !== undefined) {
				const at = Date.parse(params.atIso);
				if (!Number.isFinite(at)) {
					return { content: [{ type: "text", text: `timer atIso "${params.atIso}" is not a valid ISO-8601 time.` }], details: failureDetails({ action: "arm", ok: false }), isError: true };
				}
				arm.atEpochMs = at;
			}
			if (params.delaySeconds !== undefined) arm.delayMs = Math.round(params.delaySeconds * 1000);
			const r = timerScheduler.arm(arm);
			if (!r.ok || !r.entry) {
				return { content: [{ type: "text", text: r.error ?? "timer arm failed." }], details: failureDetails({ action: "arm", ok: false }), isError: true };
			}
			const e = r.entry;
			const text = `Armed ${e.id} (${e.label}) — fires in ${formatRemaining(e.fireAtEpochMs - Date.now())} [${new Date(e.fireAtEpochMs).toISOString()}]. On fire I'll be woken with: "${e.message}". You can end this turn now.`;
			return { content: [{ type: "text", text }], details: { action: "arm", id: e.id, fireAtEpochMs: e.fireAtEpochMs, ok: true }, isError: false };
		},
	});

	// ── council tool (deliberate → vote → ruling; the executor then applies it) ───
	const CouncilParams = Type.Object({
		question: Type.String({ description: "The decision or problem to deliberate — specific and self-contained" }),
		persona: Type.Optional(
			Type.String({
				description:
					'Installed persona whose declared council profile to use (for example "magi"). This borrows only its council strategy/roster/params; the active caller remains in control.',
			}),
		),
		strategy: Type.Optional(
			Type.String({ description: "Per-call strategy override (default: the selected or active persona's council strategy)" }),
		),
		roster: Type.Optional(Type.String({ description: "Per-call roster override (default: the selected or active persona's council roster)" })),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					'Strategy params, merged over the persona\'s (e.g. { "reflect": false } to skip magi\'s reflection round, { "aggregate": "unanimity" }, { "rounds": 3 }). Reach for it when the user asks for a variant of the persona\'s default council this one time.',
			}),
		),
	});
	pi.registerTool({
		name: "council",
		label: "Council",
		description: [
			"Convene a council of specialists with controlled, complementary biases to deliberate a",
			"decision and vote — returns the ruling (winner, tally, each member's view, recorded dissent).",
			"Use it before any significant choice; then EXECUTE the ruling yourself and re-convene when",
			"execution surfaces a new decision. Patterns: adversarial vote (magi, council-rounds), best-of-N",
			"with an impartial arbiter (judge, compete), batch map, merged synthesis (synthesize).",
			'Use `persona: "magi"` to invoke an installed persona\'s declared council without switching away',
			"from the active caller; its prompt, model, tools, and permissions are never inherited.",
			`Strategies: ${strategyNames()
				.map((n) => {
					const p = knownParams(n);
					const keys = p ? Object.keys(p) : [];
					return keys.length > 0 ? `${n}(${keys.join(", ")})` : n;
				})
				.join(" · ")}.`,
			'Pass `params` to vary the persona\'s default council for one call — e.g. { "reflect": false }.',
		].join(" "),
		parameters: CouncilParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const resolved = resolveCouncilInvocation(personas, controller.activePersona, {
				persona: params.persona,
				strategy: params.strategy,
				roster: params.roster,
				params: params.params as Record<string, unknown> | undefined,
			});
			if (!resolved.ok) {
				return {
					content: [{ type: "text", text: `council failed: ${resolved.error}` }],
					details: failureDetails({ error: resolved.error, persona: params.persona }),
					isError: true,
				};
			}
			const { strategy, roster, params: mergedParams, persona } = resolved.value;
			try {
				// Fully persona-driven: a persona's `council:` block picks the strategy, roster,
				// and params — a new ensemble (more members, supermajority, multi-round) needs no
				// code, just a team + (optional) strategy file + a council block. Params override.
				// Per-call params override the selected council profile (e.g. reflect:false this once).
				// Lenient by design (I2: strategies are trusted project code) — an unknown param key
				// only warns, it never blocks or alters the run. A correct call is untouched.
				let paramNote = "";
				const schema = knownParams(strategy);
				if (schema) {
					const unknown = Object.keys(mergedParams).filter((k) => !(k in schema));
					if (unknown.length > 0) {
						const note = `council: ignoring unknown param(s) [${unknown.join(", ")}] for "${strategy}" — known: ${Object.keys(schema).join(", ") || "(none)"}`;
						if (process.env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] ${note}\n`);
						ctx.ui.notify(note, "warning");
						paramNote = `\n\n(${note})`;
					}
				}
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: mergedParams };
				const result = await runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				const s = (result?.structured ?? {}) as { headline?: string; status?: string; tally?: Record<string, number>; usedFallback?: boolean; count?: number };
				const ruling = result?.output ?? "(the council returned no ruling)";
				const uiBody = result ? (humanizeAggregateResult(result) ?? result.output) : "";
				const headline = s.headline ?? (typeof s.count === "number" ? `${s.count} member results` : s.status ?? "");
				const ok = result?.ok ?? false;
				const details = {
					ok,
					headline,
					status: s.status,
					tally: s.tally,
					usedFallback: s.usedFallback,
					body: uiBody,
					strategy,
					roster,
					persona,
					...(result?.error ? { error: result.error } : {}),
					...(result?.failureKind ? { failureKind: result.failureKind } : {}),
				};
				return {
					// The ruling is sub-agent (council member) text — fence it like every other
					// path that hands sub-agent output to the supervisor.
					content: [{ type: "text", text: `${fenceUntrusted(ruling)}${paramNote}${drainBusBlock()}` }],
					details: ok ? details : failureDetails(details),
					isError: !ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: failureDetails({ error: message, strategy, roster }), isError: true };
			}
		},
		renderCall(args, theme) {
			const resolved = resolveCouncilInvocation(personas, controller.activePersona, {
				persona: args.persona,
				strategy: args.strategy,
				roster: args.roster,
				params: args.params as Record<string, unknown> | undefined,
			});
			const strategy = resolved.ok ? resolved.value.strategy : (args.strategy ?? "?");
			const roster = resolved.ok ? resolved.value.roster : (args.roster ?? args.persona ?? "?");
			return new Text(theme.fg("toolTitle", theme.bold(formatCouncilCallLabel(strategy, roster))), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as {
				ok?: boolean;
				headline?: string;
				status?: string;
				tally?: Record<string, number>;
				usedFallback?: boolean;
				body?: string;
				strategy?: string;
				roster?: string;
				error?: string;
				failureKind?: FailureKind;
			};
			const first = result.content[0];
			const body = sanitizeTerminalText(d.body || (first && first.type === "text" ? first.text : ""));
			const failed = d.ok === false || !!d.error;
			if (failed) {
				const cause = compactInlineText([d.failureKind, d.error].filter((part): part is string => !!part).join(" · "), { maxChars: 160 });
				const title = theme.fg("error", theme.bold(`council failed${cause ? ` · ${cause}` : ""}`));
				if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", body || "(no ruling)")}`, 0, 0);
				const preview = compactVisibleText(body || "(no ruling)", { maxLines: 3, maxLineChars: 100 });
				const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
				return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
			}
			const text = formatCouncilResult(
				{ headline: d.headline, status: d.status, tally: d.tally, usedFallback: d.usedFallback, body },
				expanded,
				expandDetailHint(),
			);
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", text), 0, 0);
		},
	});

	// ── flow tool (run a *.flow.json DAG over strategies; the supervisor self-launches) ──
	const FlowToolParams = Type.Object({
		name: Type.String({ description: "The flow to run — a *.flow.json by name (installed flows are listed in your sub-agents brief; the user can run /flow to list them)" }),
		task: Type.String({ description: "The objective to run the flow on" }),
	});
	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Run a named flow — a declarative DAG over strategies (`*.flow.json`): phases each run a",
			"strategy over a roster, wired by `needs`, fanning out where independent and threading each",
			"phase's output into its dependents. Journaled, so an interrupted flow resumes. Reach for it",
			"when a task has a fixed multi-stage shape (e.g. gather → critique → decide) you want run",
			"deterministically, end to end, rather than deciding each step yourself.",
		].join(" "),
		parameters: FlowToolParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const parsed = loadFlow(ctx.cwd, params.name);
			if (!parsed) {
				const installed = listFlows(ctx.cwd);
				const hint = installed.length > 0 ? `Installed flows: ${installed.join(", ")}.` : "No flows are installed — add a *.flow.json under .pi/flows/.";
				return {
					content: [{ type: "text", text: `no flow named "${params.name}". ${hint}` }],
					details: failureDetails({ ok: false, error: `no flow named "${params.name}"` }),
					isError: true,
				};
			}
			if (!parsed.ok) {
				return {
					content: [{ type: "text", text: `flow "${params.name}" is invalid: ${parsed.error}` }],
					details: failureDetails({ ok: false, failureKind: "contract", error: parsed.error }),
					isError: true,
				};
			}
			try {
				const outcome = await runFlowVisible(ctx, parsed.flow, params.task, signal);
				const details = {
					ok: outcome.ok,
					failedPhase: outcome.failedPhase,
					failureKind: outcome.failureKind,
					error: outcome.error,
				};
				return {
					content: [{ type: "text", text: fenceUntrusted(outcome.output || "(flow produced no output)") }],
					details: outcome.ok ? details : failureDetails(details),
					isError: !outcome.ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `flow failed: ${message}` }], details: failureDetails({ ok: false, error: message }), isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("flow "))}${theme.fg("accent", compactInlineText(args.name ?? "?", { maxChars: 96 }) || "?")}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = (result.details ?? {}) as {
				ok?: boolean;
				failedPhase?: string;
				failureKind?: FailureKind;
				error?: string;
			};
			const first = result.content[0];
			const full = sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)");
			const failed = details.ok === false;
			const failureBits = failed
				? compactInlineText(
						[details.failedPhase ? `phase ${details.failedPhase}` : undefined, details.failureKind, details.error]
							.filter((part): part is string => !!part)
							.join(" · "),
						{ maxChars: 160 },
					)
				: "";
			const title = failed
				? theme.fg("error", theme.bold(`flow failed${failureBits ? ` · ${failureBits}` : ""}`))
				: theme.fg("success", theme.bold("flow complete"));
			if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", full)}`, 0, 0);
			const preview = compactVisibleText(full, { maxLines: 3, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
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
				await onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
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
				await onPersonaChanged(ctx);
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
				await onPersonaChanged(ctx); // a restored persona file may have changed canUseBus — re-gate; clear the by-hand run
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
			await onPersonaChanged(ctx); // the persona just changed — re-gate the bus, clear the by-hand run
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
		description: "Show exocom peers in this workspace (refreshes the pool widget): /exocom",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (!exocomPlane) {
				ctx.ui.notify(
					"exocom: not active — needs PI_PERSONA_EXOCOM=1 (or --exocom) and an active persona that allows the bus (canUseBus).",
					"warning",
				);
				return;
			}
			renderExocomWidget();
			const peers = exocomPlane.listPeers();
			const lines = peers.map(
				(p) => {
					const name = sanitizePeerField(p.displayName, 48) || "peer";
					const persona = sanitizePeerField(p.persona, 48) || "—";
					const model = sanitizePeerField(p.model, 96) || "?";
					const contextPct = Number.isFinite(p.context_pct) ? Math.max(0, Math.min(100, Math.round(p.context_pct))) : 0;
					return `• ${name} (${persona} · ${model}, ctx ${contextPct}%)`;
				},
			);
			appendCommandResult(
				`exocom ${exocomName}`,
				peers.length === 0
					? "no other peers in this workspace right now"
					: `${peers.length} peer${peers.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
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

	pi.registerTool({
		name: "models",
		label: "Models",
		description: [
			"List or search the available model ids (provider/id). The same name exists under several",
			"providers — use an EXACT id from here as a delegate task's `model`. ★ marks your session",
			"provider; prefer it (it's the authenticated one).",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Filter by substring (provider or id), e.g. 'sonnet'" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const { lines, total, capped } = searchModels(ctx, params.query);
			const text = lines.length
				? `${total} model(s)${capped ? " (showing 40 — refine with a query)" : ""}; ★ = session provider:\n${lines.join("\n")}`
				: `no models match "${params.query ?? ""}"`;
			return { content: [{ type: "text", text }], details: { total }, isError: false };
		},
		renderCall(args, theme) {
			const query = compactInlineText(args.query ?? "(all)", { maxChars: 96 }) || "(all)";
			return new Text(`${theme.fg("toolTitle", theme.bold("models "))}${theme.fg("dim", query)}`, 0, 0);
		},
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

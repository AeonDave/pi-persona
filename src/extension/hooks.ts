/**
 * Host lifecycle hooks: session, settlement, prompt composition, tool gate, mandatory orchestration.
 */
import { existsSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/agent.ts";
import { buildExocomBrief, RUNTIME_CONTEXT_GUIDANCE } from "../core/brief.ts";
import { canCallTool, canDelegateTo, canFanOut } from "../core/capabilities.ts";
import type { PiPersonaConfig } from "../core/config.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { HANDOFF_TOOL_NAMES, longWaitSeconds, type DelegationNudge, type PersistenceNudge, type PollGuard } from "../core/nudge.ts";
import { findStoredRuns, makeRunsEntry, restoreNotice, RUNS_ENTRY_CUSTOM_TYPE } from "../core/session-runs.ts";
import { buildSessionAnchor } from "../core/time.ts";
import { readClockSnapshot } from "./clock.ts";
import { type AsyncRun, type AsyncRunTracker, type IdleCoalescingNotifier, type PeekWatcher } from "../engine/async.ts";
import { constrainedTurnAllows } from "../exocom/gate.ts";
import type { LedgerClaim } from "../exocom/ledger.ts";
import type { DisplayPeer } from "../exocom/plane.ts";
import { peerClaimFor, WRITE_TOOLS, writeWarningKey, writeWarningReason, writeWarningToastReason } from "../exocom/write-guard.ts";
import {
	canonicalExocomTelemetryTargets,
	compactNameList,
	piPersonaToolErrorPatch,
	sendPersonaFollowUp,
	toastCause,
	type PendingAsk,
} from "./shared.ts";
import type { TimerEntry } from "../core/timer.ts";
import type { MonitorSession } from "../monitor/session.ts";
import type { FlowSpec } from "../orchestration/flow.ts";
import { resolveStrategyName } from "../persona/orchestrate.ts";
import type { PersonaController, PersonaHost } from "../persona/controller.ts";
import type { OrchestrationGrammar, Persona } from "../persona/persona.ts";
import type { PersonaConfigStore } from "../persona/config-store.ts";
import { TELEMETRY_EVENT_NAME } from "../telemetry/contract.ts";
import { TelemetryProducer, type TelemetryAgentInput } from "../telemetry/producer.ts";
import { isNonAgentNode, type AgentTree, type AgentNode } from "../ui/agent-tree.ts";
import type { ActivityIngress } from "./companion.ts";
import type { MemoryOwnerControl } from "./memory-owner.ts";
import { compactInlineText } from "../ui/presentation.ts";
import type { FailureKind } from "../orchestration/types.ts";
import type { ExocomInstall } from "../exocom/install.ts";
import type { SessionIdentity } from "./identity.ts";
import type { SessionResults } from "./results.ts";
import { resultReceiptHint, type ResultReceipt } from "../results/retrieval.ts";

type MandatoryOutcome = { label: string; output: string; ok: boolean; error?: string; failureKind?: FailureKind; resultReceipt?: ResultReceipt };

export interface HookHost {
	readonly companionActivities: ActivityIngress;
	readonly memoryOwner: MemoryOwnerControl;
	readonly identity: SessionIdentity;
	readonly results: SessionResults;
	config: PiPersonaConfig;
	controller: PersonaController;
	personaHost: PersonaHost;
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	get disposed(): boolean;
	set disposed(value: boolean);
	get orchestrating(): boolean;
	set orchestrating(value: boolean);
	get processingDeferredOrchestration(): boolean;
	set processingDeferredOrchestration(value: boolean);
	get pendingOrchestration(): MandatoryOutcome | undefined;
	set pendingOrchestration(value: MandatoryOutcome | undefined);
	readonly MAX_DEFERRED_ORCHESTRATIONS: number;
	readonly deferredOrchestrations: Array<{ task: string; orchestration: OrchestrationGrammar }>;
	get telemetry(): TelemetryProducer | undefined;
	set telemetry(value: TelemetryProducer | undefined);
	readonly telemetryToolStartedAt: Map<string, { startedAt: number; name: string }>;
	readonly telemetryExocomPending: Map<string, Array<{ id: string; sessionId: string; target: string; size: number; replyTo?: string }>>;
	readonly telemetryIntercomPending: Map<string, { kind: string; to: string; size: number; replyTo?: string }>;
	readonly lastAgentProjection: Map<string, string>;
	readonly telemetryAskSenders: Map<string, string>;
	readonly agentTree: AgentTree;
	telemetryAgent(node: AgentNode): TelemetryAgentInput;
	delegationNudge: DelegationNudge;
	persistenceNudge: PersistenceNudge;
	/** Refuses an unchanged repeat of an intercom peek/result; absent when the nudge kill switch is off. */
	pollGuard: PollGuard | undefined;
	/** The async-run tracker: what is still running, and the run-id counter a restore continues. */
	tracker: Pick<AsyncRunTracker, "running" | "issued" | "continueFrom">;
	appendNudgeEntry(content: string): void;
	completionNotifier: IdleCoalescingNotifier<AsyncRun>;
	intercomNotifier: IdleCoalescingNotifier<PendingAsk>;
	timerNotifier: IdleCoalescingNotifier<TimerEntry>;
	timerScheduler: { cancelAll(): void; readonly size: number };
	monitors: MonitorSession;
	peekWatcher: PeekWatcher;
	stopPeek(): void;
	stopRegistry: Map<string, () => void>;
	stopRequested: Set<string>;
	steerRegistry: Map<string, unknown>;
	broker: { close(): Promise<void> };
	get spineText(): string;
	delegationBrief(ctx: ExtensionContext): string | undefined;
	get agents(): AgentConfig[];
	get personas(): Persona[];
	reload(cwd: string): void;
	readConfigStore(): PersonaConfigStore;
	get personaConfigs(): PersonaConfigStore;
	set personaConfigs(value: PersonaConfigStore);
	readRememberedPersona(): string | undefined;
	runSeed(force: boolean): { copied: unknown[] };
	seedMarker(): string;
	personaDataDir(): string;
	reportSeedSourceCollisions(ctx: ExtensionContext, result: { copied: unknown[] }): void;
	refreshSpineAfterSeed(): void;
	inspectEnabledLegacySpines(): void;
	reportSeedMigration(ctx: ExtensionContext, result: unknown): void;
	seedMigration: unknown;
	reportDataRootMigration(ctx: ExtensionContext): void;
	reportSpineWarning(ctx: ExtensionContext): void;
	reportDefinitionCollisions(ctx: ExtensionContext): void;
	userAgentDir(): string;
	loadFlow(cwd: string, name: string): { ok: true; flow: FlowSpec } | { ok: false; error: string } | undefined;
	runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, task: string): Promise<{ output: string; ok: boolean; cancelled?: boolean; error?: string; failureKind?: FailureKind; resultReceipt?: ResultReceipt }>;
	runStrategyVisible(ctx: ExtensionContext, orch: OrchestrationGrammar, task: string, label: string): Promise<{ output: string; ok: boolean; error?: string; failureKind?: FailureKind; resultReceipt?: ResultReceipt } | undefined>;
	personaGrammarError(err: unknown): string;
	intercomRecipient(input: Record<string, unknown>, askId: string | undefined): string;
	idleDelivery: unknown;
	drainBusBlock: () => string;
	childUsage: { reset(): void };
	publishPersonaCost: () => void;
}

export function installHooks(pi: ExtensionAPI, h: HookHost, exocom: ExocomInstall): void {
	// Only parent ids are retained, never child output. Propagate through wrappers only when they
	// actually relay a surrender marker; the outer model-visible result owns the note and card.
	const pendingSurrenderRelays = new Set<string>();
	const rememberSurrenderRelay = (id: string): void => {
		if (pendingSurrenderRelays.size >= 256) {
			const oldest = pendingSurrenderRelays.values().next().value;
			if (oldest !== undefined) pendingSurrenderRelays.delete(oldest);
		}
		pendingSurrenderRelays.add(id);
	};
	// `delegate`/`council`/`flow` calls (all background launches) whose tool_call passed but whose result has
	// not landed. Pi prepares every call of a batch before any executes, so a same-batch launch + `sleep`
	// would otherwise see no running child yet. A launch that later fails validation counts until its result lands: accepted.
	const launching = new Set<string>();
	const clearInFlight = (): void => { pendingSurrenderRelays.clear(); launching.clear(); };
	/** A tool the model can call right now: active in the host and allowed by the persona. */
	const toolAllowed = (name: string): boolean => {
		const caps = h.controller.capabilities;
		return pi.getActiveTools().includes(name) && (!caps || canCallTool(caps, name));
	};
	// ── restore honesty ───────────────────────────────────────────────────────
	// A reload/resume/`pi -c` ends this instance and with it every background run, armed timer and
	// monitor (memory only). Shutdown records what dies and the run-id counter in a session entry
	// (core/session-runs.ts); the next start tells the restored supervisor once, passively, and
	// continues the ids so they never repeat within one history. Best effort: a failure on either
	// side degrades to the old behaviour, never to a broken shutdown or start.
	let restoredIssued = 0; // the counter this instance started from: unchanged ⇒ nothing new to record
	function recordLostWork(ctx: ExtensionContext): void {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const lost = {
				runs: [...new Set([...h.tracker.running(), ...h.completionNotifier.peekPending()].map((run) => run.id))],
				timers: h.timerScheduler.size,
				monitors: h.monitors.list().length,
			};
			if (lost.runs.length === 0 && lost.timers === 0 && lost.monitors === 0 && h.tracker.issued <= restoredIssued) return;
			pi.appendEntry(RUNS_ENTRY_CUSTOM_TYPE, makeRunsEntry(sessionId, h.tracker.issued, lost));
		} catch { /* shutdown must complete */ }
	}
	function announceLostWork(ctx: ExtensionContext): void {
		try {
			const manager = ctx.sessionManager;
			const stored = findStoredRuns(manager.getEntries(), manager.getSessionId());
			if (!stored) return;
			h.tracker.continueFrom(stored.issued);
			restoredIssued = h.tracker.issued;
			const notice = restoreNotice(stored.lost);
			if (!notice) return;
			pi.sendMessage({ customType: "pi-persona", content: notice, display: true }, { deliverAs: "nextTurn" }); // passive: never starts a turn
			// Acknowledge so the newest entry is an empty loss: the same loss can never be announced twice.
			pi.appendEntry(RUNS_ENTRY_CUSTOM_TYPE, makeRunsEntry(stored.sessionId, stored.issued, { runs: [], timers: 0, monitors: 0 }));
		} catch { /* the session start must complete */ }
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const memoryOwnerReady = h.memoryOwner.start(ctx.sessionManager);
		h.companionActivities.start(ctx);
		clearInFlight();
		h.lastCtx = ctx;
		h.results.activate(ctx);
		h.delegationNudge.reset(); // a fresh session starts with a clean by-hand run
		h.childUsage.reset();
		h.publishPersonaCost();
		announceLostWork(ctx);
		// Opt-in only (PI_PERSONA_SEED=on): auto-install the bundled defaults once. Default is off —
		// a fresh install shows no h.personas until `/persona seed` or `/persona restore`.
		if (h.config.seed && !existsSync(h.seedMarker())) {
			try {
				const r = h.runSeed(false);
				h.reportSeedSourceCollisions(ctx, r);
				// Resolution happened before session_start, when a fresh install had no user copy. Refresh
				// now so this very process uses what auto-seed just created and reports only post-seed state.
				h.refreshSpineAfterSeed();
				if (ctx.hasUI && r.copied.length > 0) {
					ctx.ui.notify(`pi-persona: seeded ${r.copied.length} default(s) to ${h.personaDataDir()} — edit them freely; /persona restore brings back the originals.`, "info");
				}
			} catch {
				// Seeding is multi-file: an error can arrive after the prompt itself was copied. Re-resolve
				// and retry only enabled legacy roles so partial progress is visible in this same process.
				h.inspectEnabledLegacySpines();
			}
		}
		h.reportSeedMigration(ctx, h.seedMigration);
		h.reportDataRootMigration(ctx); // the one-time storage-root move ran at activation; this is its voice
		h.reportSpineWarning(ctx);
		h.reload(ctx.cwd);
		h.identity.start(ctx); // restore session identity before persona activation can join Exocom
		h.reportDefinitionCollisions(ctx);
		h.personaConfigs = h.readConfigStore();
		// Restore order: --persona flag > env pin (PI_PERSONA_DEFAULT) > remembered-on-disk. Read-only.
		const flagPersona = ((pi.getFlag("persona") as string) || "").trim();
		const remembered = flagPersona || h.config.defaultPersona || h.readRememberedPersona();
		const target = remembered ? h.personas.find((p) => p.name === remembered) : undefined;
		if (target) await h.controller.activate(target);
		else {
			// A name that doesn't resolve leaves the session with NO persona at all, whichever source it
			// came from — and silence there reads as "it's active" while nothing is (downstream tooling
			// keyed on the remembered name, e.g. per-persona memory, then serves a persona that was never
			// activated). An EXPLICIT `--persona` is a direct instruction, so it stays an error; an env
			// pin or a stale remembered name is a warning. The marker itself is deliberately NOT cleared:
			// h.personas are discovered per-cwd, so a name that is missing here may be present in the
			// project the user came from. The model (`--model`) and effort (`--thinking`) are pi's own
			// flags — pi validates those.
			if (remembered) {
				const names = compactNameList(h.personas.map((p) => p.name), 12) || "(none installed — run /persona seed)";
				const source = flagPersona ? "--persona" : h.config.defaultPersona ? "PI_PERSONA_DEFAULT" : "remembered persona";
				const msg = `pi-persona: ${source} "${remembered}" is not an installed persona. Available: ${names}`;
				if (ctx.hasUI) ctx.ui.notify(msg, flagPersona ? "error" : "warning");
				else process.stderr.write(`${msg}\n`);
			}
			h.personaHost.setStatus(h.controller.activePersona?.label);
		}
		await exocom.reconcile(ctx); // after persona activation, so plane + active tools share one gate
		await h.telemetry?.stop("session-replaced");
		h.telemetry = undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) {
			try {
				h.telemetry = new TelemetryProducer({
					agentDir: h.userAgentDir(),
					cwd: ctx.cwd,
					sessionId,
					emit: (event) => pi.events.emit(TELEMETRY_EVENT_NAME, event),
					heartbeat: () => exocom.currentTelemetryInstance(h.lastCtx ?? ctx),
					onError: (error: unknown) => {
						// Retention and writer failures must be observable during normal operation too.
						// A broken UI/logger must never turn best-effort telemetry into a session failure.
						try {
							const message = `pi-persona: telemetry: ${compactInlineText(error instanceof Error ? error.message : String(error), { maxChars: 400 })}`;
							const current = h.lastCtx ?? ctx;
							if (current.hasUI) current.ui.notify(message, "warning");
							else process.stderr.write(`${message}\n`);
						} catch { /* diagnostics are non-fatal */ }
					},
				});
				h.telemetry.start(exocom.currentTelemetryInstance(ctx));
			} catch (error) {
				h.telemetry = undefined;
				const message = "pi-persona: telemetry unavailable (safe session admission failed)";
				try {
					if (ctx.hasUI) ctx.ui.notify(message, "warning");
					else process.stderr.write(`${message}\n`);
				} catch { /* admission diagnostics are non-fatal too */ }
			}
			if (h.telemetry) {
				// Re-seeded with the replay, so the dedupe below always mirrors what THIS producer last
				// published — a session start that follows no teardown carries no stale projection.
				h.lastAgentProjection.clear();
				for (const node of h.agentTree.snapshot()) {
					if (isNonAgentNode(node)) continue; // local activity/wake rows are not agent telemetry
					h.lastAgentProjection.set(node.id, JSON.stringify(h.telemetryAgent(node)));
					h.telemetry.publishAgentAdded(h.telemetryAgent(node));
				}
				exocom.publishTelemetryPeers();
			}
		}
		memoryOwnerReady();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		h.memoryOwner.stop();
		h.companionActivities.stop(false); // revoke now; the single tree.clear below owns the final repaint
		clearInFlight();
		h.lastCtx = ctx;
		recordLostWork(ctx); // before the notifiers/timers/runs below are torn down
		h.disposed = true; // gate any late async-run onComplete from touching the next session's instance
		h.results.dispose(); // revoke frozen owners before cancellation can settle old runs
		h.deferredOrchestrations.length = 0;
		h.pendingOrchestration = undefined;
		h.stopPeek(); // h.reload-hygiene: never leak the idle-peek timer across sessions
		h.peekWatcher.reset(); // …nor a stale "already surfaced this leg as stuck" set into the next session
		h.completionNotifier.cancel(); // …nor the coalesced-delivery flush timers
		h.intercomNotifier.cancel();
		exocom.notifier?.cancel(); // …nor a late exocom follow-up (M1) — cancelled BEFORE exocom.stop tears down the plane below
		exocom.waitNotifier?.cancel();
		h.timerScheduler.cancelAll(); // …nor any armed alarms (never wake the next session)
		h.timerNotifier.cancel();
		h.monitors.cancelAll();
		// This instance is being torn down (a h.reload/new/resume rebinds a fresh one); abort in-flight
		// sub-h.agents and reset control state so nothing is left orphaned or rendered stale.
		for (const abort of [...h.stopRegistry.values()]) {
			try {
				abort();
			} catch {
				/* ignore */
			}
		}
		h.stopRegistry.clear();
		h.stopRequested.clear();
		h.steerRegistry.clear();
		h.agentTree.clear();
		h.personaHost.setStatus(undefined);
		// Queued, not called bare: a shutdown that lands while session_start's own start is still
		// pending would otherwise see `exocom.plane` unset, no-op, and let that start bind a socket
		// and register an entry for a session that no longer exists. Idempotent either way — off
		// (or never started) ⇒ a no-op.
		await exocom.queue(() => exocom.stop());
		// Broker teardown (spec B1/B5): idempotent — a session that never built a broker-backed
		// child engine (flag off, or on but unused) never started a host, so this is a no-op.
		// `SupervisorBroker.close()` is itself best-effort (never blocks shutdown on a teardown error).
		await h.broker.close();
		await h.telemetry?.stop(event?.reason);
		h.telemetry = undefined;
		h.telemetryToolStartedAt.clear();
		h.telemetryExocomPending.clear();
		h.telemetryIntercomPending.clear();
		h.telemetryAskSenders.clear(); // …and no ask attribution leaks into the next session
		h.lastAgentProjection.clear();
	});

	// Pi marks the session idle before emitting agent_settled. A deferred mandatory input owns this
	// idle window first; its replay starts the next run and the remaining FIFO entries follow one per
	// settlement. With no deferred input, flush ordinary wakes immediately.
	pi.on("agent_settled", async () => {
		clearInFlight();
		h.pollGuard?.reset(); // a settled turn ends any poll streak: the next peek is a fresh look
		if (h.lastCtx) h.telemetry?.publish("instance.updated", { ...exocom.currentTelemetryInstance(h.lastCtx), status: "idle" });
		// Pi's `prepareToolCall` returns {kind:"immediate"} when the abort signal is already set
		// after beforeToolCall — skipping afterToolCall, and so our tool_result hook. Those calls
		// would otherwise stay "running" until session_shutdown (press Esc mid-fan-out and every
		// call that had not yet started is orphaned). The turn boundary is where they end.
		for (const [callId, open] of h.telemetryToolStartedAt) {
			h.telemetry?.publish("tool.finished", {
				callId,
				agentId: "supervisor",
				name: open.name,
				status: "failed",
				durationMs: Math.max(0, Date.now() - open.startedAt),
			});
		}
		h.telemetryToolStartedAt.clear(); // a late result for a drained call must not close it twice
		// An exocom send orphaned on that same path left its recipients at "queued" forever. They are
		// reported failed, never delivered: the call never reached a result, so nothing observed a send.
		if (h.lastCtx) {
			const from = exocom.telemetrySessionId(h.lastCtx);
			for (const pending of h.telemetryExocomPending.values()) {
				for (const message of pending) h.telemetry?.publish("message.sent", {
					id: message.id,
					channel: "exocom",
					// A session id, like every other exocom publish site — never an agentId literal in this slot.
					from,
					to: message.sessionId,
					kind: "message",
					status: "failed",
					expectsReply: false,
					size: message.size,
					...(message.replyTo ? { replyTo: message.replyTo } : {}),
				});
			}
		}
		h.telemetryExocomPending.clear();
		for (const [callId, message] of h.telemetryIntercomPending) {
			h.telemetry?.publish(message.kind === "reply" ? "message.replied" : "message.sent", {
				id: callId,
				channel: "intercom",
				from: "supervisor",
				to: message.to,
				kind: message.kind,
				status: "failed",
				expectsReply: false,
				size: message.size,
				...(message.replyTo ? { replyTo: message.replyTo } : {}),
			});
		}
		h.telemetryIntercomPending.clear();
		if (await processNextDeferredOrchestration()) return;
		h.completionNotifier.kick();
		h.intercomNotifier.kick();
		h.timerNotifier.kick();
		h.monitors.kick();
		exocom.notifier?.kick();
		exocom.waitNotifier?.kick();
	});

	pi.on("before_agent_start", (event, ctx) => {
		h.lastCtx = ctx;
		h.telemetry?.publish("instance.updated", { ...exocom.currentTelemetryInstance(ctx), status: "active" });
		// The spine lifts persona-less turns too: with nothing active the composition is Pi's base
		// prompt + the layer. Off ⇒ `h.spineText` is empty and this is `event.systemPrompt` itself.
		const noPersona = h.spineText ? `${event.systemPrompt}\n\n${h.spineText}` : event.systemPrompt;
		let prompt = h.controller.composePrompt(event.systemPrompt, h.spineText) ?? noPersona;
		// Stable system-level interpretation of runtime metadata. Never append an acknowledgement
		// request to the conversation: that would recreate the old identity pseudo-turn loop.
		prompt = `${prompt}\n\n${RUNTIME_CONTEXT_GUIDANCE}`;
		// The session time anchor (core/time.ts). Unconditional, unlike both briefs below: a supervisor
		// that has been working for hours needs to know it whether or not h.agents or peers exist. It goes
		// in the SYSTEM prompt because the prompt is re-composed and re-sent every turn rather than
		// summarized, so an anchor placed here cannot be compacted away — the same fact in the
		// conversation tail would be. Its start comes from the session HEADER, the first entry of the
		// append-only session file, so after /resume it is still the ORIGINAL start: that is what makes it
		// answer "how long have I been on this problem" across restarts and not merely across turns.
		// Placed BEFORE the briefs so the standing hand-off default keeps the last word at the tail; the
		// elapsed reading remains coarse to preserve caching; the precise clock goes in a new
		// conversation message below, and timer now can refresh it within a long tool loop.
		const now = Date.now();
		const anchor = buildSessionAnchor(ctx.sessionManager.getHeader(), now);
		if (anchor) prompt = `${prompt}\n\n${anchor}`;
		const wakeGuidance: string[] = [];
		if (toolAllowed("timer")) wakeGuidance.push("timer now reads the current clock; timer arm schedules a fixed-time wake (absolute times require a timezone).");
		if (toolAllowed("monitor") && toolAllowed("bash")) wakeGuidance.push("monitor watches a job or event-producing program: mode=exit for job completion, mode=output for file/log/system changes reported as stdout lines. Filter changes in the producer; set a useful deadline and event count, and cancel the watch when its purpose ends.");
		if (wakeGuidance.length) {
			// Headless `pi -p` exits when the turn settles, so "end your turn" would drop the wake.
			const wakeTail = ctx.hasUI
				? "Continue independent work while waiting; end your turn when only the event remains. These wakes require this Pi session to stay open."
				: "Headless: a wake is delivered only if it fires before your turn settles; do not end the turn to wait for one.";
			prompt = `${prompt}\n\n[Session wakes] ${wakeGuidance.join(" ")} ${wakeTail} Avoid duplicate watches.`;
		}
		const brief = h.delegationBrief(ctx);
		if (brief) prompt = `${prompt}\n\n${brief}`;
		// Per-turn exocom peer AWARENESS (mirrors the delegation brief above): regenerated from the
		// live registry every turn so it cannot desync, and gated implicitly — exocom.plane is only
		// set when exocom is on AND canUseBus, so this is a no-op (undefined ⇒ no prompt change)
		// whenever exocom is off, matching every other opt-in surface in this file.
		if (exocom.plane) {
			let peers: DisplayPeer[] | undefined;
			let pendingBlock: string | undefined;
			let ledgerFailure: string | undefined;
			try {
				peers = exocom.plane.listPeers();
			} catch {
				// Peer awareness is opportunistic. A transient registry I/O failure must not abort
				// Pi's turn or prevent the rest of the system prompt from reaching the model.
			}
			if (exocom.ledgerFile) {
				try {
					pendingBlock = exocom.pendingAskPrompt(ctx);
				} catch (error) {
					ledgerFailure = `[pi-persona] Exocom ledger unavailable. Treat work ownership and pending asks as unresolved; do not mutate or delegate until storage recovers. (${error instanceof Error ? error.message : String(error)})`;
				}
			}
			const xcaps = h.controller.capabilities;
			// Holding the bus says nothing about `delegate` (canUseBus keys off `intercom` alone), so
			// read the persona the way h.delegationBrief does — absent capabilities ⇒ unrestricted — but
			// gate on a REACHABLE target, which is stricter than h.delegationBrief: that one still renders
			// (with `installedCount`, to say "your allowlist filtered everything away") when fan-out is
			// allowed and no target survives, whereas urging a peer-vs-sub-agent split with nothing to
			// delegate to would point the model at a call the gate refuses.
			// `canFanOut(xcaps)` is defence in depth, not a live branch: `resolveCapabilities` empties
			// `delegateTargets` whenever the delegate tool is absent (core/capabilities.ts), so the
			// second conjunct already implies the first and no test can kill the first alone. Kept
			// because it states the structural rule the second conjunct only happens to encode.
			const canDelegate = xcaps ? canFanOut(xcaps) && h.agents.some((a) => canDelegateTo(xcaps, a.name)) : h.agents.length > 0;
			const scope = exocom.scope;
			const xbrief = buildExocomBrief((peers ?? []).map((p) => {
				const workspaceId = p.workspace_id ?? scope?.scopeWorkspaceId;
				const workspaceCode = p.workspace_code ?? (scope && workspaceId === scope.scopeWorkspaceId ? scope.scopeCode : undefined);
				const workspaceLabel = p.workspace_label
					?? (scope && workspaceId === scope.homeWorkspaceId ? scope.homeWorkspaceLabel : undefined);
				return {
					name: p.displayName,
					persona: p.persona,
					...(workspaceCode && workspaceLabel ? {
						workspaceCode,
						workspaceLabel,
						sameWorkspace: workspaceId === scope?.homeWorkspaceId,
					} : {}),
				};
			}), {
				canDelegate,
				tools: {
					name: !xcaps || canCallTool(xcaps, "exocom_name"),
					list: !xcaps || canCallTool(xcaps, "exocom_list"),
					send: !xcaps || canCallTool(xcaps, "exocom_send"),
					claim: scope?.joined !== true && (!xcaps || canCallTool(xcaps, "exocom_claim")),
					ask: !xcaps || canCallTool(xcaps, "exocom_ask"),
					answer: !xcaps || canCallTool(xcaps, "exocom_answer"),
					decline: !xcaps || canCallTool(xcaps, "exocom_decline"),
					wait: !xcaps || canCallTool(xcaps, "exocom_wait"),
					release: !xcaps || canCallTool(xcaps, "exocom_release"),
					progress: !xcaps || canCallTool(xcaps, "exocom_progress"),
					status: !xcaps || canCallTool(xcaps, "exocom_status"),
					task: !xcaps || canCallTool(xcaps, "exocom_task"),
					offer: !xcaps || canCallTool(xcaps, "exocom_offer"),
					publish: !xcaps || canCallTool(xcaps, "exocom_publish"),
					profile: !xcaps || canCallTool(xcaps, "exocom_profile"),
				},
				// Exocom has no UI gate, so a headless (`pi -p`) run has live peers and no way to ask
				// anyone anything. `hasUI` is pi's dialog capability, not a headcount (see the field's
				// doc) — but the clause it gates is an ask, and an ask needs a channel, not a person.
				canAskHuman: ctx.hasUI === true,
				namedByModel: exocom.namedByModel,
				// Naming changes display metadata only. Pending work still gates every work action.
				canNameNow: pi.getActiveTools().includes("exocom_name") && (!xcaps || canCallTool(xcaps, "exocom_name")),
				...(scope ? {
					joined: scope.joined,
					scopeCode: scope.scopeCode,
					homeWorkspaceLabel: scope.homeWorkspaceLabel,
					homeWorkspaceCode: scope.homeWorkspaceCode,
				} : {}),
			});
			if (xbrief) prompt = `${prompt}\n\n${xbrief}`;
			if (pendingBlock) prompt = `${prompt}\n\n${pendingBlock}`;
			else if (ledgerFailure) prompt = `${prompt}\n\n${ledgerFailure}`;
		}
		if (h.pendingOrchestration) {
			// The result is sub-agent text entering the SYSTEM prompt — fence it (I-guardrail:
			// untrusted output must never reach the supervisor unfenced, least of all here).
			if (h.pendingOrchestration.ok) {
				// Keep the established success hand-off byte-for-byte: successful mandatory runs are
				// still rulings the supervisor should present without spending the same council twice.
				prompt = `${prompt}\n\n[orchestration: ${h.pendingOrchestration.label}] The mandated multi-agent orchestration was run on the user's request and produced the result below. Present and build on it as your answer — do not re-run it:\n\n${fenceUntrusted(h.pendingOrchestration.output)}`;
			} else {
				const evidence = h.pendingOrchestration.error && h.pendingOrchestration.error !== h.pendingOrchestration.output
					? `${h.pendingOrchestration.output}\n\n--- RUNTIME ERROR ---\n${h.pendingOrchestration.error}`
					: h.pendingOrchestration.output;
				prompt = h.pendingOrchestration.failureKind === "abort"
					? `${prompt}\n\n[orchestration: ${h.pendingOrchestration.label}] The mandated multi-agent orchestration was CANCELLED. Report the cancellation; do not present its partial output as approved, and do not resume or re-run it unless the user explicitly asks:\n\n${fenceUntrusted(evidence)}`
					: `${prompt}\n\n[orchestration: ${h.pendingOrchestration.label}] The mandated multi-agent orchestration FAILED or remained unresolved. Do not present its output as approved or claim completion. Report the blocker, then repair and verify before declaring success:\n\n${fenceUntrusted(evidence)}`;
				reportMandatoryFailure(ctx, h.pendingOrchestration);
			}
			const receipt = resultReceiptHint(h.pendingOrchestration.resultReceipt);
			if (receipt) prompt += `\n\n${receipt}`;
			h.pendingOrchestration = undefined;
		}
		const clock = readClockSnapshot(now);
		return {
			...(prompt !== event.systemPrompt ? { systemPrompt: prompt } : {}),
			...(clock ? { message: { customType: "pi-persona-clock", content: clock, display: false } } : {}),
		};
	});

	pi.on("tool_call", (event, ctx) => {
		h.lastCtx = ctx;
		const startedAt = Date.now();
		h.telemetryToolStartedAt.set(event.toolCallId, { startedAt, name: event.toolName });
		h.telemetry?.publish("tool.started", {
			callId: event.toolCallId,
			agentId: "supervisor",
			name: event.toolName,
			status: "running",
		});
		const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
		// A blocked call never reaches tool_result, so close its telemetry here.
		const reject = <R>(result: R): R => {
			h.telemetryToolStartedAt.delete(event.toolCallId);
			h.telemetry?.publish("tool.finished", { callId: event.toolCallId, agentId: "supervisor", name: event.toolName, status: "failed" });
			return result;
		};
		const gate = h.controller.gate(event.toolName, event.input);
		if (gate) return reject(gate);
		if (exocom.ledgerFile) {
			let pending: ReturnType<ExocomInstall["pendingAsks"]>;
			try {
				pending = exocom.pendingAsks(ctx);
			} catch (error) {
				if (constrainedTurnAllows(event.toolName, input)) pending = [];
				else return reject({ block: true, reason: `exocom: ledger unavailable; mutation/delegation is fail-closed until storage recovers (${error instanceof Error ? error.message : String(error)})` });
			}
			if (pending.length > 0 && !constrainedTurnAllows(event.toolName, input)) {
				const omitted = pending.length > 1 ? `; ${pending.length - 1} more pending` : "";
				return reject({
					block: true,
					reason: `exocom: pending ask(s) to this session — only exocom_name (identity metadata), exocom_answer, exocom_decline, exocom_status, explicit collaboration read actions, read, grep, find, ls until you answer (ask_id=${pending[0]!.ask_id}${omitted})`,
				});
			}
			if (WRITE_TOOLS.has(event.toolName) && typeof input.path === "string" && input.path.trim()) {
				// Advisory: a ledger read failure here must not block an otherwise-allowed write.
				let claim: LedgerClaim | undefined;
				try {
					claim = peerClaimFor(input.path, exocom.ledgerState().claims, exocom.sessionId, ctx.cwd);
				} catch {
					claim = undefined;
				}
				if (claim) {
					const key = writeWarningKey(claim, input.path);
					if (!exocom.writeWarnings.seen(key)) {
						exocom.writeWarnings.remember(key);
						const label = exocom.peerLabelFor(claim.from_session) ?? claim.from_name;
						const reason = writeWarningReason(input.path, claim, label);
						// The toast carries only the one-line head; the fenced peer-authored claim block stays
						// in the model's tool result below — a notification is a single line, not the fence.
						try { if (ctx.hasUI) ctx.ui.notify(writeWarningToastReason(input.path, claim, label), "warning"); } catch { /* cosmetic */ }
						return reject({ block: true, reason });
					}
				}
			}
		}
		// A long leading sleep holds the turn that the idle-gated completion wake needs idle (and queues
		// the operator's steering). Interactive only: a headless leg runs inline, so the model is parked
		// in the delegate call and no wake is waiting on the turn.
		if (h.config.nudge && ctx.hasUI === true && !event.parentToolCallId && (event.toolName === "bash" || event.toolName === "powershell") && typeof input.command === "string") {
			const waitSeconds = longWaitSeconds(input.command);
			const running = h.tracker.running().map((run) => run.id);
			if (waitSeconds !== undefined && running.length + launching.size > 0) {
				const instead = [toolAllowed("timer") && "a fixed clock time use timer arm", toolAllowed("monitor") && toolAllowed("bash") && "an external event use monitor"].filter(Boolean).join("; for ");
				return reject({
					block: true,
					reason: `A ${Math.round(waitSeconds)}s wait blocks the completion wake and operator steering of ${running.length > 0 ? `the running sub-agents (${running.join(", ")})` : "the sub-agents you are launching"}. A finished run or batch wakes you by itself - end your turn.${instead ? ` For ${instead} - never to wait for these children.` : ""}`,
				});
			}
		}
		if (event.toolName === "intercom") {
			const action = typeof input.action === "string" ? input.action : "message";
			if (action === "send" || action === "reply") {
				const text = typeof input.message === "string" ? input.message : "";
				const askId = typeof input.askId === "string" ? input.askId : undefined;
				h.telemetryIntercomPending.set(event.toolCallId, {
					kind: action,
					to: h.intercomRecipient(input, askId),
					size: Buffer.byteLength(text, "utf8"),
					...(askId ? { replyTo: askId } : {}),
				});
				h.telemetry?.publish(action === "reply" ? "message.replied" : "message.sent", {
					id: event.toolCallId,
					channel: "intercom",
					from: "supervisor",
					to: h.intercomRecipient(input, askId),
					kind: action,
					status: "queued",
					expectsReply: false,
					size: Buffer.byteLength(text, "utf8"),
					...(askId ? { replyTo: askId } : {}),
				});
			}
		}
		if (event.toolName === "exocom_send") {
			const text = typeof input.message === "string" ? input.message : "";
			const target = typeof input.target === "string" ? input.target : "";
			const replyTo = typeof input.in_reply_to === "string" && input.in_reply_to.length > 0 ? input.in_reply_to : undefined;
			let peers: DisplayPeer[] = [];
			try { peers = exocom.plane?.listPeers() ?? []; } catch { /* h.telemetry cannot break the tool */ }
			const sessions = canonicalExocomTelemetryTargets(peers, target);
			const size = Buffer.byteLength(text, "utf8");
			const pending = sessions.map((sessionId) => ({
				id: sessions.length === 1 ? event.toolCallId : `${event.toolCallId}:${sessionId}`,
				sessionId,
				target: target === "*" ? (peers.find((peer) => peer.session_id === sessionId)?.target ?? sessionId) : target,
				size,
				...(replyTo ? { replyTo } : {}),
			}));
			if (pending.length > 0) h.telemetryExocomPending.set(event.toolCallId, pending);
			for (const message of pending) h.telemetry?.publish("message.sent", {
				id: message.id,
				channel: "exocom",
				from: exocom.telemetrySessionId(ctx),
				to: message.sessionId,
				kind: "message",
				status: "queued",
				expectsReply: false,
				size: message.size,
				...(message.replyTo ? { replyTo: message.replyTo } : {}),
			});
		}
		if (event.toolName === "delegate" || event.toolName === "council" || event.toolName === "flow") launching.add(event.toolCallId);
		return undefined;
	});

	// Delegation nudge (h.config.nudge; delegating h.personas only): when the supervisor grinds a RUN of
	// hands-on commands by hand — a by-hand sweep with no hand-off — append a reminder to the
	// offending tool's result. It lands in RECENT context, on the very command that tripped it, where
	// a top-of-prompt persona directive has already lost its pull. Sub-h.agents run in their own
	// sessions, so this hook only ever sees the SUPERVISOR's own tools. A `delegate`/`council`/`flow`
	// result resets the run (a failed `flow` is self-describing and neither resets nor nudges).
	pi.on("tool_result", (event, ctx) => {
		h.lastCtx = ctx;
		const open = h.telemetryToolStartedAt.get(event.toolCallId);
		h.telemetryToolStartedAt.delete(event.toolCallId);
		launching.delete(event.toolCallId);
		if (open !== undefined) {
			h.telemetry?.publish("tool.finished", {
				callId: event.toolCallId,
				agentId: "supervisor",
				name: event.toolName,
				status: event.isError ? "failed" : "done",
				durationMs: Math.max(0, Date.now() - open.startedAt),
			});
		}
		const telemetryInput = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
		if (event.toolName === "exocom_send") {
			const pending = h.telemetryExocomPending.get(event.toolCallId) ?? [];
			h.telemetryExocomPending.delete(event.toolCallId);
			const details = event.details && typeof event.details === "object" && !Array.isArray(event.details)
				? event.details as {
					target?: unknown;
					msg_id?: unknown;
					sent?: unknown;
					failed?: Array<{ target?: unknown }>;
					failedCount?: unknown;
					omittedFailures?: unknown;
				}
				: undefined;
			const receipts = Array.isArray(details?.sent)
				? details.sent.flatMap((receipt) => {
					if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [];
					const item = receipt as { target?: unknown; msg_id?: unknown };
					return typeof item.target === "string" && typeof item.msg_id === "string" && item.msg_id.length > 0
						? [{ target: item.target, msgId: item.msg_id }]
						: [];
				})
				: [];
			const sampledFailures = details?.failed ?? [];
			const failedTargets = new Set(sampledFailures.flatMap((failure) => typeof failure.target === "string" ? [failure.target] : []));
			// A broadcast samples its failures (`MAX_BROADCAST_DETAIL_ITEMS` in tools/exocom.ts) and
			// reports the rest as a count, so the sample alone CLEARS nobody: with more failures than
			// the sample holds, a recipient we cannot find in it is unknown, never delivered.
			const declaredFailures = typeof details?.failedCount === "number" ? details.failedCount : sampledFailures.length;
			const omittedFailures = Math.max(
				typeof details?.omittedFailures === "number" ? details.omittedFailures : 0,
				declaredFailures - sampledFailures.length,
			);
			for (const message of pending) {
				const matchingReceipts = !event.isError && details?.target === "*"
					? receipts.filter((receipt) => receipt.target === message.target)
					: [];
				const failed = event.isError || failedTargets.has(message.target);
				const wireId = failed ? undefined
					: details?.target === message.target && typeof details.msg_id === "string" && details.msg_id.length > 0
						? details.msg_id
						: matchingReceipts.length === 1 ? matchingReceipts[0]!.msgId : undefined;
				h.telemetry?.publish("message.sent", {
					id: message.id,
					channel: "exocom",
					from: exocom.telemetrySessionId(ctx),
					to: message.sessionId,
					kind: "message",
					// A matching successful ACK receipt settles this recipient even when the bounded
					// broadcast failure sample omitted failures for other peers. Without a receipt, an
					// incomplete failure sample cannot prove this particular row was delivered.
					status: failed ? "failed" : omittedFailures > 0 && wireId === undefined ? "unknown" : "delivered",
					expectsReply: false,
					size: message.size,
					...(message.replyTo ? { replyTo: message.replyTo } : {}),
					...(wireId ? { wireId } : {}),
				});
			}
		}
		if (event.toolName === "intercom") {
			const action = typeof telemetryInput.action === "string" ? telemetryInput.action : "";
			// The open entry is the right to publish a terminal: once the turn-boundary drain has closed
			// this call, a late result must not report it a second time.
			const pending = h.telemetryIntercomPending.get(event.toolCallId);
			h.telemetryIntercomPending.delete(event.toolCallId);
			if (pending && (action === "send" || action === "reply")) {
				const text = typeof telemetryInput.message === "string" ? telemetryInput.message : "";
				const askId = typeof telemetryInput.askId === "string" ? telemetryInput.askId : undefined;
				h.telemetry?.publish(action === "reply" ? "message.replied" : "message.sent", {
					id: event.toolCallId,
					channel: "intercom",
					from: "supervisor",
					// Ask settlement has already retired its sender lookup. The tool-start
					// snapshot owns the recipient for both queued and terminal telemetry.
					to: pending.to,
					kind: action,
					status: event.isError ? "failed" : action === "reply" ? "replied" : "delivered",
					expectsReply: false,
					size: Buffer.byteLength(text, "utf8"),
					...(askId ? { replyTo: askId } : {}),
				});
			}
		}
		const errorPatch = piPersonaToolErrorPatch(event.details);
		if (!h.config.nudge) return errorPatch;
		// Only a supervisor that CAN delegate is nudged to — a persona without the tool can't act on it.
		if (!h.controller.capabilities?.tools.has("delegate")) return errorPatch;
		const text = event.content.reduce((s, c) => (c.type === "text" ? s + c.text : s), "");
		const relayed = pendingSurrenderRelays.delete(event.toolCallId);
		const surrender = relayed ? h.persistenceNudge.scan(text) : h.persistenceNudge.observe(event.toolName, text);
		// A NESTED call (a codemode script's `ctx.executeTool`) is a real execution — the gate, the
		// telemetry above and the error patch all already ran — but its content is not a model-facing
		// tool result. The caller chooses what to print or discard; only that outer output is charged
		// to the context-burn run. Appending a note here would modify programmatic data and could
		// create an invisible reminder. `parentToolCallId` is the host's explicit marker; `<parent>/<n>`
		// id shape is never inferred from the id string.
		if (typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0) {
			if (surrender) rememberSurrenderRelay(event.parentToolCallId);
			// A hand-off that actually landed ends the run even when a script issued it, so the reset is
			// NOT dropped here. A FAILED one does not reset, and its repair note would be invisible:
			// the next model-visible result is what reports the streak.
			if (!errorPatch && event.isError !== true && HANDOFF_TOOL_NAMES.has(event.toolName)) h.delegationNudge.reset();
			return errorPatch;
		}
		const notes: string[] = [];
		// Grinding-by-hand reminder: a RUN of substantive hands-on commands on the supervisor's own
		// tools (delegate/council/flow reset the run). `size` classifies substantive vs glue + fat dump.
		const size = text.length;
		const sweepNote = h.delegationNudge.observe(event.toolName, size, !errorPatch && event.isError !== true, text);
		if (sweepNote) notes.push(sweepNote);
		// Premature-surrender reminder: a delegated leg that came back BLOCKED/UNKNOWN (delegate/council/flow
		// results only; because those reset the run the two never fire on one event).
		if (surrender) notes.push(surrender);
		if (notes.length === 0) return errorPatch;
		const joined = notes.join("\n\n");
		// Keep the semantic copy in the tool result for the model, and add a TUI-only durable card for
		// the operator. Built-in/custom tool renderers are free to hide `content` when collapsed (some
		// ignore it even when expanded), so the entry is the only cross-tool visibility guarantee.
		h.appendNudgeEntry(joined);
		return { ...errorPatch, content: [...event.content, { type: "text", text: joined }] };
	});

	// Mandatory orchestration: when the active persona declares a strategy/parallel/
	// pipeline mode (or a flow), run it on the user's turn (the LLM cannot skip it) and
	// fold the result into the prompt. Opportunistic h.personas (no orchestration) take the
	// normal turn.
	function mandatoryFailure(label: string, output: string, error: string, failureKind: FailureKind, resultReceipt?: ResultReceipt): MandatoryOutcome {
		return { label, output, ok: false, error, failureKind, ...(resultReceipt ? { resultReceipt } : {}) };
	}

	/** Make a mandatory failure visible outside the hidden system prompt too. The cause may contain
	 * provider/model text, so compact it to one bounded operator-facing line. */
	function reportMandatoryFailure(ctx: ExtensionContext, outcome: MandatoryOutcome): void {
		const label = compactInlineText(outcome.label, { maxChars: 120 });
		const cause = toastCause(outcome.error ?? "unresolved result", 200);
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
				const parsed = h.loadFlow(ctx.cwd, flowName);
				if (!parsed) {
					const error = `no flow named "${flowName}"`;
					return mandatoryFailure(label, error, error, "contract");
				}
				if (!parsed.ok) {
					const error = `flow "${flowName}" is invalid: ${parsed.error}`;
					return mandatoryFailure(label, error, error, "contract");
				}
				const outcome = await h.runFlowVisible(ctx, parsed.flow, task);
				const output = outcome.output || "(the flow returned no output)";
				if (outcome.ok) return { label, output, ok: true, ...(outcome.resultReceipt ? { resultReceipt: outcome.resultReceipt } : {}) };
				const error = outcome.cancelled
					? "the mandatory flow was aborted"
					: (outcome.error ?? "the mandatory flow did not complete successfully");
				const failureKind = outcome.cancelled ? "abort" : (outcome.failureKind ?? "agent");
				return mandatoryFailure(label, output, error, failureKind, outcome.resultReceipt);
			}

			const result = await h.runStrategyVisible(ctx, orch, task, "strategy");
			if (!result) {
				const error = "the mandatory orchestration returned no result";
				return mandatoryFailure(label, `(${error})`, error, "contract");
			}
			if (!result.ok) {
				return mandatoryFailure(
					label,
					result.output || "(the orchestration returned no output)",
					result.error ?? "the mandatory orchestration did not complete successfully",
					result.failureKind ?? "agent", result.resultReceipt,
				);
			}
			return { label, output: result.output, ok: true, ...(result.resultReceipt ? { resultReceipt: result.resultReceipt } : {}) };
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
		if (h.deferredOrchestrations.length >= h.MAX_DEFERRED_ORCHESTRATIONS) {
			ctx.ui.notify(
				`persona orchestration queue full (${h.MAX_DEFERRED_ORCHESTRATIONS}); input was not accepted — retry after the current run settles.`,
				"error",
			);
			return { action: "handled" };
		}
		h.deferredOrchestrations.push({ task, orchestration });
		ctx.ui.notify(`persona orchestration queued (${h.deferredOrchestrations.length}) — it will run after the current turn settles.`, "info");
		return { action: "handled" };
	}

	async function processNextDeferredOrchestration(): Promise<boolean> {
		if (h.disposed || h.processingDeferredOrchestration || h.deferredOrchestrations.length === 0 || !h.lastCtx) return false;
		const item = h.deferredOrchestrations.shift()!;
		h.processingDeferredOrchestration = true;
		h.orchestrating = true;
		try {
			const result = await executeMandatoryOrchestration(h.lastCtx, item.orchestration, item.task);
			if (h.disposed) return false;
			h.pendingOrchestration = result;
			// Source is "extension", so the input hook will not orchestrate this replay again.
			sendPersonaFollowUp(pi, item.task, "pi-persona-deferred-input");
			return true;
		} catch (err) {
			h.pendingOrchestration = undefined;
			if (!h.disposed) {
				h.deferredOrchestrations.unshift(item);
				h.lastCtx.ui.notify(`could not replay deferred persona input: ${toastCause(err instanceof Error ? err.message : String(err))}`, "error");
			}
			return false;
		} finally {
			h.orchestrating = false;
			h.processingDeferredOrchestration = false;
		}
	}

	pi.on("input", async (event, ctx) => {
		h.lastCtx = ctx;
		if (event.source === "extension") return undefined;
		h.pollGuard?.reset(); // a real operator message earns a fresh look
		const orch = h.controller.activePersona?.orchestration;
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
			ctx.ui.notify(h.personaGrammarError(err), "error");
			return undefined;
		}
		if (!flowName && !strategyName) return undefined;
		const mainBusy = ctx.isIdle() !== true;
		// Steering belongs to the turn already in progress. Never start a competing mandatory
		// orchestration for it; Pi remains responsible for applying the steering message.
		if (mainBusy && event.streamingBehavior !== "followUp") return { action: "continue" };
		// Follow-up input must retain mandatory semantics without racing the live run. An input that
		// arrives while another orchestration is executing joins the same FIFO even if Pi is idle.
		if (mainBusy || h.orchestrating) return enqueueDeferredOrchestration(task, orch, ctx);
		h.orchestrating = true;
		try {
			h.pendingOrchestration = await executeMandatoryOrchestration(ctx, orch, task);
		} finally {
			h.orchestrating = false;
		}
		// Let the user's original prompt proceed; the ruling is injected (hidden) into the
		// turn's system prompt via before_agent_start — no internal plumbing in the chat.
		return undefined;
	});
}

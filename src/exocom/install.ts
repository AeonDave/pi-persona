/**
 * Exocom plane + work ledger + wait + tools. Owns session-scoped plane state.
 */
import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { IdleCoalescingNotifier } from "../engine/async.ts";
import { attributePeer } from "../core/fence.ts";
import { exocomSelfStatusLabel, exocomSelfWidgetLabel } from "../core/naming.ts";
import type { PiPersonaConfig } from "../core/config.ts";
import { EXOCOM_TOOL_NAMES } from "../core/capabilities.ts";
import type { DelegationNudge } from "../core/nudge.ts";
import { shortModel } from "../tools/delegate.ts";
import { boundDisplayRows } from "../ui/presentation.ts";
import type { PersonaController } from "../persona/controller.ts";
import { type InstanceDescriptor, type PeerDescriptor } from "../telemetry/contract.ts";
import type { TelemetryProducer } from "../telemetry/producer.ts";
import {
	boundExocomInboundBatch,
	canDeliverPersonaNotification,
	EXOCOM_INBOX_MAX,
	exocomInboundBatchSize,
	exocomInboundDisposition,
	formatExocomQueuedBatchToast,
	sanitizePeerField,
	sendPersonaFollowUp,
	shouldReportHeartbeatFailure,
	type ExocomQueuedToast,
} from "../extension/shared.ts";
import { SeenMessages, SenderBudget } from "./guards.ts";
import { EXOCOM } from "./limits.ts";
import { endpoint as exocomEndpointFor, ledgerPath, workspaceHash } from "./paths.ts";
import { ExocomPlane, type DisplayPeer } from "./plane.ts";
import {
	answerFor,
	commitLedgerEvent,
	loadLedger,
	pendingAskBlock,
	pendingAsksTo,
	pruneLedger,
	type LedgerAnswer,
	type LedgerAsk,
	type LedgerPruneOptions,
	type LedgerState,
} from "./ledger.ts";
import { buildInboundDelivery } from "./inbound.ts";
import type { ExocomSemanticFrame } from "./envelope.ts";
import { prune as pruneExocom, type RegistryEntry } from "./registry.ts";
import { registerExocomTools } from "../tools/exocom.ts";
import { registerExocomWorkTools } from "../tools/exocom-work.ts";

export interface ExocomHost {
	readonly pi: ExtensionAPI;
	readonly config: PiPersonaConfig;
	readonly controller: PersonaController;
	get lastCtx(): ExtensionContext | undefined;
	get disposed(): boolean;
	get orchestrating(): boolean;
	get processingDeferredOrchestration(): boolean;
	get telemetry(): TelemetryProducer | undefined;
	readonly delegationNudge: DelegationNudge;
	userAgentDir(): string;
}

export interface ExocomInstall {
	reconcile(ctx: ExtensionContext): Promise<void>;
	queue(op: () => Promise<void>): Promise<void>;
	stop(): Promise<void>;
	onPersonaChanged(ctx: ExtensionContext): Promise<void>;
	syncActiveTools(): void;
	telemetrySessionId(ctx: ExtensionContext): string;
	currentTelemetryInstance(ctx: ExtensionContext): InstanceDescriptor;
	publishTelemetryPeers(peers?: DisplayPeer[]): void;
	get plane(): ExocomPlane | undefined;
	get name(): string;
	get namedByModel(): boolean;
	renderWidget(): void;
	get ledgerFile(): string;
	pendingAsks(ctx: ExtensionContext): LedgerAsk[];
	pendingAskPrompt(ctx: ExtensionContext): string | undefined;
	get notifier(): IdleCoalescingNotifier<string> | undefined;
	get waitNotifier(): IdleCoalescingNotifier<string> | undefined;
	kickWait(): void;
}

export function installExocom(pi: ExtensionAPI, host: ExocomHost): ExocomInstall {
	// ── exocom (opt-in, T9): the EXTERNAL peer-to-peer plane ─────────────────────
	// Independent top-level pi instances in this workspace discover + message each other
	// directly (flat) — distinct from the broker/intercom plane above, which is strictly
	// hierarchical (a supervisor and its OWN spawned children). Off by default (host.config.exocom /
	// --exocom), additionally gated by the active persona's canUseBus capability; no active
	// persona ⇒ unrestricted (mirrors delegationBrief's own reading of an absent capability set,
	// rather than silently refusing to join for an unpersona'd session — see startExocom below).
	let exocomPlane: ExocomPlane | undefined;
	let exocomLedgerFile = "";
	let exocomSessionId = "";
	let exocomName = "";
	let exocomNamedByModel = false;
	interface ExocomWaiter { id: string; work_key: string; ask_id: string; handle: ReturnType<typeof setTimeout>; }
	const exocomWaiters: ExocomWaiter[] = [];
	let exocomWaitSeq = 0;
	let exocomWaitNotifier: IdleCoalescingNotifier<string> | undefined;
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

	function currentLedgerPruneOptions(): LedgerPruneOptions | undefined {
		const plane = exocomPlane;
		if (!plane || !exocomSessionId) return undefined;
		try {
			const liveSessions = new Set([exocomSessionId, ...plane.listPeers().map((peer) => peer.session_id)]);
			return {
				now: Date.now(),
				ttlMs: EXOCOM.LEDGER_RESULT_TTL_MS,
				liveSessions,
			};
		} catch {
			// Registry uncertainty must not erase ownership in memory. Keep the durable state until
			// liveness can be established again; the hooks will still fail closed on ledger I/O itself.
			return undefined;
		}
	}

	function currentLedgerState(): LedgerState {
		if (!exocomLedgerFile) throw new Error("exocom ledger is not available");
		const state = loadLedger(exocomLedgerFile);
		const prune = currentLedgerPruneOptions();
		return prune ? pruneLedger(state, prune) : state;
	}

	function pendingAsksFor(ctx: ExtensionContext): LedgerAsk[] {
		if (!exocomLedgerFile) return [];
		return pendingAsksTo(currentLedgerState(), exocomSessionId || ctx.sessionManager.getSessionId());
	}

	function pendingAskPromptFor(ctx: ExtensionContext): string | undefined {
		const asks = pendingAsksFor(ctx);
		let labels = new Map<string, string>();
		try {
			labels = new Map(exocomPlane?.listPeers().map((peer) => [peer.session_id, peer.displayName]) ?? []);
		} catch {
			/* Session ids are validated tokens and remain safe fallback attribution. */
		}
		return pendingAskBlock(asks, (sessionId) => labels.get(sessionId));
	}

	function renderLedgerAnswer(answer: LedgerAnswer, label = answer.from_session): string {
		return [
			`[pi-persona] exocom answer · work_key=${answer.work_key} ask_id=${answer.ask_id} ok=${answer.ok}`,
			attributePeer(label, answer.evidence),
		].join("\n");
	}

	// A tiny, stable name→color hash for the pool widget's swatch — exocom peers carry no
	// persona "label colour" of their own to read, so this derives one deterministically
	// instead of hardcoding one default for every peer.
	const EXOCOM_PALETTE = ["#36F9F6", "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF", "#C780FA", "#FF9F1C", "#00C2A8"];
	function exocomColorFor(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
		return EXOCOM_PALETTE[h % EXOCOM_PALETTE.length]!;
	}
	// Placeholder until the model invents a call-sign via `exocom_name`. Not a catalog pick —
	// display-dedup turns concurrent blanks into unnamed / unnamed#2 until someone names themselves.
	const EXOCOM_PLACEHOLDER_NAME = "unnamed";

	function telemetrySessionId(ctx: ExtensionContext): string {
		return (ctx as ExtensionContext & { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ?? `legacy-${process.pid}`;
	}

	function currentTelemetryInstance(ctx: ExtensionContext): InstanceDescriptor {
		const runtimeCtx = ctx as ExtensionContext & {
			sessionManager?: { getSessionId?: () => string };
			isIdle?: () => boolean;
			getContextUsage?: () => { percent?: number } | undefined;
		};
		const personaName = host.controller.activePersona?.name ?? "";
		const displayName = exocomSelfStatusLabel(exocomNamedByModel, exocomName, personaName);
		return {
			displayName,
			persona: host.controller.activePersona?.name ?? "",
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
			status: runtimeCtx.isIdle?.() === true ? "idle" : "active",
			pid: process.pid,
			// Clamped HERE, not merely in the producer's `sanitizeInstance`: that one runs only for
			// `instance.started`, so an out-of-range reading would ride `instance.updated` and
			// `instance.heartbeat` out to consumers, where the contract rejects the WHOLE event over
			// the one bad field.
			contextPercent: Math.max(0, Math.min(100, Math.round(runtimeCtx.getContextUsage?.()?.percent ?? 0))),
			exocomEnabled: exocomPlane !== undefined,
			color: exocomColorFor(displayName),
		};
	}

	function publishTelemetryPeers(peers?: DisplayPeer[]): void {
		const producer = host.telemetry;
		if (!producer) return;
		let pool = peers;
		if (!pool) {
			try { pool = exocomPlane?.listPeers() ?? []; } catch { pool = []; }
		}
		const now = Date.now();
		const payload: PeerDescriptor[] = pool.map((peer) => ({
			sessionId: peer.session_id,
			displayName: peer.displayName,
			persona: peer.persona,
			model: peer.model,
			contextPercent: peer.context_pct,
			status: now - Date.parse(peer.heartbeat_at) > EXOCOM.QUIET_AFTER_MS ? "idle" : "online",
			...(peer.color ? { color: peer.color } : {}),
			sent: exocomPlane?.sentToPeer(peer.session_id) ?? 0,
			received: exocomPlane?.receivedFromPeer(peer.session_id) ?? 0,
		}));
		producer.publish("peers.snapshot", { peers: payload });
	}

	// One row per live peer (the registry read itself IS the pool — each peer refreshes its
	// own entry on its own heartbeat, so no ping fan-out is needed here). Best-effort/cosmetic,
	// mirrors renderAgentWidget above.
	function renderExocomWidget(): void {
		if (!host.lastCtx || !exocomPlane) return;
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
		publishTelemetryPeers(peers);
		try {
			const now = Date.now();
			const selfPersona = sanitizePeerField(host.controller.activePersona?.name ?? "", 48);
			const selfModel = sanitizePeerField(host.lastCtx.model ? `${host.lastCtx.model.provider}/${host.lastCtx.model.id}` : "", 96);
			const selfContextPct = Math.max(0, Math.min(100, Math.round(host.lastCtx.getContextUsage()?.percent ?? 0)));
			const ident = exocomSelfWidgetLabel(exocomNamedByModel, exocomName, selfPersona);
			const roleBit = exocomNamedByModel && selfPersona ? ` · ${selfPersona}` : "";
			const local = `📡 ${ident}${roleBit} · ${shortModel(selfModel) || "?"} · ctx ${selfContextPct}%`;
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
			host.lastCtx.ui.setWidget("persona-exocom", lines, { placement: "aboveEditor" });
		} catch {
			/* cosmetic — the widget is best-effort */
		}
		try {
			host.lastCtx.ui.setStatus(
				"persona-exocom",
				`📡 ${exocomSelfStatusLabel(exocomNamedByModel, exocomName, host.controller.activePersona?.name ?? "")} · ${peers.length} peer${peers.length === 1 ? "" : "s"} · ${exocomPlane?.totalReceived ?? 0} in · ${exocomPlane?.totalSent ?? 0} out`,
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
		const persona = sanitizePeerField(host.controller.activePersona?.name ?? "", 48);
		const model = sanitizePeerField(host.lastCtx?.model ? `${host.lastCtx.model.provider}/${host.lastCtx.model.id}` : "", 96);
		const entry: RegistryEntry = {
			session_id: sessionId,
			name: exocomName,
			persona,
			purpose: host.controller.activePersona?.description ?? "",
			color: exocomColorFor(exocomName),
			model,
			pid: process.pid,
			endpoint: ep,
			cwd,
			context_pct: Math.round(host.lastCtx?.getContextUsage()?.percent ?? 0),
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
		if (!(host.config.exocom || pi.getFlag("exocom") === true)) return;
		if (!(host.controller.capabilities?.canUseBus ?? true)) return;
		try {
			const hash = workspaceHash(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();
			exocomSessionId = sessionId;
			const agentDir = host.userAgentDir();
			// Placeholder only. The model invents the real call-sign via `exocom_name` from the
			// feel of the session — no catalog is assigned here. Registry key is session_id.
			pruneExocom(agentDir, hash, { now: Date.now(), staleMs: EXOCOM.STALE_AFTER_MS });
			exocomName = EXOCOM_PLACEHOLDER_NAME;
			exocomNamedByModel = false;
			const ep = exocomEndpointFor(agentDir, hash, sessionId, process.platform);
			const persona = sanitizePeerField(host.controller.activePersona?.name ?? "", 48);
			const model = sanitizePeerField(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", 96);
			exocomBudget = new SenderBudget({ windowMs: EXOCOM.SENDER_WINDOW_MS, maxMsgs: EXOCOM.SENDER_MAX_MSGS, maxBytes: EXOCOM.SENDER_MAX_BYTES });
			exocomSeen = new SeenMessages({ ttlMs: EXOCOM.SEEN_TTL_MS });
			exocomLedgerFile = ledgerPath(agentDir, hash);
			exocomWaitNotifier = new IdleCoalescingNotifier<string>({
				isIdle: () => canDeliverPersonaNotification(host.orchestrating, host.processingDeferredOrchestration, host.lastCtx?.isIdle?.() === true),
				deliver: (message) => sendPersonaFollowUp(pi, message, "pi-persona"),
				render: (items) => items.join("\n\n"),
				setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
				clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
			});
			// Fenced, attributed follow-up delivery — idle-gated + rate-limited (R6), the same
			// discipline completionNotifier/intercomNotifier/timerNotifier apply above, but through
			// pi.sendMessage (a distinct, labellable custom message) rather than pi.sendUserMessage
			// (mirrors the bridge's own `sendFollowUp` for inbound cross-process text).
			exocomNotifier = new IdleCoalescingNotifier<string>({
				isIdle: () => canDeliverPersonaNotification(host.orchestrating, host.processingDeferredOrchestration, host.lastCtx?.isIdle?.() === true),
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
						host.lastCtx?.ui.notify(message, "info");
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
			const fireWaiters = (answer: LedgerAnswer, label?: string): boolean => {
				let fired = false;
				for (let i = exocomWaiters.length - 1; i >= 0; i--) {
					const waiter = exocomWaiters[i]!;
					if (waiter.work_key !== answer.work_key || waiter.ask_id !== answer.ask_id) continue;
					clearTimeout(waiter.handle);
					exocomWaiters.splice(i, 1);
					exocomWaitNotifier?.notify(renderLedgerAnswer(answer, label));
					fired = true;
				}
				return fired;
			};
			const armExocomWait = (work_key: string, ask_id: string, timeoutMs: number) => {
				const existing = answerFor(currentLedgerState(), ask_id, sessionId);
				if (existing) {
					if (existing.work_key !== work_key) throw new Error("exocom_wait: work_key does not match the retained answer");
					const hint = `ask_id=${ask_id}`;
					exocomWaitNotifier?.discard((item) => item.includes(hint));
					exocomNotifier?.discard((item) => item.includes(hint));
					return { status: "answered" as const, answer: existing };
				}
				const pending = currentLedgerState().asks.find((ask) => ask.ask_id === ask_id && ask.from_session === sessionId);
				if (!pending) throw new Error(`exocom_wait: no pending outbound ask "${ask_id}"`);
				if (pending.work_key !== work_key) throw new Error("exocom_wait: work_key does not match the pending ask");
				const id = `exocom-wait-${++exocomWaitSeq}`;
				const handle = setTimeout(() => {
					const idx = exocomWaiters.findIndex((w) => w.id === id);
					if (idx >= 0) exocomWaiters.splice(idx, 1);
					try {
						const landed = answerFor(currentLedgerState(), ask_id, sessionId);
						exocomWaitNotifier?.notify(landed
							? renderLedgerAnswer(landed)
							: `[pi-persona] exocom wait timed out after ${timeoutMs}ms · work_key=${work_key} ask_id=${ask_id}`);
					} catch (error) {
						exocomWaitNotifier?.notify(`[pi-persona] exocom wait could not read the ledger · ask_id=${ask_id} · ${error instanceof Error ? error.message : String(error)}`);
					}
				}, timeoutMs);
				handle.unref?.();
				const waiter: ExocomWaiter = { id, work_key, ask_id, handle };
				exocomWaiters.push(waiter);
				// Close the small cross-process window between the first read and waiter registration.
				const raced = answerFor(currentLedgerState(), ask_id, sessionId);
				if (raced) {
					clearTimeout(handle);
					const idx = exocomWaiters.indexOf(waiter);
					if (idx >= 0) exocomWaiters.splice(idx, 1);
					const hint = `ask_id=${ask_id}`;
					exocomWaitNotifier?.discard((item) => item.includes(hint));
					exocomNotifier?.discard((item) => item.includes(hint));
					return { status: "answered" as const, answer: raced };
				}
				return { status: "waiting" as const, id };
			};
			const dispatchSemantic = async (frame: ExocomSemanticFrame): Promise<{ msg_id: string }> => {
				const plane = exocomPlane;
				if (!plane) throw new Error("exocom is not active for this persona");
				if (!exocomLedgerFile) throw new Error("exocom ledger is not available");
				let target: DisplayPeer | undefined;
				if (frame.kind === "ask") {
					target = plane.listPeers().find((peer) => peer.session_id === frame.to_session);
					if (!target) throw new Error(`exocom: unknown peer session "${frame.to_session}"`);
				} else if (frame.kind === "answer") {
					const ask = currentLedgerState().asks.find((candidate) => candidate.ask_id === frame.ask_id);
					if (!ask) throw new Error(`exocom: answer for unknown ask_id "${frame.ask_id}"`);
					target = plane.listPeers().find((peer) => peer.session_id === ask.from_session);
				}
				const prune = currentLedgerPruneOptions();
				const applied = commitLedgerEvent(exocomLedgerFile, frame, prune ? { prune } : {});
				if (!applied.ok) throw new Error(`exocom: ${applied.error}`);
				if (applied.duplicate === true) return { msg_id: frame.msg_id };
				// Claims/progress/releases are authoritative in the shared ledger and need no postcard.
				// Ask/answer use the wire only as a signed immediate-wake signal; durable state remains
				// recoverable if that signal fails.
				if (target && (frame.kind === "ask" || frame.kind === "answer")) {
					try {
						await plane.sendSemantic(target.target, frame);
					} catch (error) {
						try {
							host.lastCtx?.ui.notify(
								`exocom: ledger updated, but ${frame.kind} wake to ${target.displayName} was deferred (${error instanceof Error ? error.message : String(error)}).`,
								"warning",
							);
						} catch { /* the durable result is still recoverable from the ledger */ }
					}
				}
				return { msg_id: frame.msg_id };
			};

			exocomPlane = new ExocomPlane({

				agentDir,
				hash,
				identity: {
					session_id: sessionId,
					name: exocomName,
					persona,
					purpose: host.controller.activePersona?.description ?? "",
					color: exocomColorFor(exocomName),
					model,
					endpoint: ep,
					cwd: ctx.cwd,
				},
				getCard: () => ({
					name: exocomName,
					persona: sanitizePeerField(host.controller.activePersona?.name ?? "", 48),
					model: sanitizePeerField(host.lastCtx?.model ? `${host.lastCtx.model.provider}/${host.lastCtx.model.id}` : "", 96),
					context_pct: Math.round(host.lastCtx?.getContextUsage()?.percent ?? 0),
					inbox: exocomNotifier?.peekPending().length ?? 0,
				}),
				onInbound: (msg, fromEntry) => {
					const queued = exocomNotifier?.peekPending().length ?? 0;
					if (queued >= EXOCOM_INBOX_MAX) {
						if (!exocomInboxFull) {
							exocomInboxFull = true;
							try {
								host.lastCtx?.ui.notify(`exocom: inbox full (${queued} undelivered peer messages) — refusing further messages until it drains.`, "warning");
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
					host.telemetry?.publish("message.received", {
						id: msg.msg_id,
						channel: "exocom",
						from: fromEntry?.session_id ?? msg.from_session,
						to: sessionId,
						kind: "message",
						status: disposition.accepted ? "delivered" : "rejected",
						expectsReply: false,
						size: Buffer.byteLength(msg.text, "utf8"),
						...(msg.in_reply_to ? { replyTo: msg.in_reply_to } : {}),
					});
					if ("deliver" in decision) {
						exocomNotifier?.notify(decision.deliver);
						// Never inject peer text into a live model turn. A compact human-only toast makes
						// receipt visible while a long tool loop keeps the follow-up idle-gated.
						if (host.lastCtx?.isIdle?.() !== true) {
							exocomToastNotifier?.notify({ label, inReplyTo: msg.in_reply_to });
						}
					}
					// Plane accounting happens after this callback returns. Defer the render one
					// microtask so the inbound counter shown in the widget is the post-ACK value.
					queueMicrotask(() => {
						if (host.disposed) return;
						try {
							renderExocomWidget();
						} catch {
							/* cosmetic */
						}
					});
					return disposition;
				},
				onSemantic: (frame, fromEntry) => {
					if (!exocomLedgerFile) return { accepted: false, reason: "ledger unavailable" };
					if (exocomSeen?.seenBefore(frame.from_session, frame.msg_id)) return { accepted: true, duplicate: true };
					const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
					if (!exocomBudget?.allow(frame.from_session, bytes)) {
						exocomSeen?.forget(frame.from_session, frame.msg_id);
						return { accepted: false, reason: "semantic rate budget" };
					}
					let state: LedgerState;
					try {
						state = currentLedgerState();
					} catch (error) {
						exocomSeen?.forget(frame.from_session, frame.msg_id);
						return { accepted: false, reason: error instanceof Error ? error.message : "ledger unavailable" };
					}
					const label = exocomPlane?.humanDisplayLabelFor(fromEntry) ?? fromEntry.session_id;
					if (frame.kind === "ask") {
						if (frame.to_session !== sessionId) {
							exocomSeen?.forget(frame.from_session, frame.msg_id);
							return { accepted: false, reason: "ask addressed to another session" };
						}
						const stored = state.asks.find((ask) => ask.msg_id === frame.msg_id && ask.ask_id === frame.ask_id && ask.to_session === sessionId);
						if (!stored) {
							exocomSeen?.forget(frame.from_session, frame.msg_id);
							return { accepted: false, reason: "ask is not durable in the shared ledger" };
						}
						const block = pendingAskBlock([stored], () => label);
						if (block) exocomNotifier?.notify(block);
					} else if (frame.kind === "answer") {
						const stored = answerFor(state, frame.ask_id, sessionId);
						if (!stored || stored.msg_id !== frame.msg_id || stored.work_key !== frame.work_key) {
							exocomSeen?.forget(frame.from_session, frame.msg_id);
							return { accepted: false, reason: "answer is not durable for this requester" };
						}
						if (!fireWaiters(stored, label)) exocomNotifier?.notify(renderLedgerAnswer(stored, label));
					} else if (!state.seen.includes(frame.msg_id)) {
						exocomSeen?.forget(frame.from_session, frame.msg_id);
						return { accepted: false, reason: "semantic event is not durable in the shared ledger" };
					}
					return { accepted: true };
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
							host.lastCtx?.ui.notify(
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
					exocomNamedByModel = true;
					exocomHeartbeatTick(agentDir, hash, sessionId, ep, ctx.cwd);
				}
				return exocomName;
			});
			registerExocomWorkTools(pi, {
				getPlane: () => exocomPlane,
				sessionId: () => sessionId,
				name: () => exocomName,
				now: () => Date.now(),
				resolveTarget: (target) => {
					const plane = exocomPlane;
					if (!plane) throw new Error("exocom is not active for this persona");
					return plane.resolvePeer(target).session_id;
				},
				dispatch: dispatchSemantic,
				armWait: armExocomWait,
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
			const enabled = exocomPlane !== undefined && (host.controller.capabilities?.canUseBus ?? true);
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
	// `host.controller.capabilities` FRESH at bind time — this does the same for exocom. Already
	// running and still gated on ⇒ a no-op (the heartbeat already relabels under the new persona).
	async function applyExocomGate(ctx: ExtensionContext): Promise<void> {
		const shouldRun = (host.config.exocom || pi.getFlag("exocom") === true) && (host.controller.capabilities?.canUseBus ?? true);
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
		host.delegationNudge.reset();
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
		exocomWaitNotifier?.cancel();
		exocomWaitNotifier = undefined;
		for (const waiter of exocomWaiters) clearTimeout(waiter.handle);
		exocomWaiters.length = 0;
		// A clean shutdown relinquishes every slice/question owned by this exact session. Crash
		// recovery is the registry-liveness prune; this closes the normal lifecycle immediately.
		if (exocomLedgerFile && exocomSessionId) {
			try {
				const state = currentLedgerState();
				const workKeys = new Set([
					...state.claims.filter((claim) => claim.from_session === exocomSessionId).map((claim) => claim.work_key),
					...state.asks.filter((ask) => ask.from_session === exocomSessionId).map((ask) => ask.work_key),
				]);
				for (const work_key of workKeys) {
					const prune = currentLedgerPruneOptions();
					commitLedgerEvent(exocomLedgerFile, {
						kind: "release",
						work_key,
						from_session: exocomSessionId,
						from_name: exocomName || exocomSessionId,
						msg_id: randomUUID(),
						ts: new Date().toISOString(),
					}, prune ? { prune } : {});
				}
			} catch {
				/* Teardown stays best-effort; registry lease reconciliation handles a crash-equivalent. */
			}
		}
		exocomLedgerFile = "";
		exocomSessionId = "";
		exocomInboxFull = false; // a later plane reports its own first full inbox, not this one's tail
		exocomToastNotifier?.cancel();
		exocomToastNotifier = undefined;
		exocomBudget = undefined;
		exocomSeen = undefined;
		if (exocomPlane) {
			const plane = exocomPlane;
			exocomPlane = undefined;
			try {
				publishTelemetryPeers([]);
			} catch {
				/* the dying instance's last roster must not linger as live presence */
			}
			try {
				await plane.stop();
			} catch {
				/* never block shutdown on a teardown error */
			}
		}
		try {
			host.lastCtx?.ui.setWidget("persona-exocom", undefined, { placement: "aboveEditor" });
		} catch {
			/* cosmetic */
		}
		try {
			host.lastCtx?.ui.setStatus("persona-exocom", undefined);
		} catch {
			/* cosmetic */
		}
		exocomName = "";
		exocomNamedByModel = false;
	}
	return {
		reconcile: reconcileExocom,
		queue: queueExocom,
		stop: stopExocom,
		onPersonaChanged,
		syncActiveTools: syncExocomActiveTools,
		telemetrySessionId,
		currentTelemetryInstance,
		publishTelemetryPeers,
		get plane() { return exocomPlane; },
		get name() { return exocomName; },
		get namedByModel() { return exocomNamedByModel; },
		renderWidget: renderExocomWidget,
		get ledgerFile() { return exocomLedgerFile; },
		pendingAsks: pendingAsksFor,
		pendingAskPrompt: pendingAskPromptFor,
		get notifier() { return exocomNotifier; },
		get waitNotifier() { return exocomWaitNotifier; },
		kickWait() { exocomWaitNotifier?.kick(); },
	};
}

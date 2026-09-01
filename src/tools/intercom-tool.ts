/** `intercom` tool registration. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failureDetails } from "../extension/shared.ts";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { coachingDisabledHint, expandDetailHint, reconcileAnsweredAsk } from "../extension/shared.ts";
import {
	type AsyncRun, AsyncRunTracker, boundCompletionSurface, buildPeekDigest, buildWaitTimeoutNote,
	dedupeRunsById, getFullRunOutput, IdleCoalescingNotifier,
	renderCompletion, runDurationLabel,
} from "../engine/async.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { sanitizeDisplayLabel } from "../core/display-label.ts";
import { type IntercomParams, MAX_INTERCOM_MESSAGE_CHARS, MAX_INTERCOM_REF_CHARS, runIntercom } from "./intercom.ts";
import { fenceIntercomOutcome, type PendingAsk } from "../extension/shared.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import type { PersonaController } from "../persona/controller.ts";

export interface IntercomToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	tracker: AsyncRunTracker;
	completionNotifier: IdleCoalescingNotifier<AsyncRun>;
	intercomNotifier: IdleCoalescingNotifier<PendingAsk>;
	controller: PersonaController;
	bus: InProcessBus;
	SUPERVISOR: string;
	STALL_FLAG_MS: number;
	missingRunMessage(id: string, display: string | undefined): string;
	stopAgent(nodeId: string): boolean;
	steerAgent(nodeId: string, text: string): boolean;
	steerRegistry: Map<string, unknown>;
	stopRequested: Set<string>;
	drainBusBlock(): string;
	scanForSurrender(text: string): string | undefined;
	get disposed(): boolean;
}

export function registerIntercomTool(pi: ExtensionAPI, d: IntercomToolDeps): void {
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
					"peek = watch async sub-agents · result = retrieve one complete settled result by run id · wait = BLOCK until async run(s) settle and collect their bounded reports (a join) · steer = soft redirect into one by run id (it may ignore it) · stop = HARD-abort one by run id · list/inbox/reply/send = the coaching message d.bus (needs a coaching persona)",
			},
		),
		to: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "result/steer/stop/peek/wait: the async run id (e.g. 'run-1'; wait without it = all running) · send: the child d.bus handle (from `list`)" })),
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
			"`list`/`inbox`/`reply`/`send` are the message d.bus (a child reaching you via `contact_supervisor`)",
			"and need a `coaching: on` persona.",
		].join(" "),
		parameters: IntercomToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			// `to` comes from model-authored tool arguments. Use the exact value for routing, but never
			// interpolate it into trusted prose without reducing it to compact identifier metadata.
			const displayTarget = params.to === undefined ? undefined : sanitizeDisplayLabel(params.to, "run");
			// peek + wait + steer + stop are supervisor→child controls over the async d.tracker /
			// steer handles — available to EVERY persona (no dependency on the coaching d.bus).
			if (params.action === "peek") {
				// No `to` → running legs PLUS any settled-but-not-yet-delivered ones (the settle→deliver
				// gap), so a peek right after a leg finishes shows its result instead of "No async runs".
				const runs = params.to
					? [d.tracker.peek(params.to)].filter((r): r is AsyncRun => !!r)
					: dedupeRunsById([...d.tracker.running(), ...d.completionNotifier.peekPending()]);
				return { content: [{ type: "text", text: buildPeekDigest(runs, { now: Date.now(), stallMs: d.STALL_FLAG_MS }) }], details: { action: "peek", ok: true }, isError: false };
			}
			if (params.action === "result") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom result needs { to: <run id> }." }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				const run = d.tracker.peek(params.to);
				if (!run) {
					return { content: [{ type: "text", text: d.missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				if (run.status === "running") {
					return {
						content: [{ type: "text", text: `${displayTarget} is still running. Use intercom peek/wait, or request result after it settles.` }],
						details: failureDetails({ action: "result", ok: false, status: run.status }),
						isError: true,
					};
				}
				// Explicit collection owns this delivery: remove a still-buffered passive completion so the
				// same result cannot appear again as a follow-up a moment later. Telling the d.tracker too
				// makes this retained copy the first thing retention evicts — the supervisor has read it,
				// so it is the cheapest payload in the map to lose.
				d.completionNotifier.discard((pending) => pending.id === run.id);
				d.tracker.markCollected(run.id);
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
				if (params.to && !d.tracker.peek(params.to)) {
					return { content: [{ type: "text", text: d.missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "wait", ok: false }), isError: true };
				}
				const ids = params.to
					? [params.to]
					: dedupeRunsById([...d.tracker.running(), ...d.completionNotifier.peekPending()]).map((r) => r.id);
				if (ids.length === 0) {
					return { content: [{ type: "text", text: "No async runs to wait for." }], details: { action: "wait", ok: true }, isError: false };
				}
				// Bounded join: never longer than a child's ask timeout (d.bus `ask` default 600s),
				// so a coaching child blocking on OUR reply can't deadlock us past its own timeout.
				// Default matches that ceiling — heavy sub-agents (30+ turns) routinely outlast a
				// short window, and a premature "still running" forces a needless re-wait.
				const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 600_000, 1_000), 600_000);
				const runs = await d.tracker.waitFor(ids, timeoutMs, _signal);
				const settled = runs.filter((r) => r.status !== "running");
				const still = runs.filter((r) => r.status === "running");
				// These results are delivered HERE — drop them from the pending follow-up
				// notifier so they aren't reported a second time. Render through the SAME
				// renderCompletion the passive path uses, so a leg that came back BLOCKED still
				// carries the premature-surrender note when it is collected via `wait`.
				const settledIds = new Set(settled.map((r) => r.id));
				d.completionNotifier.discard((run) => settledIds.has(run.id));
				const report = settled.length > 0 ? renderCompletion(settled, fenceUntrusted, (t) => d.scanForSurrender(t)) : "";
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
				if (!d.steerRegistry.has(nodeId)) {
					return {
						content: [{ type: "text", text: `Cannot steer "${displayTarget}" — no live steer handle is available (the run may have finished or not started yet, or its engine/broker does not expose steering).` }],
						details: failureDetails({ action: "steer", ok: false }),
						isError: true,
					};
				}
				// Routed through the guarded d.steerAgent so a just-finished/d.disposed handle can't throw.
				const steered = d.steerAgent(nodeId, params.message);
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
				const repeated = d.stopRequested.has(nodeId);
				const stopped = d.stopAgent(nodeId);
				if (stopped && !repeated) {
					return { content: [{ type: "text", text: `Aborting ${displayTarget} — the sub-agent is being hard-stopped; its run will settle as aborted shortly.` }], details: { action: "stop", ok: true }, isError: false };
				}
				// A repeated stop has just invoked the REAL cancel handle again. Only now force-clear
				// d.tracker state if engine settlement is still lagging; the handle remains registered
				// until onComplete so cancellation can never be replaced by UI-only bookkeeping.
				if (stopped && repeated && d.tracker.forceSettle(params.to, "force-stopped by supervisor after repeated engine cancellation")) {
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

			// The message d.bus (coaching): list / inbox / reply / send.
			const out = runIntercom(params as IntercomParams, d.bus, d.SUPERVISOR);
			// An answered ask is settled on every surface it reached — never woken again, never
			// re-listed (the ask envelope is NOT drained by the peek path, which skips expectsReply).
			if (params.action === "reply" && out.details.ok && params.askId) {
				reconcileAnsweredAsk(params.askId, d.intercomNotifier, d.bus, d.SUPERVISOR);
			}
			// Child-authored inbox bodies are untrusted, exactly like the d.drainBusBlock/peek copies.
			let text = fenceIntercomOutcome(out, fenceUntrusted);
			if ((params.action === "list" || params.action === "inbox") && !d.controller.activePersona?.coaching) {
				text += `\n\n${coachingDisabledHint(d.controller.activePersona?.name)}`;
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
}

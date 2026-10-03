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
	MAX_ASYNC_STATUS_ROWS,
	dedupeRunsById, getFullRunOutput, IdleCoalescingNotifier,
	renderCompletion, runDisplayName, runDurationLabel,
} from "../engine/async.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { sanitizeDisplayLabel } from "../core/display-label.ts";
import { type IntercomOutcome, type IntercomParams, MAX_INTERCOM_MESSAGE_CHARS, MAX_INTERCOM_REF_CHARS, runIntercom } from "./intercom.ts";
import { fenceIntercomOutcome, type PendingAsk } from "../extension/shared.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import type { PersonaController } from "../persona/controller.ts";
import { emptyUsage } from "../engine/stream.ts";
import { toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";

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
	waitingRunIds?: () => ReadonlySet<string>;
	missingRunMessage(id: string, display: string | undefined): string;
	stopAgent(nodeId: string): boolean;
	steerAgent(nodeId: string, text: string): boolean;
	steerRegistry: Map<string, unknown>;
	stopRequested: Set<string>;
	drainBusBlock(): string;
	scanForSurrender(text: string): string | undefined;
	get disposed(): boolean;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
}

/** Keep an aborted wait honest: its signal may end the join well before the configured window. */
export function buildIntercomWaitStillNote(ids: readonly string[], timeoutMs: number, interrupted: boolean): string {
	if (!interrupted) return buildWaitTimeoutNote(ids, timeoutMs);
	const visibleIds = ids.slice(0, MAX_ASYNC_STATUS_ROWS).map((id) => sanitizeDisplayLabel(id, "run"));
	const omitted = ids.length - visibleIds.length;
	const idSummary = `${visibleIds.join(", ")}${omitted > 0 ? `, … +${omitted} more` : ""}`;
	return (
		`⏹ wait interrupted before the configured ${timeoutMs}ms window elapsed; still running: ${idSummary}. ` +
		"Continue useful supervisor work; completion will notify you automatically. Use intercom wait again when ready."
	);
}

/** Fence only child-authored payloads; missing-message diagnostics remain actionable tool prose. */
export function fenceIntercomToolOutcome(out: IntercomOutcome, action: string, fence: (text: string) => string): string {
	return action === "message" && out.details.ok ? fence(out.text) : fenceIntercomOutcome(out, fence);
}

/** Renderer-local state only. The persisted result, not this cache, owns display identity. */
interface IntercomRenderState {
	target?: { id: string; label: string };
	callText?: Text;
	formatCall?: (target: string) => string;
}

export function registerIntercomTool(pi: ExtensionAPI, d: IntercomToolDeps): void {
	function displayRunTarget(id: string): string {
		const run = d.tracker?.peek(id);
		if (!run) return sanitizeDisplayLabel(id, "run");
		const name = runDisplayName(run);
		// An alias is presentation, never a unique address. Disambiguate collisions without rerouting.
		const collision = d.tracker.list().some((other) => other.id !== id && runDisplayName(other) === name);
		return collision ? `${name} [${sanitizeDisplayLabel(id, "run")}]` : name;
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
				Type.Literal("message"),
				Type.Literal("reply"),
				Type.Literal("send"),
			],
			{
				description:
					"peek = watch async sub-agents · result = retrieve one complete settled result by run id · wait = collect current reports; sync:true joins (default: nonblocking with UI, blocking headless) · steer = soft redirect into one by run id (it may ignore it) · stop = request engine cancellation by run id · message = retrieve one drained bus message by message id · list/inbox/reply/send = coaching messages (needs a coaching persona)",
			},
		),
		to: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "result/steer/stop/peek: the async run id (e.g. 'run-1') · wait: an async run id; omit it to collect all current/pending completions · send: the child handle (from `list`)" })),
		messageId: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "message: the drained bus message id shown by `inbox`" })),
		askId: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "reply: the message id of the child's pending question" })),
		message: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_MESSAGE_CHARS, description: "steer/reply/send: the text to deliver" })),
		sync: Type.Optional(Type.Boolean({ description: "wait: block for runs to settle; defaults to false in interactive/RPC sessions and true in headless sessions" })),
		timeoutMs: Type.Optional(Type.Number({ description: "wait with sync:true: max ms to hold your turn (default 600000; values below 1000 clamp to 1000, values above 600000 clamp to 600000) — on timeout you get what settled + what's still running" })),
	});
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: [
			"See, steer, message, and JOIN your running sub-agents.",
			"`peek` watches what your async sub-agents are doing; `result` retrieves one complete settled",
			"payload by run id; `wait` collects current reports and is nonblocking by default with UI (interactive/RPC); set `sync: true` for an intentional bounded join. Headless defaults to joining; set `sync: false` for a snapshot. Do not automatically wait for all children.",
			"Work independently while children run; when only children remain, end your turn and let completion follow-ups wake you; do not monitor or poll healthy children.",
			"`steer` sends a soft course-correction to one (by run id); in-process async runs can receive it mid-run,",
			"while child-engine (MCP/worktree) async runs receive it as a brokered follow-up. After remaining tools return, Pi can consume steering; arbitrary active tool work is not promised to stop immediately.",
			"`message` retrieves a drained bus message by its message id; `list`/`inbox`/`reply`/`send` exchange coaching messages (a child reaches you via `contact_supervisor`)",
			"and need a `coaching: on` persona.",
		].join(" "),
		parameters: IntercomToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			// `to` comes from model-authored tool arguments. Use the exact value for routing, but never
			// interpolate it into trusted prose without reducing it to compact identifier metadata.
			const displayTarget = params.to === undefined ? undefined : sanitizeDisplayLabel(params.to, "run");
			const targetSnapshot = params.to === undefined ? {} : { runId: params.to, target: displayRunTarget(params.to) };
			// peek + wait + steer + stop are supervisor→child controls over the async d.tracker /
			// steer handles — available to EVERY persona (no dependency on the coaching bus).
			if (params.action === "peek") {
				// No `to` → running legs PLUS any settled-but-not-yet-delivered ones (the settle→deliver
				// gap), so a peek right after a leg finishes shows its result instead of "No async runs".
				const runs = params.to
					? [d.tracker.peek(params.to)].filter((r): r is AsyncRun => !!r)
					: dedupeRunsById([...d.tracker.running(), ...d.completionNotifier.peekPending()]);
				return { content: [{ type: "text", text: buildPeekDigest(runs, { now: Date.now(), stallMs: d.STALL_FLAG_MS, ...(d.waitingRunIds ? { waitingForSupervisor: d.waitingRunIds() } : {}) }) }], details: { action: "peek", ok: true, ...targetSnapshot }, isError: false };
			}
			if (params.action === "result") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom result needs { to: <run id> }." }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				const run = d.tracker.peek(params.to);
				if (!run) {
					return { content: [{ type: "text", text: d.missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "result", ok: false, ...targetSnapshot }), isError: true };
				}
				if (run.status === "running") {
					return {
						content: [{ type: "text", text: `${targetSnapshot.target} is still running. Use intercom peek/wait, or request result after it settles.` }],
						details: failureDetails({ action: "result", ok: false, status: run.status, ...targetSnapshot }),
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
				const billed = d.childUsage.accountMany([{ key: run.id, usage: run.result?.usage ?? emptyUsage() }]);
				d.publishPersonaCost();
				return {
					content: [{ type: "text", text: `${run.id} (${displayRun}) · ${run.status}${took ? ` · ${took}` : ""}${cause}\n${body}` }],
					details: { action: "result", ok: true, status: run.status, ...targetSnapshot },
					isError: false,
					...toolUsageField(billed),
				};
			}
			if (params.action === "wait") {
				// No `to` → wait on running legs AND collect settled legs still queued for follow-up
				// delivery, so a wait in the settle→deliver gap returns their results (not "nothing").
				if (params.to && !d.tracker.peek(params.to)) {
					return { content: [{ type: "text", text: d.missingRunMessage(params.to, displayTarget) }], details: failureDetails({ action: "wait", ok: false, ...targetSnapshot }), isError: true };
				}
				const ids = params.to
					? [params.to]
					: dedupeRunsById([...d.tracker.running(), ...d.completionNotifier.peekPending()]).map((r) => r.id);
				if (ids.length === 0) {
					return { content: [{ type: "text", text: "No async runs to wait for." }], details: { action: "wait", ok: true }, isError: false };
				}
				// Interactive/RPC defaults to a snapshot: waiting inside a tool stalls queued user steering.
				// Headless retains its historical join; callers can override either default with sync.
				if (!(params.sync ?? ctx.hasUI !== true)) {
					const current = ids.map((id) => d.tracker.peek(id)).filter((run): run is AsyncRun => !!run);
					const settled = current.filter((run) => run.status !== "running");
					const still = current.filter((run) => run.status === "running");
					const settledIds = new Set(settled.map((run) => run.id));
					d.completionNotifier.discard((run) => settledIds.has(run.id));
					for (const id of settledIds) d.tracker.markCollected(id);
					const report = settled.length > 0 ? renderCompletion(settled, fenceUntrusted, (t) => d.scanForSurrender(t)) : "";
					const stillIds = still.map((run) => sanitizeDisplayLabel(run.id, "run"));
					const omitted = stillIds.length > MAX_ASYNC_STATUS_ROWS;
					const runningNote = still.length > 0
						? `Background continues; automatic completion will notify you. End your turn when this is the only remaining work. Still running: ${stillIds.slice(0, MAX_ASYNC_STATUS_ROWS).join(", ")}${omitted ? `, … +${stillIds.length - MAX_ASYNC_STATUS_ROWS} more` : ""}.`
						: "";
					const text = boundCompletionSurface([report, runningNote].filter(Boolean).join("\n\n") || "Nothing to report (unknown run ids?).");
					const billed = d.childUsage.accountMany(settled.map((run) => ({ key: run.id, usage: run.result?.usage ?? emptyUsage() })));
					d.publishPersonaCost();
					return {
						content: [{ type: "text", text }],
							details: { action: "wait", ok: true, settled: [...settledIds], running: still.map((run) => run.id), ...targetSnapshot },
						isError: false,
						...toolUsageField(billed),
					};
				}
				// Bounded join: never longer than a child's ask timeout (bus `ask` default 600s),
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
				for (const id of settledIds) d.tracker.markCollected(id);
				const report = settled.length > 0 ? renderCompletion(settled, fenceUntrusted, (t) => d.scanForSurrender(t)) : "";
				const stillNote = still.length > 0
					? buildIntercomWaitStillNote(still.map((r) => r.id), timeoutMs, _signal?.aborted === true)
					: "";
				const joined = [report, stillNote].filter(Boolean).join("\n\n") || "Nothing to report (unknown run ids?).";
				const text = boundCompletionSurface(joined);
				const billed = d.childUsage.accountMany(
					settled.map((r) => ({ key: r.id, usage: r.result?.usage ?? emptyUsage() })),
				);
				d.publishPersonaCost();
				return {
					content: [{ type: "text", text }],
					details: { action: "wait", ok: true, settled: [...settledIds], running: still.map((r) => r.id), ...targetSnapshot },
					isError: false,
					...toolUsageField(billed),
				};
			}
			if (params.action === "steer") {
				if (!params.to || params.message === undefined) {
					return { content: [{ type: "text", text: "intercom steer needs { to: <run id>, message }." }], details: failureDetails({ action: "steer", ok: false }), isError: true };
				}
				const nodeId = `async:${params.to}`;
				const knownRun = d.tracker.peek(params.to);
				if (knownRun && knownRun.status !== "running") {
					return {
						content: [{ type: "text", text: `Cannot steer "${targetSnapshot.target}" — this run is already settled (${knownRun.status}). Use intercom result with to="${displayTarget}" to inspect its retained result.` }],
						details: failureDetails({ action: "steer", ok: false, status: knownRun.status, ...targetSnapshot }),
						isError: true,
					};
				}
				if (!d.steerRegistry.has(nodeId)) {
					return {
						content: [{ type: "text", text: `Cannot steer "${targetSnapshot.target}" — no live steer handle is available (the run may not have started yet, or its engine/broker does not expose steering).` }],
						details: failureDetails({ action: "steer", ok: false, ...targetSnapshot }),
						isError: true,
					};
				}
				// Routed through the guarded d.steerAgent so a just-finished/d.disposed handle can't throw.
				const steered = d.steerAgent(nodeId, params.message);
				return steered
					? { content: [{ type: "text", text: `Steering queued for ${targetSnapshot.target} (${displayTarget}).` }], details: { action: "steer", ok: true, ...targetSnapshot, message: params.message }, isError: false }
					: { content: [{ type: "text", text: `Could not steer "${targetSnapshot.target}" — it may have just finished, or the message was empty.` }], details: failureDetails({ action: "steer", ok: false, ...targetSnapshot }), isError: true };
			}
			if (params.action === "stop") {
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom stop needs { to: <run id> }." }], details: failureDetails({ action: "stop", ok: false }), isError: true };
				}
				// Abort the real run signal. The child backend can kill its process tree; the
				// in-process backend requests host cancellation and settles its lifecycle separately.
				const nodeId = `async:${params.to}`;
				const repeated = d.stopRequested.has(nodeId);
				const stopped = d.stopAgent(nodeId);
				if (stopped && !repeated) {
					return { content: [{ type: "text", text: `Cancellation requested for ${targetSnapshot.target}. Check its terminal result; changes already made are not undone.` }], details: { action: "stop", ok: true, ...targetSnapshot }, isError: false };
				}
				// A repeated stop has just invoked the REAL cancel handle again. Only now force-clear
				// d.tracker state if engine settlement is still lagging; the handle remains registered
				// until onComplete so cancellation can never be replaced by UI-only bookkeeping.
				if (stopped && repeated && d.tracker.forceSettle(params.to, "force-stopped by supervisor after repeated engine cancellation")) {
					return {
						content: [{ type: "text", text: `Force-cleared ${targetSnapshot.target} after repeating the engine cancellation; it will no longer be tracked as running.` }],
						details: { action: "stop", ok: true, ...targetSnapshot },
						isError: false,
					};
				}
				return {
					content: [{ type: "text", text: `Cannot stop "${targetSnapshot.target}" — no such running run (it already finished).` }],
					details: failureDetails({ action: "stop", ok: false, ...targetSnapshot }),
					isError: true,
				};
			}

			// The message bus (coaching): list / inbox / message / reply / send.
			const out = runIntercom(params as IntercomParams, d.bus, d.SUPERVISOR);
			// An answered ask is settled on every surface it reached — never woken again, never
			// re-listed (the ask envelope is NOT drained by the peek path, which skips expectsReply).
			if (params.action === "reply" && out.details.ok && params.askId) {
				reconcileAnsweredAsk(params.askId, d.intercomNotifier, d.bus, d.SUPERVISOR);
			}
			// Child-authored inbox bodies are untrusted, exactly like the d.drainBusBlock/peek copies.
			// A retrieved body is child-authored even though it is no longer an inbox batch; keep the
			// same trust fence around it as inbox and automatic drain surfaces.
			let text = fenceIntercomToolOutcome(out, params.action, fenceUntrusted);
			if ((params.action === "list" || params.action === "inbox") && !d.controller.activePersona?.coaching) {
				text += `\n\n${coachingDisabledHint(d.controller.activePersona?.name)}`;
			}
			return { content: [{ type: "text", text }], details: out.details.ok ? out.details : failureDetails(out.details), isError: !out.details.ok };
		},
		renderCall(args, theme, context) {
			const state = context?.state as IntercomRenderState | undefined;
			const action = compactInlineText(args.action ?? "?", { maxChars: 24 }) || "?";
			let target = "";
			const runTarget = typeof args.to === "string"
				? state?.target?.id === args.to ? state.target.label : displayRunTarget(args.to)
				: undefined;
			if (action === "wait" || action === "peek") target = runTarget ?? "all";
			else if (["result", "steer", "stop"].includes(action)) target = runTarget ?? "?";
			else if (action === "send") target = compactInlineText(args.to ?? "?", { maxChars: 80 }) || "?";
			else if (action === "message") target = compactInlineText(args.messageId ?? "?", { maxChars: 80 }) || "?";
			else if (action === "reply") target = compactInlineText(args.askId ?? "?", { maxChars: 80 }) || "?";
			const timeout = action === "wait" && Number.isFinite(args.timeoutMs) && args.timeoutMs !== undefined
				? ` · ${Math.max(0, Math.floor(args.timeoutMs))}ms`
				: "";
			const formatCall = (label: string) => `${theme.fg("toolTitle", theme.bold("intercom "))}${theme.fg("accent", action)}${label ? theme.fg("dim", ` ${compactInlineText(label, { maxChars: 80 })}${timeout}`) : ""}`;
			const component = new Text(formatCall(target), 0, 0);
			if (state) { state.callText = component; state.formatCall = formatCall; }
			return component;
		},
		renderResult(result, { expanded }, theme, context) {
			const details = (result.details ?? {}) as { action?: string; ok?: boolean; runId?: string; target?: string; message?: string };
			const state = context?.state as IntercomRenderState | undefined;
			const action = details.action ?? context?.args?.action;
			const savedId = details.runId ?? context?.args?.to;
			const legacyCompleted = !details.target && context !== undefined && context.isPartial !== true
				&& ["steer", "stop", "result", "peek", "wait"].includes(action ?? "");
			if (state && typeof savedId === "string" && (details.target || legacyCompleted)) {
				// Old receipts have no display snapshot. A new session may reuse their run ID;
				// the current tracker cannot supply a historical alias for that unrelated execution.
				state.target = { id: savedId, label: details.target ? compactInlineText(details.target, { maxChars: 80 }) : sanitizeDisplayLabel(savedId, "run") };
				// Pi renders the call before the result. Update that same Text rather than causing a
				// recursive invalidation, so restored history uses its saved alias on its first frame.
				if (state.callText && state.formatCall) state.callText.setText(state.formatCall(state.target.label));
			}
			const first = result.content[0];
			const full = sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)");
			const failed = details.ok === false;
			const prefix = failed ? `${theme.fg("error", theme.bold("failed"))}\n` : "";
			if (details.action === "steer" && details.ok === true) {
				const target = compactInlineText(details.target ?? state?.target?.label ?? (legacyCompleted && typeof savedId === "string" ? sanitizeDisplayLabel(savedId, "run") : details.runId ? displayRunTarget(details.runId) : ""), { maxChars: 80 });
				const message = typeof details.message === "string" ? details.message : context?.args?.message;
				// Old persisted receipts may predate message snapshots. Keep their original content
				// available in expansion rather than fabricating a message that was never recorded.
				if (expanded) {
					const text = typeof message === "string"
						? `Steering queued${target ? ` for ${target}` : ""}.${details.runId ? `\nRun: ${sanitizeDisplayLabel(details.runId, "run")}` : ""}\n\n${sanitizeTerminalText(message)}`
						: full;
					return new Text(theme.fg("toolOutput", text), 0, 0);
				}
				const title = compactInlineText(`steering queued${target ? ` · ${target}` : ""}`, { maxChars: 100 });
				const preview = typeof message === "string" ? compactVisibleText(message, { maxLines: 3, maxLineChars: 100 }) : undefined;
				// Native Pi already rendered `intercom steer <alias>` above this result. Show the
				// instruction directly there; only standalone/older renderers need another identity row.
				const showTitle = !state?.callText || !preview;
				return new Text(`${showTitle ? theme.fg("success", title) : ""}${preview ? `${showTitle ? "\n" : ""}${theme.fg("toolOutput", preview.text)}${preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : ""}` : ""}`, 0, 0);
			}
			if (expanded) return new Text(`${prefix}${theme.fg("toolOutput", full)}`, 0, 0);
			const preview = compactVisibleText(full, { maxLines: 4, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${prefix}${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
	});
}

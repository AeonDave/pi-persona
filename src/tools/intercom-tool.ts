/** `intercom` tool registration. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failureDetails } from "../extension/shared.ts";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";
import { createReportBody } from "../ui/report-body.ts";
import { coachingDisabledHint, expandDetailHint, reconcileAnsweredAsk } from "../extension/shared.ts";
import {
	type AsyncRun, AsyncRunTracker, buildPeekDigest,
	dedupeRunsById, getFullRunOutput, IdleCoalescingNotifier,
	isAsyncRunStalled, observedRunModel, runDisplayName, runDurationLabel,
} from "../engine/async.ts";
import type { PollGuard } from "../core/nudge.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { sanitizeDisplayLabel } from "../core/display-label.ts";
import { type IntercomOutcome, type IntercomParams, MAX_INTERCOM_MESSAGE_CHARS, MAX_INTERCOM_REF_CHARS, runIntercom } from "./intercom.ts";
import { fenceIntercomOutcome, type PendingAsk } from "../extension/shared.ts";
import type { InProcessBus } from "../bus/inproc.ts";
import type { PersonaController } from "../persona/controller.ts";
import { emptyUsage } from "../engine/stream.ts";
import { toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";
import type { TerminalResultArchive } from "../results/archive.ts";
import { pageLiveResult, projectResultPage, resultReceiptHint } from "../results/retrieval.ts";

export interface IntercomToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	tracker: AsyncRunTracker;
	archive(ctx: ExtensionContext): TerminalResultArchive;
	completionNotifier: IdleCoalescingNotifier<AsyncRun>;
	intercomNotifier: IdleCoalescingNotifier<PendingAsk>;
	controller: PersonaController;
	bus: InProcessBus;
	SUPERVISOR: string;
	STALL_FLAG_MS: number;
	waitingRunIds?: () => ReadonlySet<string>;
	/** Refuses an unchanged repeat of peek/result on a running run. Built only when `config.nudge`. */
	pollGuard?: PollGuard | undefined;
	missingRunMessage(id: string, display: string | undefined): string;
	stopAgent(nodeId: string): boolean;
	steerAgent(nodeId: string, text: string): boolean;
	steerRegistry: Map<string, unknown>;
	stopRequested: Set<string>;
	/** The premature-surrender note for a settled report (config-gated), else undefined. */
	scanForSurrender(text: string): string | undefined;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
}

/** Fence only child-authored payloads; missing-message diagnostics remain actionable tool prose. */
export function fenceIntercomToolOutcome(out: IntercomOutcome, action: string, fence: (text: string) => string): string {
	return action === "message" && out.details.ok ? fence(out.text) : fenceIntercomOutcome(out, fence);
}

/** `run-4 (alpha · haiku) running, run-3 (scout) done, … (+2 more)` — the one bounded run listing
 *  every id-to-call-sign teaching surface shares (a run miss, a bulk stop). `none` when empty. */
export function describeRuns(runs: readonly AsyncRun[], opts: { status?: boolean; max?: number } = {}): string {
	if (runs.length === 0) return "none";
	const max = opts.max ?? 8;
	const shown = runs.slice(0, max).map((run) => `${run.id} (${runDisplayName(run)})${opts.status ? ` ${run.status}` : ""}`);
	return `${shown.join(", ")}${runs.length > max ? `, … (+${runs.length - max} more)` : ""}`;
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
	/** An id the tracker holds nothing for: teach what exists (and why a stale id dead-ends) instead of
	 *  letting steer/stop fall through to a false "already finished" or "no live steer handle". */
	function missingRun(action: "result" | "steer" | "stop", to: string, display: string | undefined, snapshot: object) {
		return { content: [{ type: "text" as const, text: d.missingRunMessage(to, display) }], details: failureDetails({ action, ok: false, ...snapshot }), isError: true };
	}
	/** `stop { to: "all" }`: request cancellation of every running run, each with the per-run semantics of a
	 *  single stop — except that a run already stopping is reported, never force-cleared, in bulk. */
	function stopAllRuns() {
		const snapshot = { runId: "all", target: "all" };
		const requested: AsyncRun[] = [];
		const already: AsyncRun[] = [];
		const unreachable: AsyncRun[] = [];
		for (const run of d.tracker.running()) {
			const nodeId = `async:${run.id}`;
			if (d.stopRequested.has(nodeId)) already.push(run);
			else (d.stopAgent(nodeId) ? requested : unreachable).push(run);
		}
		const noHandle = unreachable.length > 0 ? `No live stop handle: ${describeRuns(unreachable)}.` : "";
		if (requested.length === 0 && already.length === 0) {
			return { content: [{ type: "text" as const, text: noHandle || "intercom stop: no running runs to stop." }], details: failureDetails({ action: "stop", ok: false, ...snapshot }), isError: true };
		}
		if (requested.length > 0) d.pollGuard?.reset();
		const parts = [
			...(requested.length > 0 ? [`Cancellation requested for ${requested.length} run${requested.length === 1 ? "" : "s"}: ${describeRuns(requested)}. Stopped reports arrive as completion follow-ups; partial output is kept; changes already made are not undone.`] : []),
			...(already.length > 0 ? [`Already stopping: ${describeRuns(already)}.${requested.length === 0 ? " Repeat stop { to: <run id> } on one that stays running to force-clear it." : ""}`] : []),
			...(noHandle ? [noHandle] : []),
		];
		return { content: [{ type: "text" as const, text: parts.join(" ") }], details: { action: "stop", ok: true, ...snapshot }, isError: false };
	}
	/**
	 * An unchanged repeat of a status check learns nothing and holds the turn the idle-gated completion
	 * wake needs: refuse it, and on the second repeat end the turn. The signature is every shown run's
	 * state (status, queued, waiting, stalled), so anything newly informative passes.
	 */
	function pollRefusal(action: "peek" | "result", scope: string, runs: readonly AsyncRun[], waiting: ReadonlySet<string> | undefined, snapshot: object) {
		const running = runs.filter((r) => r.status === "running");
		if (!d.pollGuard || running.length === 0) return undefined;
		const now = Date.now();
		const sig = runs.map((r) => [r.id, r.status, r.queued === true, waiting?.has(r.id) === true, isAsyncRunStalled(r, now, d.STALL_FLAG_MS)].join("|")).sort().join(",");
		const verdict = d.pollGuard.check(scope, sig);
		if (verdict === "ok") return undefined;
		const text = `intercom ${action}: no run settled, started, queued, began waiting or stalled since your last ${action} (${running.map((r) => r.id).join(", ")} still running). Checking again blocks your own completion follow-ups and the operator's steering — end your turn; a finished run or batch wakes you. Use steer or stop only to intervene.`;
		return {
			content: [{ type: "text" as const, text }],
			details: failureDetails({ action, ok: false, ...snapshot }),
			isError: true,
			...(verdict === "terminate" ? { terminate: true } : {}),
		};
	}
	// ── intercom tool (supervisor side of the comm plane: read/answer children) ───
	const IntercomToolParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("peek"),
				Type.Literal("result"),
				Type.Literal("results"),
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
					"peek = status of async sub-agents · results = bounded archive summaries (cursor/limit) · result = page a settled live result by to:run-id or a saved report by ref:result-UUID · steer = soft redirect into one by run id (it may ignore it) · stop = request engine cancellation by run id · message = retrieve one drained bus message by message id · list/inbox/reply/send = coaching messages (needs a coaching persona)",
			},
		),
		to: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "result/steer/stop/peek: the async run id (e.g. 'run-1'); stop: \"all\" cancels every running run · send: the child handle (from `list`)" })),
		ref: Type.Optional(Type.String({ maxLength: 43, description: "result: opaque result:<UUID> archive reference; never a run id. Mutually exclusive with to." })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "result: stored-body UTF-16 offset (default 0); use nextOffset, never split a surrogate pair." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: "result: 2..16000 UTF-16 units (default 8000). results: 1..50 summaries (default 20)." })),
		cursor: Type.Optional(Type.Integer({ minimum: 0, description: "results: nextCursor from the prior bounded summary page; omit for the first page." })),
		collect: Type.Optional(Type.Boolean({ description: "result with live to only: true acknowledges the whole report and suppresses its pending completion. Paging alone does not collect." })),
		messageId: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "message: the drained bus message id shown by `inbox`" })),
		askId: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_REF_CHARS, description: "reply: the message id of the child's pending question" })),
		message: Type.Optional(Type.String({ maxLength: MAX_INTERCOM_MESSAGE_CHARS, description: "steer/reply/send: the text to deliver" })),
	});
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: [
			"Steer, stop and inspect your background sub-agents; a finished run or batch wakes you with a completion follow-up.",
			"Never `peek` healthy children; use it only for status you need. `result { to: runId }` pages a live settled payload by run id (8000 units default, 16000 maximum).",
			"`results { cursor?, limit? }` lists saved terminal summaries across this session's branches (20 default, 50 maximum); pass nextCursor for the next page.",
			"`result { ref: 'result:<UUID>', offset?, limit? }` reads a saved report, including after reload, without collecting, billing, restarting a worker or waking the model. Memory-only references last only for this activation. Run ids route only the current runtime; never guess a historical run by id.",
			"Use nextOffset for more UTF-16 pages. Only a whole live body returned in one read, or explicit live collect:true, suppresses a pending completion. Archive ref reads reject collect.",
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
			// peek + result + steer + stop are supervisor→child controls over the async tracker /
			// steer handles — available to EVERY persona (no dependency on the coaching bus).
			if (params.action === "peek") {
				// No `to` → running legs PLUS any settled-but-not-yet-delivered ones (the settle→deliver
				// gap), so a peek right after a leg finishes shows its result instead of "No async runs".
				const runs = params.to
					? [d.tracker.peek(params.to)].filter((r): r is AsyncRun => !!r)
					: dedupeRunsById([...d.tracker.running(), ...d.completionNotifier.peekPending()]);
				const waiting = d.waitingRunIds?.();
				const refusal = pollRefusal("peek", params.to ?? "*", runs, waiting, targetSnapshot);
				if (refusal) return refusal;
				return { content: [{ type: "text", text: buildPeekDigest(runs, { now: Date.now(), stallMs: d.STALL_FLAG_MS, ...(waiting ? { waitingForSupervisor: waiting } : {}) }) }], details: { action: "peek", ok: true, ...targetSnapshot }, isError: false };
			}
			if (params.action === "results" || (params.action === "result" && params.ref !== undefined)) {
				const invalid = params.to !== undefined || params.collect !== undefined || (params.action === "results" && (params.ref !== undefined || params.offset !== undefined)) || (params.action === "result" && params.cursor !== undefined);
				if (invalid) return { content: [{ type: "text", text: "Archive reads accept ref/offset/limit; results accepts cursor/limit. to and collect are live-only." }], details: failureDetails({ action: params.action }), isError: true };
				const archive = d.archive(ctx);
				if (params.action === "results") {
					const page = archive.list({ ...(params.cursor !== undefined ? { cursor: params.cursor } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) });
					const text = page.ok ? ["Saved terminal reports (not live workers):", ...page.results.map((r) => `${r.ref} · ${sanitizeDisplayLabel(r.label ?? r.agent)} · ${r.status} · ${r.storage}${r.truncated ? " · truncated" : ""}`), ...(page.nextCursor !== undefined ? [`nextCursor: ${page.nextCursor}`] : []), ...(page.warnings.length ? [`Storage warnings: ${page.warnings.join(", ")}`] : [])].join("\n") : page.message;
					return { content: [{ type: "text", text }], details: { action: "results", ...page }, isError: !page.ok };
				}
				const page = archive.read({ ref: params.ref!, ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) });
				if (!page.ok) {
					return { content: [{ type: "text", text: page.message }], details: { action: "result", ...page }, isError: true };
				}
				// Bounded-page rule: the fenced body is delivered once, in content; details stay
				// bounded metadata exactly like the live result path (no whole page hidden there).
				const { body: _pageBody, ...pageMeta } = page;
				return {
					content: [{ type: "text", text: `${page.summary.ref} · ${page.summary.status} · ${page.summary.storage}${page.summary.truncated ? " · saved body truncated" : ""}\n${projectResultPage(page, page.summary.error)}` }],
					details: { action: "result", ...pageMeta }, isError: false,
				};
			}
			if (params.action === "result") {
				if (!params.to || params.cursor !== undefined) {
					return { content: [{ type: "text", text: "intercom result needs { to: <run id> }." }], details: failureDetails({ action: "result", ok: false }), isError: true };
				}
				const run = d.tracker.peek(params.to);
				if (!run) return missingRun("result", params.to, displayTarget, targetSnapshot);
				if (run.status === "running") {
					const refusal = pollRefusal("result", `result:${params.to}`, [run], d.waitingRunIds?.(), targetSnapshot);
					if (refusal) return refusal;
					return {
						content: [{ type: "text", text: `${targetSnapshot.target} is still running; a finished run or batch wakes you with a completion follow-up. End your turn if nothing else remains.` }],
						details: failureDetails({ action: "result", ok: false, status: run.status, ...targetSnapshot }),
						isError: true,
					};
				}
				// Explicit collection owns this delivery: remove a still-buffered passive completion so the
				// same result cannot appear again as a follow-up a moment later. Telling the tracker too
				// makes this retained copy the first thing retention evicts — the supervisor has read it,
				// so it is the cheapest payload in the map to lose.
				const full = getFullRunOutput(run);
				const page = pageLiveResult(full, params.offset, params.limit);
				if (!page) return { content: [{ type: "text", text: "Invalid result offset/limit; use nextOffset and 2..16000 units." }], details: failureDetails({ action: "result", ...targetSnapshot }), isError: true };
				if (params.collect === true || (page.offset === 0 && page.endOfStoredBody)) {
					d.completionNotifier.discard((pending) => pending.id === run.id);
					d.tracker.markCollected(run.id);
				}
				const body = projectResultPage(page, run.error);
				const receipt = resultReceiptHint(run.resultReceipt);
				const displayRun = runDisplayName(run);
				const modelUsed = observedRunModel(run);
				// The wall time this leg took: an explicit collection is one of the paths a completion reaches
				// the supervisor through, so it carries the same reading the passive completion report does.
				const took = runDurationLabel(run);
				// The follow-up discarded above is what would have carried the premature-surrender note, so
				// a collected DONE report must carry it itself (a failed leg is already a failure report).
				const note = run.status === "done" ? d.scanForSurrender(full) : undefined;
				const billed = d.childUsage.accountMany([{ key: run.id, usage: run.result?.usage ?? emptyUsage() }]);
				d.publishPersonaCost();
				return {
					content: [{ type: "text", text: `${run.id} (${displayRun}) · ${run.status}${took ? ` · ${took}` : ""}${modelUsed ? `\nObserved model: ${modelUsed}` : ""}\n${body}${receipt ? `\n${receipt}` : ""}${note ? `\n\n${note}` : ""}` }],
					details: { action: "result", ok: true, status: run.status, ...targetSnapshot, ...(modelUsed ? { modelUsed } : {}), page: { offset: page.offset, nextOffset: page.nextOffset, endOfStoredBody: page.endOfStoredBody }, ...(run.resultReceipt ? { resultReceipt: { ...run.resultReceipt } } : {}) },
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
				if (!knownRun) return missingRun("steer", params.to, displayTarget, targetSnapshot);
				if (knownRun.status !== "running") {
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
				// Routed through the guarded steerAgent so a just-finished/disposed handle can't throw.
				const steered = d.steerAgent(nodeId, params.message);
				// An intervention changes the child's state without moving any flag the guard compares.
				if (steered) d.pollGuard?.reset();
				return steered
					? { content: [{ type: "text", text: `Steering queued for ${targetSnapshot.target} (${displayTarget}).` }], details: { action: "steer", ok: true, ...targetSnapshot, message: params.message }, isError: false }
					: { content: [{ type: "text", text: `Could not steer "${targetSnapshot.target}" — it may have just finished, or the message was empty.` }], details: failureDetails({ action: "steer", ok: false, ...targetSnapshot }), isError: true };
			}
			if (params.action === "stop") {
				if (params.to === "all") return stopAllRuns();
				if (!params.to) {
					return { content: [{ type: "text", text: "intercom stop needs { to: <run id> }." }], details: failureDetails({ action: "stop", ok: false }), isError: true };
				}
				if (!d.tracker.peek(params.to)) return missingRun("stop", params.to, displayTarget, targetSnapshot);
				// Abort the real run signal. The child backend can kill its process tree; the
				// in-process backend requests host cancellation and settles its lifecycle separately.
				const nodeId = `async:${params.to}`;
				const repeated = d.stopRequested.has(nodeId);
				const stopped = d.stopAgent(nodeId);
				if (stopped) d.pollGuard?.reset();
				if (stopped && !repeated) {
					return { content: [{ type: "text", text: `Cancellation requested for ${targetSnapshot.target}; its stopped report arrives with the completion follow-up (its batch's, if it has one). Changes already made are not undone.` }], details: { action: "stop", ok: true, ...targetSnapshot }, isError: false };
				}
				// A repeated stop has just invoked the REAL cancel handle again. Only now force-clear
				// tracker state if engine settlement is still lagging; the handle remains registered
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
			// Child-authored inbox bodies are untrusted, exactly like the automatic drain and peek copies.
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
			if (action === "peek") target = runTarget ?? "all";
			else if (["result", "steer", "stop"].includes(action)) target = runTarget ?? "?";
			else if (action === "send") target = compactInlineText(args.to ?? "?", { maxChars: 80 }) || "?";
			else if (action === "message") target = compactInlineText(args.messageId ?? "?", { maxChars: 80 }) || "?";
			else if (action === "reply") target = compactInlineText(args.askId ?? "?", { maxChars: 80 }) || "?";
			const formatCall = (label: string) => `${theme.fg("toolTitle", theme.bold("intercom "))}${theme.fg("accent", action)}${label ? theme.fg("dim", ` ${compactInlineText(label, { maxChars: 80 })}`) : ""}`;
			const component = new Text(formatCall(target), 0, 0);
			if (state) { state.callText = component; state.formatCall = formatCall; }
			return component;
		},
		renderResult(result, { expanded }, theme, context) {
			const details = (result.details ?? {}) as {
				action?: string; ok?: boolean; runId?: string; target?: string; message?: string;
				results?: Array<{ truncated?: boolean }>;
				summary?: { ref?: string; storage?: string; storedChars?: number; truncated?: boolean };
				nextCursor?: number; nextOffset?: number; warnings?: readonly string[];
			};
			const state = context?.state as IntercomRenderState | undefined;
			const action = details.action ?? context?.args?.action;
			const savedId = details.runId ?? context?.args?.to;
			const legacyCompleted = !details.target && context !== undefined && context.isPartial !== true
				&& ["steer", "stop", "result", "peek"].includes(action ?? "");
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
			const failed = (context?.isError ?? result.isError) || details.ok === false;
			const prefix = failed ? `${theme.fg("error", theme.bold("failed"))}\n` : "";
			if (!failed && details.action === "steer" && details.ok === true) {
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
			// Archive views are listings/diagnostics, never Markdown reports. A successful archive
			// read carries no runId (live results do) and a summary (its own receipt); the invalid
			// argument mix and failed reads fall through to the literal failure rendering below.
			const listing = details.action === "results" && details.ok === true && Array.isArray(details.results) ? details.results : undefined;
			const archivedPage = details.action === "result" && details.ok === true
				&& typeof details.summary === "object" && details.summary !== null && details.runId === undefined
				? details.summary
				: undefined;
			if (expanded) {
				// Archive pages/listings stay literal via the shared renderer — complete sanitized
				// content, no Markdown re-render of a quote-fenced page or a ref listing.
				if (!failed && (listing || archivedPage)) {
					return renderLiteralToolResult(result, { expanded }, theme, context);
				}
				// Explicit report/message actions only; missing/running diagnostics and control
				// receipts remain literal. Older history with no action is not guessed from prose.
				if (!failed && ["result", "message", "inbox"].includes(action ?? "")) {
					return createReportBody(full, theme, {}, context?.lastComponent);
				}
				return new Text(`${prefix}${theme.fg("toolOutput", full)}`, 0, 0);
			}
			if (!failed && listing) {
				// Purpose line first (count + paging/truncation/storage honesty), then a bounded
				// listing preview; the payload's own header line is replaced by the purpose line.
				const truncated = listing.filter((entry) => entry?.truncated === true).length;
				const flags = [
					...(details.nextCursor !== undefined ? [`next page: cursor ${details.nextCursor}`] : []),
					...(truncated > 0 ? [`${truncated} truncated`] : []),
					...(details.warnings?.length ? [`warnings: ${details.warnings.join(", ")}`] : []),
				];
				const purpose = compactInlineText(`results · ${listing.length} retained${flags.length ? ` · ${flags.join(" · ")}` : ""}`, { maxChars: 100 });
				const preview = compactVisibleText(full.split("\n").slice(1).join("\n"), { maxLines: 3, maxLineChars: 100 });
				return new Text(`${theme.fg("success", purpose)}\n${theme.fg("toolOutput", preview.text)}${preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : ""}`, 0, 0);
			}
			if (!failed && archivedPage) {
				// Page position reads against the STORED body (originals may be truncated); honesty
				// flags surface collapsed so a memory-only or truncated receipt is never mistaken
				// for a durable whole report without expanding.
				const end = details.nextOffset ?? archivedPage.storedChars ?? 0;
				const flags = [
					...(archivedPage.truncated ? ["truncated"] : []),
					...(archivedPage.storage === "memory-only" ? ["memory-only"] : []),
					...(details.warnings?.length ? [`warnings: ${details.warnings.join(", ")}`] : []),
				];
				const purpose = compactInlineText(`result · ${archivedPage.ref ?? "?"} · page ${end}/${archivedPage.storedChars ?? "?"}${flags.length ? ` · ${flags.join(" · ")}` : ""}`, { maxChars: 100 });
				// The payload's receipt header and paging diagnostic line are replaced by the purpose
				// line; the fence wrapper is dropped by the preview, leaving the page body quoted.
				const preview = compactVisibleText(full.split("\n").slice(2).join("\n"), { maxLines: 3, maxLineChars: 100 });
				return new Text(`${theme.fg("success", purpose)}\n${theme.fg("toolOutput", preview.text)}${preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : ""}`, 0, 0);
			}
			const preview = compactVisibleText(full, { maxLines: 4, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${prefix}${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
	});
}

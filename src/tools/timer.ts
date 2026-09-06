/** Session timer tool — arm a wall-clock wake. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failureDetails } from "../extension/shared.ts";
import { formatRemaining, type TimerScheduler } from "../core/timer.ts";
import { parseInstant } from "../core/time.ts";
import { readClockSnapshot } from "../extension/clock.ts";

export interface TimerToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	timerScheduler: TimerScheduler;
}

export function registerTimerTool(pi: ExtensionAPI, d: TimerToolDeps): void {
	// ── timer tool (arm a wall-clock alarm that WAKES the session when it fires) ───
	// Solves the "wait N minutes for a scheduled event or service window" problem WITHOUT a poll loop:
	// arm an alarm, end your turn, and when it expires the extension injects a follow-up that
	// resumes you (idle-gated so it starts a fresh turn instead of stranding). Up to 32 alarms may be
	// armed; cancel/list them. In-memory per session (a reload/new session clears armed alarms).
	const TimerToolParams = Type.Object({
		action: Type.Union([Type.Literal("arm"), Type.Literal("cancel"), Type.Literal("list"), Type.Literal("now")], {
			description: "arm = schedule a wakeup · cancel = drop one by id · list = show armed alarms · now = read the fresh clock",
		}),
		message: Type.Optional(
			Type.String({ description: "arm: the follow-up injected into the session when the timer fires (what to do on wake, e.g. 'check the status and summarize changes'). Required for arm." }),
		),
		delaySeconds: Type.Optional(Type.Number({ description: "arm: fire this many seconds from now. Give this OR atIso, not both." })),
		atIso: Type.Optional(Type.String({ description: "arm: fire at this absolute ISO-8601 instant (date-time must include Z or a numeric timezone offset, e.g. '2026-07-11T19:00:00Z'). Give this OR delaySeconds, not both." })),
		label: Type.Optional(Type.String({ description: "arm: a short human label for the alarm (e.g. 'status review')." })),
		id: Type.Optional(Type.String({ description: "cancel: the timer id to cancel (e.g. 'timer-1')." })),
	});
	pi.registerTool({
		name: "timer",
		label: "Timer",
		description: [
			"Arm a wall-clock ALARM that wakes you when it fires — the token-cheap way to wait for a",
			"fixed moment (a scheduled event, a service window, a scheduled re-check) instead of a",
			"poll loop. `arm` with { message, delaySeconds } or { message, atIso }; end your turn; when",
			"it expires a follow-up carrying your message is injected and you resume. `cancel` by id,",
			"`list` the armed ones. Up to 32 alarms may be armed at once. The session must remain open;",
			"alarms are in-memory and cleared on shutdown or reload. `now` returns a fresh UTC time plus",
			"the local timezone and numeric offset.",
		].join(" "),
		parameters: TimerToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			if (params.action === "now") {
				const now = d.timerScheduler.now();
				const reading = readClockSnapshot(now);
				if (!reading) {
					return { content: [{ type: "text", text: "timer now is unavailable because the scheduler clock is invalid." }], details: failureDetails({ action: "now", ok: false }), isError: true };
				}
				return { content: [{ type: "text", text: reading }], details: { action: "now", ok: true }, isError: false };
			}
			if (params.action === "list") {
				const timers = d.timerScheduler.list();
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
				const cancelled = d.timerScheduler.cancel(params.id);
				return cancelled
					? { content: [{ type: "text", text: `Cancelled ${params.id}.` }], details: { action: "cancel", ok: true }, isError: false }
					: { content: [{ type: "text", text: `No armed timer with id "${params.id}" (it may have already fired or been cancelled).` }], details: failureDetails({ action: "cancel", ok: false }), isError: true };
			}
			// action === "arm"
			const message = params.message?.trim() ?? "";
			if (!message) {
				return { content: [{ type: "text", text: "timer arm needs { message } — the follow-up text injected on wake." }], details: failureDetails({ action: "arm", ok: false }), isError: true };
			}
			if (params.delaySeconds === undefined && params.atIso === undefined) {
				return { content: [{ type: "text", text: "timer arm needs { delaySeconds } or { atIso }, not neither." }], details: failureDetails({ action: "arm", ok: false }), isError: true };
			}
			if (params.delaySeconds !== undefined && params.atIso !== undefined) {
				return { content: [{ type: "text", text: "timer arm needs { delaySeconds } or { atIso }, not both." }], details: failureDetails({ action: "arm", ok: false }), isError: true };
			}
			const arm: { message: string; label?: string; delayMs?: number; atEpochMs?: number } = { message };
			if (params.label !== undefined) arm.label = params.label;
			if (params.atIso !== undefined) {
				const at = parseInstant(params.atIso);
				if (!Number.isFinite(at)) {
					return { content: [{ type: "text", text: `timer atIso "${params.atIso}" is not a valid unambiguous ISO-8601 time; date-times must include Z or a numeric timezone offset.` }], details: failureDetails({ action: "arm", ok: false }), isError: true };
				}
				arm.atEpochMs = at;
			}
			if (params.delaySeconds !== undefined) arm.delayMs = Math.round(params.delaySeconds * 1000);
			const r = d.timerScheduler.arm(arm);
			if (!r.ok || !r.entry) {
				return { content: [{ type: "text", text: r.error ?? "timer arm failed." }], details: failureDetails({ action: "arm", ok: false }), isError: true };
			}
			const e = r.entry;
			const text = `Armed ${e.id} (${e.label}) — fires in ${formatRemaining(r.remainingMs ?? e.fireAtEpochMs - e.armedAtEpochMs)} [${new Date(e.fireAtEpochMs).toISOString()}]. On fire I'll be woken with: "${e.message}". You can end this turn now; keep the session open for the alarm.`;
			return { content: [{ type: "text", text }], details: { action: "arm", id: e.id, fireAtEpochMs: e.fireAtEpochMs, ok: true }, isError: false };
		},
	});
}

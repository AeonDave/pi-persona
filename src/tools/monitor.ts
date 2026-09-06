/** Background event sources: one executable, explicit argv, bounded session lifetime. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { MonitorManager } from "../core/monitor.ts";
import { failureDetails } from "../extension/shared.ts";
import { compactInlineText } from "../ui/presentation.ts";

export interface MonitorToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	canRun(): boolean;
	monitors: Pick<MonitorManager, "arm" | "list" | "cancel">;
}

export function registerMonitorTool(pi: ExtensionAPI, d: MonitorToolDeps): void {
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Watch a job, file, log or system event using a background program. arm starts command (an executable) with args in the current workspace; no implicit shell. mode=output wakes on nonempty stdout lines; write an adapter that prints only relevant changes. mode=exit wakes once when the launched job finishes. Returns immediately; continue independent work, then end your turn to receive events automatically. Requires monitor AND bash permission. Default: one event, ten-minute deadline; max eight monitors, twenty events each, twenty-four hours. list shows active watches; cancel stops the owned process tree and queued wakes. Keep this Pi session open; watches stop on session shutdown/reload. Do not wrap delegate or Exocom in a monitor: their notifications are already automatic.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("arm"), Type.Literal("list"), Type.Literal("cancel")]),
			command: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "arm: executable, e.g. node, python or powershell.exe. Use args for script paths and arguments." })),
			args: Type.Optional(Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 64, description: "arm: literal argv. For shell syntax, explicitly launch the appropriate shell and pass a script file." })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "arm: short purpose, e.g. build finished or new application error." })),
			mode: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("exit")], { description: "arm: output for event-producing watchers; exit for job completion. Required." })),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: "arm: lifetime deadline, default 600 seconds. Expiry stops the process and reports a timeout." })),
			maxEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "arm/output: stop after this many distinct event lines, default 1." })),
			id: Type.Optional(Type.String({ minLength: 1, description: "cancel: monitor id returned by arm." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: failureDetails({ ok: false }), isError: true });
			if (params.action === "list") {
				const entries = d.monitors.list();
				return { content: [{ type: "text" as const, text: entries.length ? entries.map((e) => `${e.id} (${compactInlineText(e.label, { maxChars: 120 })}) — ${e.mode}; deadline ${new Date(e.expiresAtEpochMs).toISOString()}`).join("\n") : "No active monitors." }], details: { ok: true, count: entries.length } };
			}
			if (params.action === "cancel") {
				if (typeof params.id !== "string" || !params.id.trim()) return fail("monitor cancel needs { id } from arm or list.");
				const cancelled = d.monitors.cancel(params.id);
				return { content: [{ type: "text" as const, text: cancelled ? `Cancelled ${params.id}; its queued events were removed.` : `No active monitor or queued event for ${params.id}.` }], details: { ok: true, cancelled } };
			}
			if (params.action !== "arm") return fail("monitor action must be arm, list or cancel.");
			if (!d.canRun()) return fail("monitor arm requires both monitor and bash permission for the active persona.");
			if (signal?.aborted) return fail("monitor arm cancelled before launch.");
			if (typeof params.command !== "string" || !params.command.trim() || typeof params.label !== "string" || !params.label.trim()) return fail("monitor arm needs { command, label, mode }.");
			if (params.mode !== "output" && params.mode !== "exit") return fail("monitor arm mode must be output or exit.");
			if (params.args !== undefined && (!Array.isArray(params.args) || !params.args.every((v) => typeof v === "string"))) return fail("monitor args must be an array of literal strings.");
			if (params.timeoutSeconds !== undefined && (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < 1 || params.timeoutSeconds > 86400)) return fail("monitor timeoutSeconds must be between 1 and 86400.");
			if (params.maxEvents !== undefined && (!Number.isInteger(params.maxEvents) || params.maxEvents < 1 || params.maxEvents > 20)) return fail("monitor maxEvents must be an integer between 1 and 20.");
			const result = d.monitors.arm({
				command: params.command, label: params.label, mode: params.mode, cwd: ctx.cwd,
				...(params.args !== undefined ? { args: params.args } : {}),
				...(params.timeoutSeconds !== undefined ? { timeoutMs: Math.round(params.timeoutSeconds * 1000) } : {}),
				...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {}),
			});
			if (!result.ok) return fail(result.error);
			return { content: [{ type: "text" as const, text: `Armed ${result.entry.id} (${compactInlineText(result.entry.label, { maxChars: 120 })}); ${params.mode === "exit" ? "wakes when this job exits" : "wakes on relevant stdout lines"}. Deadline ${new Date(result.entry.expiresAtEpochMs).toISOString()}. Keep this session open. Continue independent work, or end your turn and wait for the automatic notice.` }], details: { ok: true, id: result.entry.id, expiresAtEpochMs: result.entry.expiresAtEpochMs } };
		},
		renderCall(args, theme) {
			const action = compactInlineText(args.action ?? "", { maxChars: 12 });
			const label = compactInlineText(args.label ?? args.id ?? "", { maxChars: 96 });
			return new Text(`${theme.fg("toolTitle", theme.bold(`monitor ${action}`))}${label ? ` ${theme.fg("dim", label)}` : ""}`, 0, 0);
		},
	});
}

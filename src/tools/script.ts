/** Async one-shot execution. Scripts share bounded process mechanics with monitors,
 * while keeping separate capabilities, identities, history and operator rows. */
import { getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { MonitorArchive } from "../monitor/archive.ts";
import type { ScriptSession } from "../script/session.ts";
import { armWakeAdvice, failureDetails } from "../extension/shared.ts";
import { compactInlineText } from "../ui/presentation.ts";
import { renderProcessStartResult } from "../ui/process-start-result.ts";
import { renderProcessLog } from "../monitor/log.ts";

export interface ScriptToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	canRun(): boolean;
	scripts: Pick<ScriptSession, "arm" | "list" | "cancel">;
	archive?: Pick<MonitorArchive, "result" | "list">;
	/** Host-owned shell resolution; injectable to prove argv/stdin transport contracts. */
	resolveShell?: typeof getShellConfig;
}

export function registerScriptTool(pi: ExtensionAPI, d: ScriptToolDeps): void {
	pi.registerTool({
		name: "script", label: "Script",
		description: "Run a script or job asynchronously with bounded stdout/stderr and a completion follow-up. run takes either command (an executable) plus literal args, or code (inline bash source, using Pi's shell resolution). Examples: command=python args=['-c','print(1)']; command=node args=['build.mjs']; code='npm test'. Requires script AND bash permission. Returns immediately; continue independent work and end your turn to receive completion automatically. Never poll or sleep to wait. Default deadline ten minutes; maximum eight running scripts and twenty-four hours. list shows active jobs, stop cancels one process tree and its queued wake; result reads bounded session logs, including after reload/resume, and full=true shows the complete retained capture. Keep this Pi session open: shutdown/reload stops scripts; headless pi -p exits after its turn. Use monitor for event-producing watches, timer for alarms.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("stop"), Type.Literal("result")]),
			command: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "run: executable name/path; mutually exclusive with code." })),
			args: Type.Optional(Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 64, description: "run/command: literal argv; maximum 24,000 characters combined. Inline runtime source can use python -c or node -e." })),
			code: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: "run: inline shell source, e.g. npm test. Mutually exclusive with command and args." })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Required for run: short purpose shown in Scripts and F9." })),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: "run: lifetime deadline, default 600 seconds." })),
			id: Type.Optional(Type.String({ minLength: 1, description: "stop/result: script id; omit for result to list retained logs." })),
			full: Type.Optional(Type.Boolean({ description: "result: complete bounded capture instead of a short tail." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: failureDetails({ ok: false }), isError: true });
			if (params.action === "list") {
				const entries = d.scripts.list();
				return { content: [{ type: "text" as const, text: entries.length ? entries.map((e) => `${compactInlineText(e.id)} (${compactInlineText(e.label)}) — deadline ${new Date(e.expiresAtEpochMs).toISOString()}`).join("\n") : "No active scripts." }], details: { ok: true, count: entries.length } };
			}
			if (params.action === "stop") {
				if (typeof params.id !== "string" || !params.id.trim()) return fail("script stop needs { id } from run or list.");
				const stopped = d.scripts.cancel(params.id);
				return { content: [{ type: "text" as const, text: stopped ? `Stopped ${compactInlineText(params.id)}; its queued completion was removed.` : `No active script or queued completion for ${compactInlineText(params.id)}.` }], details: { ok: true, stopped } };
			}
			if (params.action === "result") {
				if (!d.archive) return fail("Script logs are unavailable in this session.");
				if (params.id === undefined) {
					const records = d.archive.list();
					return { content: [{ type: "text" as const, text: records.length ? records.map((r) => `${compactInlineText(r.entry.id)} (${compactInlineText(r.entry.label)}) — ${r.outcome}${r.storageWarning ? "; storage limited" : ""}`).join("\n") : "No retained script logs in this session." }], details: { ok: true, count: records.length } };
				}
				const record = d.archive.result(params.id);
				if (!record) return fail(`Script log unavailable for ${compactInlineText(params.id)}; use result without id to list retained logs.`);
				return { content: [{ type: "text" as const, text: renderProcessLog(record, params.full === true) }], details: { ok: true, id: record.entry.id, outcome: record.outcome, truncated: record.truncated } };
			}
			if (params.action !== "run") return fail("script action must be run, list, stop or result.");
			if (!d.canRun()) return fail("script run requires both script and bash permission for the active persona.");
			if (signal?.aborted) return fail("script run cancelled before launch.");
			if (typeof params.label !== "string" || !params.label.trim()) return fail("script run needs a non-empty label.");
			if ((params.command === undefined) === (params.code === undefined) || (params.code !== undefined && params.args !== undefined)) return fail("script run needs either command plus optional args, or code; these forms are mutually exclusive.");
			if (params.args !== undefined && (!Array.isArray(params.args) || !params.args.every((v) => typeof v === "string"))) return fail("script args must be literal strings.");
			if (params.timeoutSeconds !== undefined && (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < 1 || params.timeoutSeconds > 86400)) return fail("script timeoutSeconds must be between 1 and 86400.");
			let command = params.command;
			let args = params.args;
			let stdin: string | undefined;
			if (params.code !== undefined) {
				if (typeof params.code !== "string" || !params.code.trim() || params.code.length > 8192 || params.code.includes("\0")) return fail("script code must be non-empty shell source without NUL bytes, at most 8192 characters.");
				try {
					const shell = (d.resolveShell ?? getShellConfig)(pi.getSettings().shellPath);
					command = shell.shell;
					args = shell.commandTransport === "stdin" ? shell.args : [...shell.args, params.code];
					if (shell.commandTransport === "stdin") stdin = params.code;
				} catch (error) { return fail(`Could not resolve script shell: ${error instanceof Error ? error.message : String(error)}`); }
			}
			if (typeof command !== "string" || !command.trim()) return fail("script command must be a non-empty executable name.");
			const result = d.scripts.arm({ command, label: params.label, cwd: ctx.cwd, mode: "exit", ...(args === undefined ? {} : { args }), ...(stdin === undefined ? {} : { stdin }), ...(params.timeoutSeconds === undefined ? {} : { timeoutMs: Math.round(params.timeoutSeconds * 1000) }) });
			if (!result.ok) return fail(result.error);
			const completion = ctx.hasUI === false ? "completion is retained while this session stays open" : "completion wakes you when the script exits";
			return { content: [{ type: "text" as const, text: `Started ${result.entry.id} (${compactInlineText(result.entry.label)}); ${completion}. Deadline ${new Date(result.entry.expiresAtEpochMs).toISOString()}. ${armWakeAdvice(ctx, "script", "completion", "Keep this session open. Continue independent work, or end your turn; it wakes you by itself. Never sleep or poll to wait for it.")}` }], details: { ok: true, id: result.entry.id, label: compactInlineText(result.entry.label), expiresAtEpochMs: result.entry.expiresAtEpochMs } };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold(`script ${compactInlineText(args.action ?? "", { maxChars: 12 })}`))} ${theme.fg("dim", compactInlineText(args.label ?? args.id ?? "", { maxChars: 96 }))}`, 0, 0);
		},
		renderResult(result, options, theme, context) {
			const details = (result.details ?? {}) as { ok?: boolean; label?: string; expiresAtEpochMs?: number };
			return renderProcessStartResult(result, options, theme, context,
				details.ok === true && typeof details.label === "string"
					? { verb: "started", label: details.label, ...(details.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: details.expiresAtEpochMs }) }
					: undefined);
		},
	});
}

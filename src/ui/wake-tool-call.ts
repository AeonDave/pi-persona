import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { expandDetailHint } from "../extension/shared.ts";
import { renderPendingCall, type ToolRenderContext } from "./pending-call.ts";
import { compactInlineText, sanitizeTerminalText } from "./presentation.ts";

interface WakeCallArgs {
	action?: string;
	label?: string;
	id?: string;
	message?: string;
	code?: string;
	command?: string;
	args?: string[];
}

type WakeTool = "timer" | "monitor" | "script";

/** Only launches have arguments worth expanding. Pi retains them in the original call. */
export function wakeCallBody(kind: WakeTool, args?: WakeCallArgs): string | undefined {
	if (!args || args.action !== (kind === "script" ? "run" : "arm")) return undefined;
	const body = kind === "timer" ? args.message : kind === "script" ? args.code ?? args.command : args.command;
	return typeof body === "string" && body ? body : undefined;
}

export function renderWakeToolCall(kind: WakeTool, args: WakeCallArgs, theme: Theme, context?: ToolRenderContext): Text {
	const pending = renderPendingCall(kind, theme, context);
	if (pending) return pending;
	const action = compactInlineText(args.action ?? "", { maxChars: 12 });
	const label = compactInlineText(args.label ?? args.id ?? "", { maxChars: 96 });
	let line = theme.fg("toolTitle", theme.bold(`${kind} ${action}`)) + (label ? ` ${theme.fg("dim", label)}` : "");
	const body = wakeCallBody(kind, args);
	if (!context || !body) return new Text(line, 0, 0);
	if (!context.expanded) return new Text(context.isError ? line : `${line} ${theme.fg("dim", expandDetailHint(context))}`, 0, 0);

	line += `\n${theme.fg("toolOutput", sanitizeTerminalText(body))}`;
	if (kind !== "timer" && args.code === undefined && Array.isArray(args.args) && args.args.length) {
		// Keep literal argv boundaries visible, including spaces, embedded newlines and empty values.
		const argv = args.args.filter((value) => typeof value === "string").map((value) => sanitizeTerminalText(JSON.stringify(value)));
		line += `\n${theme.fg("dim", "args ")}${theme.fg("toolOutput", argv.join(" "))}`;
	}
	return new Text(line, 0, 0);
}

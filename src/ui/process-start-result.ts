/** Common launch receipt for scripts and monitors; details and error reads stay literal. */
import { Text } from "@earendil-works/pi-tui";
import { formatDuration } from "../core/time.ts";
import { compactInlineText } from "./presentation.ts";
import { renderLiteralToolResult } from "./literal-tool-result.ts";

interface ProcessStart {
	verb: "armed" | "started";
	label: string;
	mode?: string;
	expiresAtEpochMs?: number;
}

export function renderProcessStartResult(
	result: Parameters<typeof renderLiteralToolResult>[0],
	options: Parameters<typeof renderLiteralToolResult>[1],
	theme: Parameters<typeof renderLiteralToolResult>[2],
	context: Parameters<typeof renderLiteralToolResult>[3],
	start?: ProcessStart,
): Text {
	if (!start || options.expanded || (context?.isError ?? result.isError ?? false)) return renderLiteralToolResult(result, options, theme, context);
	const left = typeof start.expiresAtEpochMs === "number" && Number.isFinite(start.expiresAtEpochMs) ? start.expiresAtEpochMs - Date.now() : undefined;
	const deadline = left === undefined ? "" : left > 0 ? ` · deadline in ${formatDuration(left)}` : " · deadline reached";
	const summary = compactInlineText(`${start.label}${start.mode ? ` · ${start.mode}` : ""}${deadline}`, { maxChars: 140 });
	return new Text(`${theme.fg("toolTitle", theme.bold(`${start.verb} `))}${theme.fg("accent", summary)}`, 0, 0);
}

/** A policy rejection is an actionable caller error, not a failed worker run. */
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText } from "./presentation.ts";
import { renderLiteralToolResult } from "./literal-tool-result.ts";
import { expandDetailHint } from "../extension/shared.ts";

export function renderDelegateRejection(
	result: Parameters<typeof renderLiteralToolResult>[0] & { details?: unknown },
	options: Parameters<typeof renderLiteralToolResult>[1],
	theme: Parameters<typeof renderLiteralToolResult>[2],
	context: Parameters<typeof renderLiteralToolResult>[3],
): Text | undefined {
	const details = result.details as { rejection?: { code?: unknown; tasks?: unknown } } | undefined;
	const rejection = details?.rejection;
	if (rejection?.code !== "parallel-write-set-required" || !Array.isArray(rejection.tasks)) return undefined;
	if (options.expanded) return renderLiteralToolResult(result, options, theme, context);
	const targets = rejection.tasks.map((value: unknown) => {
		if (!value || typeof value !== "object") return "?";
		const task = value as { name?: unknown; agent?: unknown; index?: unknown };
		return `${typeof task.name === "string" ? task.name : typeof task.agent === "string" ? task.agent : "?"} [${String(task.index)}]`;
	});
	return new Text([
		theme.fg("error", theme.bold("delegate rejected · parallel writers need writeSet")),
		theme.fg("dim", compactInlineText(targets.join(", "), { maxChars: 96 })),
		theme.fg("toolOutput", "Add disjoint paths, grant reader tools, or concurrency: 1."),
		theme.fg("dim", expandDetailHint(context?.keyHint ? { keyHint: context.keyHint } : undefined)),
	].join("\n"), 0, 0);
}

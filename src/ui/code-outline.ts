/** Presentation of the bounded, persisted outline; the model-facing result stays canonical. */
import type { Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { expandDetailHint } from "../extension/shared.ts";
import type { CodeOutlineToolDetails } from "../tools/code-outline.ts";
import { createCardFrame } from "./card-frame.ts";
import { renderLiteralToolResult } from "./literal-tool-result.ts";
import { pendingCallLine } from "./pending-call.ts";
import { compactInlineText } from "./presentation.ts";

function validDetails(value: unknown): value is CodeOutlineToolDetails {
	if (!value || typeof value !== "object") return false;
	const d = value as Record<string, unknown>;
	const integer = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
	const bounded = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max;
	if (!Array.isArray(d.symbols) || d.symbols.length > 200 || !integer(d.returned, 0, 200)
		|| d.returned !== d.symbols.length || !integer(d.totalMatches, d.returned, 100_000)
		|| typeof d.hasMore !== "boolean" || typeof d.truncated !== "boolean"
		|| d.hasMore !== (d.totalMatches > d.returned) || d.truncated !== d.hasMore
		|| !bounded(d.language, 100) || !bounded(d.grammar, 100)
		|| typeof d.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256)) return false;
	let size = 0;
	for (const item of d.symbols) {
		if (!item || typeof item !== "object") return false;
		const s = item as Record<string, unknown>;
		if (!bounded(s.name, 16_384) || !bounded(s.kind, 100)
			|| (s.container !== undefined && !bounded(s.container, 16_384))
			|| !integer(s.startLine, 1, 262_145) || !integer(s.endLine, s.startLine, 262_145)) return false;
		size += s.name.length + s.kind.length + (typeof s.container === "string" ? s.container.length : 0);
		if (size > 16_384) return false;
	}
	return true;
}

export function renderOutlineCall(args: { path: string; query?: string }, theme: Theme, context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2]) {
	const path = compactInlineText(typeof args.path === "string" ? args.path.slice(0, 4096) : "", { maxChars: 100 });
	const query = typeof args.query === "string" ? compactInlineText(args.query.slice(0, 200), { maxChars: 80 }) : "";
	const text = pendingCallLine("code_outline", theme, context) ?? `${theme.fg("toolTitle", theme.bold("code_outline"))}${path ? ` ${theme.fg("dim", path)}` : ""}${query ? ` · query ${theme.fg("dim", query)}` : ""}`;
	return { invalidate() {}, render(width: number) {
		if (width <= 0) return [];
		const pad = Math.min(context?.outputPad ?? 0, Math.floor((width - 1) / 2));
		return new Text(truncateToWidth(text, Math.max(1, width - 2 * pad), "…"), pad, 0).render(width).map(line => truncateToWidth(line, width, "…"));
	} };
}

export function renderOutlineResult(
	result: { content: Array<{ type: string; text?: string }>; details: CodeOutlineToolDetails; isError?: boolean },
	{ expanded }: ToolRenderResultOptions, theme: Theme, context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
) {
	if ((context?.isError ?? result.isError ?? false) || !validDetails(result.details)) {
		// renderShell "self" gives no host padding, and the literal renderer is shared with
		// host-padded tools, so the pad is applied here rather than inside it.
		const literal = renderLiteralToolResult(result, { expanded }, theme, context);
		return { invalidate: () => literal.invalidate(), render(width: number) {
			const pad = Math.min(Math.max(0, Math.floor(context?.outputPad ?? 0)), Math.max(0, Math.floor((width - 1) / 2)));
			return literal.render(width - 2 * pad).map((line) => " ".repeat(pad) + line);
		} };
	}
	const d = result.details;
	const rows = d.symbols.map(s => `${JSON.stringify(s.name)} [${s.kind}]${s.container === undefined ? "" : ` in ${JSON.stringify(s.container)}`} L${s.startLine}-${s.endLine}`);
	const metadata = `hasMore=${d.hasMore} · truncated=${d.truncated} · ${d.language} (${d.grammar}) · SHA-256 ${d.sha256}`;
	const full = [...rows, metadata].join("\n");
	return createCardFrame({
		title: `${d.returned} of ${d.totalMatches} matching symbols`, state: "success", full,
		preview: () => ({ text: rows.slice(0, 4).join("\n") || "No matching symbols", truncated: true }),
	}, { expanded, theme, outputPad: context?.outputPad ?? 0, detailHint: () => expandDetailHint(context) });
}

/** `models` tool — discover/search model ids. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText } from "../ui/presentation.ts";
import { renderLiteralToolResult } from "../ui/literal-tool-result.ts";

export interface ModelsToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	searchModels(ctx: ExtensionContext, query?: string): { lines: string[]; total: number; capped: boolean; shortlist: boolean };
}

export function registerModelsTool(pi: ExtensionAPI, d: ModelsToolDeps): void {
	// ── /models + a `models` tool — discover/search model ids ─────────────────────
	pi.registerTool({
		name: "models",
		label: "Models",
		description: [
			"Discover model candidates (provider/id). With no query: the current model first, then a compact",
			"shortlist of nearby family/version candidates from the same provider, ordered cost:low → medium → high → unknown.",
			"Family and version names are proximity hints, not verified release dates or account support. A query searches",
			"the full eligible catalog, including older models and snapshots. Use exact refs; ★ marks your",
			"session provider, not account support. Authentication does not guarantee access to every listed model.",
			"cost:low/medium/high ranks advertised API prices relative to recent candidates of the same provider;",
			"cost:unknown means insufficient price data. These are cost bands, not quality, speed or reasoning-effort ratings; choose task fit yourself.",
			"Context, reasoning support and API prices are host catalog metadata; API prices do not describe subscription billing.",
			"Prefer these nearby candidates before older or unrelated models merely because they are cheap. Omitting `model` preserves",
			"saved per-persona role/agent assignments, then the agent frontmatter model and engine defaults; it does not necessarily select the supervisor model.",
			"To intentionally choose the supervisor's current model over a configured choice, pass its exact provider/id as `model` only when explicitly authorized.",
			"Never silently switch providers or billing routes.",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search the full catalog by substring (provider or id), e.g. 'sonnet'; omit for the current-first shortlist" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const { lines, total, capped, shortlist } = d.searchModels(ctx, params.query);
			const showing = shortlist || capped ? ` (showing ${lines.length} ${shortlist ? "nearby family/version candidates" : "matches"})` : "";
			const text = lines.length
				? `${total} catalog model(s)${showing}; ★ = session provider, (you) = current model. Account support may vary.${shortlist || capped ? " Query searches the full catalog." : ""}\n${lines.join("\n")}`
				: `no models match "${params.query ?? ""}"`;
			return { content: [{ type: "text", text }], details: { total, shown: lines.length, shortlist }, isError: false };
		},
		renderCall(args, theme) {
			const query = compactInlineText(args.query ?? "(shortlist)", { maxChars: 96 }) || "(shortlist)";
			return new Text(`${theme.fg("toolTitle", theme.bold("models "))}${theme.fg("dim", query)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			// The catalog itself is literal data: the shared renderer bounds it collapsed and
			// shows the complete sanitized listing expanded.
			if (expanded) return renderLiteralToolResult(result, { expanded }, theme, context);
			const failed = context?.isError ?? result.isError ?? false;
			if (failed) return renderLiteralToolResult(result, { expanded: false }, theme, context);
			const details = (result.details ?? {}) as { total?: number; shown?: number; shortlist?: boolean };
			const total = typeof details.total === "number" && Number.isFinite(details.total) ? details.total : 0;
			const shown = typeof details.shown === "number" && Number.isFinite(details.shown) ? details.shown : 0;
			const summary = shown === 0
				? "no catalog matches"
				: `${total} catalog models · showing ${shown}${details.shortlist ? " nearby candidates" : " matches"}`;
			return new Text(`${theme.fg("toolTitle", theme.bold("models · "))}${theme.fg("accent", compactInlineText(summary, { maxChars: 96 }))}`, 0, 0);
		},
	});
}

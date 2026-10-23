/** `models` tool — discover/search model ids. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText } from "../ui/presentation.ts";

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
			"version-ranked shortlist; versions are naming hints, not verified release dates. A query searches",
			"the full eligible catalog, including older models and snapshots. Use exact refs; ★ marks your",
			"session provider, not account support. Authentication does not guarantee access to every listed model.",
			"cost:low/medium/high ranks advertised API prices relative to recent candidates of the same provider;",
			"cost:unknown means insufficient price data. These are cost bands, not quality, speed or reasoning-effort ratings; choose task fit yourself.",
			"Context, reasoning support and API prices are host catalog metadata; API prices do not describe subscription billing.",
			"Prefer a suitable recent model known to work with this account; when unsure, omit a delegate's",
			"model to inherit the working session model. Keep the provider/billing route unless a change is authorized.",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search the full catalog by substring (provider or id), e.g. 'sonnet'; omit for the current-first shortlist" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const { lines, total, capped, shortlist } = d.searchModels(ctx, params.query);
			const showing = shortlist || capped ? ` (showing ${lines.length} ${shortlist ? "version-ranked candidates" : "matches"})` : "";
			const text = lines.length
				? `${total} catalog model(s)${showing}; ★ = session provider, (you) = current model. Account support may vary.${shortlist || capped ? " Query searches the full catalog." : ""}\n${lines.join("\n")}`
				: `no models match "${params.query ?? ""}"`;
			return { content: [{ type: "text", text }], details: { total, shown: lines.length, shortlist }, isError: false };
		},
		renderCall(args, theme) {
			const query = compactInlineText(args.query ?? "(shortlist)", { maxChars: 96 }) || "(shortlist)";
			return new Text(`${theme.fg("toolTitle", theme.bold("models "))}${theme.fg("dim", query)}`, 0, 0);
		},
	});
}

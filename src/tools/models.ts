/** `models` tool — discover/search model ids. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText } from "../ui/presentation.ts";

export interface ModelsToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	searchModels(ctx: ExtensionContext, query?: string): { lines: string[]; total: number; capped: boolean };
}

export function registerModelsTool(pi: ExtensionAPI, d: ModelsToolDeps): void {
	// ── /models + a `models` tool — discover/search model ids ─────────────────────
	pi.registerTool({
		name: "models",
		label: "Models",
		description: [
			"List or search the available model ids (provider/id). The same name exists under several",
			"providers — use an EXACT id from here as a delegate task's `model`. ★ marks your session",
			"provider; prefer it (it's the authenticated one).",
		].join(" "),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Filter by substring (provider or id), e.g. 'sonnet'" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const { lines, total, capped } = d.searchModels(ctx, params.query);
			const text = lines.length
				? `${total} model(s)${capped ? " (showing 40 — refine with a query)" : ""}; ★ = session provider:\n${lines.join("\n")}`
				: `no models match "${params.query ?? ""}"`;
			return { content: [{ type: "text", text }], details: { total }, isError: false };
		},
		renderCall(args, theme) {
			const query = compactInlineText(args.query ?? "(all)", { maxChars: 96 }) || "(all)";
			return new Text(`${theme.fg("toolTitle", theme.bold("models "))}${theme.fg("dim", query)}`, 0, 0);
		},
	});
}

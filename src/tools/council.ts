/** `council` tool — deliberate, vote, ruling. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fenceUntrusted } from "../core/fence.ts";
import { expandDetailHint, failureDetails, formatCouncilCallLabel } from "../extension/shared.ts";
import { knownParams, strategyNames } from "../orchestration/strategy.ts";
import { formatCouncilResult, humanizeAggregateResult } from "../orchestration/render.ts";
import type { FailureKind } from "../orchestration/types.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { resolveCouncilInvocation } from "../persona/persona.ts";
import type { OrchestrationGrammar, Persona } from "../persona/persona.ts";
import type { PersonaController } from "../persona/controller.ts";
import { Text } from "@earendil-works/pi-tui";
import { compactInlineText, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";
import { emptyUsage } from "../engine/stream.ts";


export interface CouncilToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	controller: PersonaController;
	personas: Persona[];
	runStrategyVisible(
		ctx: ExtensionContext,
		orch: OrchestrationGrammar,
		task: string,
		label: string,
		signal?: AbortSignal,
	): Promise<AgentResult | undefined>;
	drainBusBlock(): string;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
}

export function registerCouncilTool(pi: ExtensionAPI, d: CouncilToolDeps): void {
	// ── council tool (deliberate → vote → ruling; the executor then applies it) ───
	const CouncilParams = Type.Object({
		question: Type.String({ description: "The decision or problem to deliberate — specific and self-contained" }),
		persona: Type.Optional(
			Type.String({
				description:
					'Installed persona whose declared council profile to use (for example "magi"). This borrows only its council strategy/roster/params; the active caller remains in control.',
			}),
		),
		strategy: Type.Optional(
			Type.String({ description: "Per-call strategy override (default: the selected or active persona's council strategy)" }),
		),
		roster: Type.Optional(Type.String({ description: "Per-call roster override (default: the selected or active persona's council roster)" })),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					'Strategy params, merged over the persona\'s (e.g. { "reflect": false } to skip magi\'s reflection round, { "aggregate": "unanimity" }, { "rounds": 3 }). Reach for it when the user asks for a variant of the persona\'s default council this one time.',
			}),
		),
	});
	pi.registerTool({
		name: "council",
		label: "Council",
		description: [
			"Convene a council of specialists with controlled, complementary biases to deliberate a",
			"decision and vote — returns the ruling (winner, tally, each member's view, recorded dissent).",
			"Use it before any significant choice; then EXECUTE the ruling yourself and re-convene when",
			"execution surfaces a new decision. Patterns: adversarial vote (magi, council-rounds), best-of-N",
			"with an impartial arbiter (judge, compete), batch map, merged synthesis (synthesize).",
			'Use `persona: "magi"` to invoke an installed persona\'s declared council without switching away',
			"from the active caller; its prompt, model, tools, and permissions are never inherited.",
			`Strategies: ${strategyNames()
				.map((n) => {
					const p = knownParams(n);
					const keys = p ? Object.keys(p) : [];
					return keys.length > 0 ? `${n}(${keys.join(", ")})` : n;
				})
				.join(" · ")}.`,
			'Pass `params` to vary the persona\'s default council for one call — e.g. { "reflect": false }.',
		].join(" "),
		parameters: CouncilParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const resolved = resolveCouncilInvocation(d.personas, d.controller.activePersona, {
				persona: params.persona,
				strategy: params.strategy,
				roster: params.roster,
				params: params.params as Record<string, unknown> | undefined,
			});
			if (!resolved.ok) {
				return {
					content: [{ type: "text", text: `council failed: ${resolved.error}` }],
					details: failureDetails({ error: resolved.error, persona: params.persona }),
					isError: true,
				};
			}
			const { strategy, roster, params: mergedParams, persona } = resolved.value;
			try {
				// Fully persona-driven: a persona's `council:` block picks the strategy, roster,
				// and params — a new ensemble (more members, supermajority, multi-round) needs no
				// code, just a team + (optional) strategy file + a council block. Params override.
				// Per-call params override the selected council profile (e.g. reflect:false this once).
				// Lenient by design (I2: strategies are trusted project code) — an unknown param key
				// only warns, it never blocks or alters the run. A correct call is untouched.
				let paramNote = "";
				const schema = knownParams(strategy);
				if (schema) {
					const unknown = Object.keys(mergedParams).filter((k) => !(k in schema));
					if (unknown.length > 0) {
						const note = `council: ignoring unknown param(s) [${unknown.join(", ")}] for "${strategy}" — known: ${Object.keys(schema).join(", ") || "(none)"}`;
						if (process.env.PI_PERSONA_DEBUG) process.stderr.write(`[pi-persona] ${note}\n`);
						ctx.ui.notify(note, "warning");
						paramNote = `\n\n(${note})`;
					}
				}
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: mergedParams };
				const result = await d.runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				const s = (result?.structured ?? {}) as { headline?: string; status?: string; tally?: Record<string, number>; usedFallback?: boolean; count?: number };
				const ruling = result?.output ?? "(the council returned no ruling)";
				const uiBody = result ? (humanizeAggregateResult(result) ?? result.output) : "";
				const headline = s.headline ?? (typeof s.count === "number" ? `${s.count} member results` : s.status ?? "");
				const ok = result?.ok ?? false;
				const details = {
					ok,
					headline,
					status: s.status,
					tally: s.tally,
					usedFallback: s.usedFallback,
					body: uiBody,
					strategy,
					roster,
					persona,
					...(result?.error ? { error: result.error } : {}),
					...(result?.failureKind ? { failureKind: result.failureKind } : {}),
				};
				const usage = result?.usage ?? emptyUsage();
				d.childUsage.account(usage);
				d.publishPersonaCost();
				return {
					// The ruling is sub-agent (council member) text — fence it like every other
					// path that hands sub-agent output to the supervisor.
					content: [{ type: "text", text: `${fenceUntrusted(ruling)}${paramNote}${d.drainBusBlock()}` }],
					details: ok ? details : failureDetails(details),
					isError: !ok,
					...toolUsageField(usage),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: failureDetails({ error: message, strategy, roster }), isError: true };
			}
		},
		renderCall(args, theme) {
			const resolved = resolveCouncilInvocation(d.personas, d.controller.activePersona, {
				persona: args.persona,
				strategy: args.strategy,
				roster: args.roster,
				params: args.params as Record<string, unknown> | undefined,
			});
			const strategy = resolved.ok ? resolved.value.strategy : (args.strategy ?? "?");
			const roster = resolved.ok ? resolved.value.roster : (args.roster ?? args.persona ?? "?");
			return new Text(theme.fg("toolTitle", theme.bold(formatCouncilCallLabel(strategy, roster))), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as {
				ok?: boolean;
				headline?: string;
				status?: string;
				tally?: Record<string, number>;
				usedFallback?: boolean;
				body?: string;
				strategy?: string;
				roster?: string;
				error?: string;
				failureKind?: FailureKind;
			};
			const first = result.content[0];
			const body = sanitizeTerminalText(d.body || (first && first.type === "text" ? first.text : ""));
			const failed = d.ok === false || !!d.error;
			if (failed) {
				const cause = compactInlineText([d.failureKind, d.error].filter((part): part is string => !!part).join(" · "), { maxChars: 160 });
				const title = theme.fg("error", theme.bold(`council failed${cause ? ` · ${cause}` : ""}`));
				if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", body || "(no ruling)")}`, 0, 0);
				const preview = compactVisibleText(body || "(no ruling)", { maxLines: 3, maxLineChars: 100 });
				const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
				return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
			}
			const text = formatCouncilResult(
				{ headline: d.headline, status: d.status, tally: d.tally, usedFallback: d.usedFallback, body },
				expanded,
				expandDetailHint(),
			);
			return new Text(theme.fg(expanded ? "toolOutput" : "accent", text), 0, 0);
		},
	});
}

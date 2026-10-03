/** `council` tool — deliberate, vote, ruling. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fenceUntrusted } from "../core/fence.ts";
import { expandDetailHint, failureDetails, formatCouncilCallLabel } from "../extension/shared.ts";
import { knownParams, strategyNames } from "../orchestration/strategy.ts";
import { memberBaseLabel, type RosterMember } from "../orchestration/roster.ts";
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

/** What the card names as the panel: the team, or the ad-hoc members themselves — an
 *  ephemeral call has no team name, so the resolver leaves `roster` empty for it. */
function panelLabel(value: { roster: string; members?: RosterMember[] | undefined }): string {
	if (!value.members || value.members.length === 0) return value.roster;
	return value.members.map((m) => memberBaseLabel(m)).join(", ");
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
			Type.String({ description: 'Per-call strategy override (default: the selected or active council profile\'s strategy, or built-in "magi")' }),
		),
		roster: Type.Optional(Type.String({ description: 'Per-call roster override (default: the selected or active profile\'s roster, then its orchestration roster, or built-in "magi")' })),
		members: Type.Optional(
			Type.Array(Type.Unknown(), {
				description:
					'Ephemeral panel members for THIS call — each an installed agent name ("scout") or an inline { agent, role?, model?, skills? } specialisation. They win `roster` and the profile\'s own members for this call only: no team file, persona file, or inherited model/tool is touched. Omit to use the named roster.',
			}),
		),
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
			"decision — returns the selected strategy's result, preserving vote tally and dissent when produced.",
			"Scale it to the decision: convene for a genuine fork, a contested or high-stakes call, or a",
			"pick between rival answers — NOT before every decision, and a routine task does not",
			"deserve a whole panel. Then EXECUTE the ruling yourself and re-convene only when execution",
			"surfaces a NEW decision. Do NOT use it to get work done: `delegate` (and your own tools)",
			"produce the work; the council decides, the executor acts.",
			"Patterns: adversarial vote with dissent (magi, council-rounds); a reasoned pick between rival",
			"COMPLETE answers by an impartial arbiter (judge); adversarial critique then revise",
			"(critic-loop); head-to-head argument (debate); many findings merged into ONE deliverable",
			"(synthesize, map); rival implementations judged blind (compete); a single pair (pair).",
			'Use `persona: "magi"` to invoke an installed persona\'s declared council without switching away',
			"from the active caller; its prompt, model, tools, and permissions are never inherited.",
			`Strategies: ${strategyNames()
				.map((n) => {
					const p = knownParams(n);
					const keys = p ? Object.keys(p) : [];
					return keys.length > 0 ? `${n}(${keys.join(", ")})` : n;
				})
				.join(" · ")}.`,
			"Pass `members` to seat an ad-hoc panel for one call, or `params` to vary the profile's default",
			'council — e.g. { "reflect": false }.',
		].join(" "),
		parameters: CouncilParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const resolved = resolveCouncilInvocation(d.personas, d.controller.activePersona, {
				persona: params.persona,
				strategy: params.strategy,
				roster: params.roster,
				members: params.members,
				params: params.params as Record<string, unknown> | undefined,
			});
			if (!resolved.ok) {
				return {
					content: [{ type: "text", text: `council failed: ${resolved.error}` }],
					details: failureDetails({ error: resolved.error, persona: params.persona }),
					isError: true,
				};
			}
			const { strategy, roster, members, params: mergedParams, persona } = resolved.value;
			const panel = panelLabel({ roster, members });
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
				// Ephemeral members ride the SAME grammar path as a named team (see
				// `resolveOrchestrationMembers`) — nothing about the profile is inherited.
				if (members) orch.members = members;
				const result = await d.runStrategyVisible(ctx, orch, params.question, `council:${_id}`, signal);
				const s = (result?.structured ?? {}) as {
					headline?: string;
					status?: string;
					tally?: Record<string, number>;
					usedFallback?: boolean;
					count?: number;
					items?: unknown;
				};
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
					items: s.items,
					body: uiBody,
					strategy,
					roster: panel,
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
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: failureDetails({ error: message, strategy, roster: panel }), isError: true };
			}
		},
		renderCall(args, theme) {
			const resolved = resolveCouncilInvocation(d.personas, d.controller.activePersona, {
				persona: args.persona,
				strategy: args.strategy,
				roster: args.roster,
				members: args.members,
				params: args.params as Record<string, unknown> | undefined,
			});
			const strategy = resolved.ok ? resolved.value.strategy : (args.strategy ?? "?");
			// With inline members there is no named team to name — label the panel itself.
			const roster = resolved.ok ? panelLabel(resolved.value) : (args.roster ?? args.persona ?? "?");
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

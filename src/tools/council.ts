/** `council` tool — deliberate, vote, ruling. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fenceUntrusted } from "../core/fence.ts";
import { resultReceiptHint } from "../results/retrieval.ts";
import { expandDetailHint, failureDetails, formatCouncilCallLabel, isInline, toastCause } from "../extension/shared.ts";
import { knownParams, missingRequiredParams, strategyCatalog } from "../orchestration/strategy.ts";
import { memberBaseLabel, parseRuntimeRosterMember, type RosterMember } from "../orchestration/roster.ts";
import { formatCouncilResult, humanizeAggregateResult } from "../orchestration/render.ts";
import type { FailureKind } from "../orchestration/types.ts";
import type { AgentResult } from "../orchestration/types.ts";
import { resolveCouncilInvocation } from "../persona/persona.ts";
import type { OrchestrationGrammar, Persona } from "../persona/persona.ts";
import type { PersonaController } from "../persona/controller.ts";
import { Text } from "@earendil-works/pi-tui";
import { createReportBody } from "../ui/report-body.ts";
import { orchestrationLaunchLines, type OrchestrationLaunchSnapshot } from "../ui/orchestration-launch.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "../ui/presentation.ts";
import { toolUsageField } from "../ui/usage.ts";
import { emptyUsage } from "../engine/stream.ts";
import { launchReceipt, type BackgroundRuns, type TrackedRun } from "./background-run.ts";


export interface CouncilToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	controller: PersonaController;
	personas: Persona[];
	launchSnapshot(ctx: ExtensionContext, orch: OrchestrationGrammar): OrchestrationLaunchSnapshot;
	runStrategyVisible(
		ctx: ExtensionContext,
		orch: OrchestrationGrammar,
		task: string,
		label: string,
		tracked?: TrackedRun,
	): Promise<AgentResult | undefined>;
	/** Launch/join: a council is one tracked run, like a delegate leg (see background-run.ts). */
	runs: BackgroundRuns;
	drainBusBlock(): string;
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
		roster: Type.Optional(Type.String({ description: 'Per-call roster override (default: the method\'s own team when you switch method; else the selected or active profile\'s roster, then its orchestration roster, or built-in "magi")' })),
		members: Type.Optional(
			Type.Array(Type.Unknown(), {
				description:
					'Ephemeral panel members for THIS call — each an installed agent name ("scout") or an inline { agent, role?, model?, thinking?, skills?, tools?, isolation?, mcp? } specialisation. thinking is per-leg requested effort (off/minimal/low/medium/high/xhigh/max); Pi clamps it to model capabilities, overriding the agent and shared child effort defaults. They win `roster` and the profile\'s own members for this call only: no team file, persona file, or inherited model/tool is touched. Omit to use the named roster.',
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
		// The method catalog is generated from the strategy registry (`when`/`roster`/`required`), never hand-written.
		description: `${[
			"Convene a council of specialists with controlled, complementary biases to deliberate a",
			"decision or run a coordinated method over a task — returns the selected strategy's result,",
			"preserving vote tally and dissent when produced.",
			"Scale it to the task: convene when the method adds value — NOT before every decision, and a",
			"routine task does not deserve a whole panel. Then act on the result yourself and re-convene only",
			"when acting surfaces a NEW decision. Do NOT use it for plain independent parallel work: that is",
			"`delegate`. Interactive sessions run a council in the background: you get a run id at once and ONE",
			"follow-up carries the ruling, so end your turn and never poll it; headless sessions return the",
			"ruling inline.",
			'Use `persona: "magi"` to invoke an installed persona\'s declared council without switching away',
			"from the active caller; its prompt, model, tools, and permissions are never inherited.",
			"Pass `members` to seat an ad-hoc panel for one call, or `params` to vary the profile's default",
			'council — e.g. { "reflect": false }.',
			"Pick the strategy by problem class (`*` = required param):",
		].join(" ")}
${strategyCatalog()}`,
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
			// A call that cannot run (no such persona, a missing `required` param) is refused HERE, as an
			// immediate tool error — before a run, a tree row or the model picker exists.
			const error = resolved.ok ? missingRequiredParams(resolved.value.strategy, resolved.value.params) : resolved.error;
			if (!resolved.ok || error) {
				return {
					content: [{ type: "text", text: `council failed: ${error}` }],
					details: failureDetails({ error: error ?? "", persona: params.persona }),
					isError: true,
				};
			}
			const { strategy, roster, members, params: mergedParams, persona } = resolved.value;
			const panel = panelLabel({ roster, members });
			let launch: OrchestrationLaunchSnapshot | undefined;
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
						// The toast is bounded/sanitized for the operator; the model-facing paramNote below
						// keeps the raw note byte-identical (payloads are not presentation).
						ctx.ui.notify(toastCause(note), "warning");
						paramNote = `\n\n(${note})`;
					}
				}
				const orch: OrchestrationGrammar = { mode: "strategy", strategy, roster, params: mergedParams };
				// Ephemeral members ride the SAME grammar path as a named team (see
				// `resolveOrchestrationMembers`) — nothing about the profile is inherited.
				if (members) orch.members = members;
				try {
					const snapshot = d.launchSnapshot(ctx, orch);
					launch = { ...snapshot, participants: snapshot.participants.map((p) => ({ ...p })) };
				} catch {
					// A display lookup must not change launch admission; its failure is visible, not
					// replaced with guessed models or an apparently successful empty panel.
					launch = { participants: [], unavailable: true };
				}
				// The same launch `delegate` uses: ONE tracked run. Interactive sessions get a receipt now and
				// the ruling as ONE completion follow-up (the idle-gated wake, fenced and bounded); headless
				// sessions join the run before returning, since nothing would deliver a follow-up there.
				const inline = isInline(ctx);
				const id = d.runs.launch({ kind: "council", label: `council ${strategy}`, task: params.question, inline }, async (run) =>
					(await d.runStrategyVisible(ctx, orch, params.question, "council", run)) ??
					{ agent: strategy, output: "(the council returned no ruling)", usage: emptyUsage(), ok: false, error: "no ruling" });
				if (!inline) {
					const names = compactInlineText(`${strategy} · ${panel}`, { maxChars: 120 });
					return {
						content: [{ type: "text", text: `${launchReceipt("council", id, names, "with the ruling")}${paramNote}` }],
						details: { runId: id, strategy, roster: panel, persona, launch },
						isError: false,
					};
				}
				const { runs, usage } = await d.runs.settle([id], signal);
				const run = runs[0];
				const result = run?.result;
				if (!result) {
					const message = run?.error ?? run?.status ?? "the run record is gone";
					return { content: [{ type: "text", text: `council failed: ${message}` }], details: failureDetails({ error: message, strategy, roster: panel, ...(launch ? { launch } : {}) }), isError: true };
				}
				const s = (result.structured ?? {}) as {
					headline?: string;
					status?: string;
					tally?: Record<string, number>;
					usedFallback?: boolean;
					count?: number;
					items?: unknown;
				};
				const headline = s.headline ?? (typeof s.count === "number" ? `${s.count} member results` : s.status ?? "");
				const details = {
					launch,
					ok: result.ok,
					headline,
					status: s.status,
					tally: s.tally,
					usedFallback: s.usedFallback,
					items: s.items,
					body: humanizeAggregateResult(result) ?? result.output,
					strategy,
					roster: panel,
					persona,
					...(result.error ? { error: result.error } : {}),
					...(result.failureKind ? { failureKind: result.failureKind } : {}),
					...(run?.resultReceipt ? { resultReceipt: { ...run.resultReceipt } } : {}),
				};
				return {
					// The ruling is sub-agent (council member) text — fence it like every other
					// path that hands sub-agent output to the supervisor.
					// A run stopped before it convened has no ruling, only its cause: show that, not an empty fence.
					content: [{ type: "text", text: `${fenceUntrusted(result.output || result.error || "")}${run?.resultReceipt ? `\n\n${resultReceiptHint(run.resultReceipt)}` : ""}${paramNote}${d.drainBusBlock()}` }],
					details: result.ok ? details : failureDetails(details),
					isError: !result.ok,
					...toolUsageField(usage),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `council failed: ${message}` }], details: failureDetails({ error: message, strategy, roster: panel, ...(launch ? { launch } : {}) }), isError: true };
			}
		},
		renderCall(args, theme) {
			// Native Pi draws the call before its saved result. Keep this title args-only and
			// neutral about omitted defaults; the receipt below carries the resolved snapshot.
			const members = Array.isArray(args.members) ? args.members.flatMap((raw) => {
				const parsed = parseRuntimeRosterMember(raw);
				return parsed.ok ? [parsed.member] : [];
			}) : [];
			const strategy = args.strategy ?? "profile defaults";
			const roster = members?.length ? panelLabel({ roster: "", members }) : args.roster ?? args.persona ?? "profile roster";
			return new Text(theme.fg("toolTitle", theme.bold(formatCouncilCallLabel(strategy, roster))), 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
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
				runId?: string;
				launch?: OrchestrationLaunchSnapshot;
			};
			const first = result.content[0];
			const failed = (context?.isError ?? result.isError) || d.ok === false || !!d.error;
			if (d.runId) {
				// Interactive launch receipt: the ruling arrives later as the completion follow-up.
				const launched = failed ? theme.fg("error", theme.bold("council failed"))
					: `${theme.fg("toolTitle", theme.bold("council "))}${theme.fg("accent", compactInlineText(`launched ${d.runId} · ${d.strategy ?? "?"} · ${d.roster ?? "?"}`, { maxChars: 120 }))}`;
				const metadata = orchestrationLaunchLines(d.launch, expanded).join("\n");
				return new Text([launched, theme.fg("dim", metadata), expanded && first?.type === "text" ? theme.fg("toolOutput", sanitizeTerminalText(first.text)) : ""].filter(Boolean).join("\n"), 0, 0);
			}
			const body = sanitizeTerminalText(d.body || (first && first.type === "text" ? first.text : ""));
			const metadata = d.launch ? `\n\nLaunch request (Pi may clamp effort):\n${orchestrationLaunchLines(d.launch, expanded).join("\n")}` : "";
			if (failed) {
				const cause = compactInlineText([d.failureKind, d.error].filter((part): part is string => !!part).join(" · "), { maxChars: 160 });
				const title = () => theme.fg("error", theme.bold(`council failed${cause ? ` · ${cause}` : ""}`));
				if (expanded) {
					// Only a completed council retains a ruling body; preflight/host errors are literal.
					if (typeof d.body === "string") return createReportBody(`${body || "(no ruling)"}${metadata}`, theme, { header: title }, context?.lastComponent);
					return new Text(`${title()}\n${theme.fg("toolOutput", body || "(no ruling)")}${theme.fg("dim", metadata)}`, 0, 0);
				}
				const preview = compactVisibleText(body || "(no ruling)", { maxLines: 3, maxLineChars: 100 });
				const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
				return new Text(`${title()}\n${theme.fg("toolOutput", preview.text)}${hint}${theme.fg("dim", metadata)}`, 0, 0);
			}
			const text = formatCouncilResult(
				{ headline: d.headline, status: d.status, tally: d.tally, usedFallback: d.usedFallback, body },
				expanded,
				expandDetailHint(),
			);
			return expanded ? createReportBody(`${text}${metadata}`, theme, {}, context?.lastComponent) : new Text(`${theme.fg("accent", text)}${theme.fg("dim", metadata)}`, 0, 0);
		},
	});
}

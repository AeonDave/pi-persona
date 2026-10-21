/** `flow` tool — run a *.flow.json DAG. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandDetailHint, failureDetails, isInline } from "../extension/shared.ts";
import { fenceUntrusted } from "../core/fence.ts";
import { flowDisposition, type FlowOutcome } from "../orchestration/flow-run.ts";
import type { FlowSpec } from "../orchestration/flow.ts";
import { compactInlineText, compactVisibleText, sanitizeTerminalText } from "../ui/presentation.ts";
import { toolUsageField } from "../ui/usage.ts";
import { sumUsage } from "../orchestration/reducers.ts";
import { Text } from "@earendil-works/pi-tui";
import type { AgentResult, FailureKind } from "../orchestration/types.ts";
import { launchReceipt, type BackgroundRuns, type TrackedRun } from "./background-run.ts";

export interface FlowToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	loadFlow(cwd: string, name: string): { ok: true; flow: FlowSpec } | { ok: false; error: string } | undefined;
	listFlows(cwd: string): string[];
	runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, task: string, tracked?: TrackedRun): Promise<FlowOutcome>;
	/** Launch/join: a flow is one tracked run, like a delegate leg (see background-run.ts). */
	runs: BackgroundRuns;
}

/** A finished flow as the tracker sees it. A checkpoint the operator declined is a STOP (the run settles
 *  "stopped", never "failed"); a cancelled run is an abort; anything else that is not ok is a failure. */
function flowResult(name: string, outcome: FlowOutcome): AgentResult {
	const base: AgentResult = {
		agent: `flow ${name}`,
		output: outcome.output || "(flow produced no output)",
		usage: sumUsage(Object.values(outcome.results).map((r) => r.usage)),
		ok: outcome.ok,
	};
	const disposition = flowDisposition(outcome);
	if (disposition === "done") return base;
	if (disposition === "stopped") {
		return { ...base, error: `stopped at checkpoint "${outcome.stoppedAtGate}": not approved`, failureKind: "abort" };
	}
	return { ...base, error: outcome.error ?? "flow failed", failureKind: outcome.cancelled ? "abort" : (outcome.failureKind ?? "agent") };
}

export function registerFlowTool(pi: ExtensionAPI, d: FlowToolDeps): void {
	// ── flow tool (run a *.flow.json DAG over strategies; the supervisor self-launches) ──
	const FlowToolParams = Type.Object({
		name: Type.String({ description: "The flow to run — a *.flow.json by name (installed flows are listed in your sub-agents brief; the user can run /flow to list them)" }),
		task: Type.String({ description: "The objective to run the flow on" }),
	});
	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Run a named flow — a declarative DAG over strategies (`*.flow.json`): phases each run a",
			"strategy over a roster, wired by `needs`, fanning out where independent and threading each",
			"phase's output into its dependents. Journaled: re-running the identical task resumes finished phases. Reach for it",
			"when a task has a fixed multi-stage shape (e.g. gather → critique → decide) you want run",
			"deterministically, end to end, rather than deciding each step yourself. Interactive sessions run it in",
			"the BACKGROUND: you get a run id at once and ONE follow-up when it ends (a checkpoint waits for the",
			"operator, not for you), so end your turn and never poll it; headless sessions block and return inline.",
		].join(" "),
		parameters: FlowToolParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			d.lastCtx = ctx;
			const parsed = d.loadFlow(ctx.cwd, params.name);
			if (!parsed) {
				const installed = d.listFlows(ctx.cwd);
				const hint = installed.length > 0 ? `Installed flows: ${installed.join(", ")}.` : "No flows are installed — add a *.flow.json under .pi/flows/.";
				return {
					content: [{ type: "text", text: `no flow named "${params.name}". ${hint}` }],
					details: failureDetails({ ok: false, error: `no flow named "${params.name}"` }),
					isError: true,
				};
			}
			if (!parsed.ok) {
				return {
					content: [{ type: "text", text: `flow "${params.name}" is invalid: ${parsed.error}` }],
					details: failureDetails({ ok: false, failureKind: "contract", error: parsed.error }),
					isError: true,
				};
			}
			try {
				// The same launch `delegate` uses: ONE tracked run. Interactive sessions get a receipt now and
				// the outcome as ONE completion follow-up; a checkpoint is the OPERATOR's modal and never wakes
				// the model. Headless sessions join the run before returning (and reject every checkpoint).
				const inline = isInline(ctx);
				const ran: { outcome?: FlowOutcome } = {}; // the run's full outcome, which the tracker's AgentResult cannot carry
				const id = d.runs.launch({ kind: "flow", label: `flow ${parsed.flow.name}`, task: params.task, inline }, async (run) => {
					const finished = await d.runFlowVisible(ctx, parsed.flow, params.task, run);
					ran.outcome = finished;
					return flowResult(parsed.flow.name, finished);
				});
				if (!inline) {
					const name = compactInlineText(parsed.flow.name, { maxChars: 64 });
					return {
						content: [{ type: "text", text: launchReceipt("flow", id, name, "when it ends; a checkpoint waits for the operator, not for you") }],
						details: { runId: id, flow: name },
						isError: false,
					};
				}
				const { runs, usage } = await d.runs.settle([id], signal);
				const run = runs[0];
				const outcome = ran.outcome;
				if (!outcome) {
					const message = run?.error ?? run?.result?.error ?? run?.status ?? "the run record is gone";
					return { content: [{ type: "text", text: `flow failed: ${message}` }], details: failureDetails({ ok: false, error: message }), isError: true };
				}
				const details = {
					ok: outcome.ok,
					failedPhase: outcome.failedPhase,
					failureKind: outcome.failureKind,
					error: outcome.error,
					stoppedAtGate: outcome.stoppedAtGate,
				};
				// An unapproved checkpoint is the operator's choice: the flow stopped, it did not fail.
				const failed = flowDisposition(outcome) === "failed";
				return {
					content: [{ type: "text", text: fenceUntrusted(outcome.output || "(flow produced no output)") }],
					details: failed ? failureDetails(details) : details,
					isError: failed,
					...toolUsageField(usage),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `flow failed: ${message}` }], details: failureDetails({ ok: false, error: message }), isError: true };
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("flow "))}${theme.fg("accent", compactInlineText(args.name ?? "?", { maxChars: 96 }) || "?")}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = (result.details ?? {}) as {
				ok?: boolean;
				failedPhase?: string;
				failureKind?: FailureKind;
				error?: string;
				stoppedAtGate?: string;
				runId?: string;
				flow?: string;
			};
			const first = result.content[0];
			const full = sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)");
			if (details.runId) {
				// Interactive launch receipt: the outcome arrives later as the completion follow-up.
				const launched = `${theme.fg("toolTitle", theme.bold("flow "))}${theme.fg("accent", compactInlineText(`launched ${details.runId} · ${details.flow ?? "?"}`, { maxChars: 120 }))}`;
				return new Text(expanded ? `${launched}\n${theme.fg("toolOutput", full)}` : launched, 0, 0);
			}
			const disposition = flowDisposition({ ok: details.ok !== false, stoppedAtGate: details.stoppedAtGate });
			const failed = disposition === "failed";
			const failureBits = failed
				? compactInlineText(
						[details.failedPhase ? `phase ${details.failedPhase}` : undefined, details.failureKind, details.error]
							.filter((part): part is string => !!part)
							.join(" · "),
						{ maxChars: 160 },
					)
				: "";
			const title = disposition === "stopped"
				? theme.fg("warning", theme.bold(`flow stopped · checkpoint ${compactInlineText(details.stoppedAtGate ?? "", { maxChars: 64 })}`))
				: failed
					? theme.fg("error", theme.bold(`flow failed${failureBits ? ` · ${failureBits}` : ""}`))
					: theme.fg("success", theme.bold("flow complete"));
			if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", full)}`, 0, 0);
			const preview = compactVisibleText(full, { maxLines: 3, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
	});
}

/** `flow` tool — run a *.flow.json DAG. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failureDetails } from "../extension/shared.ts";
import { fenceUntrusted } from "../core/fence.ts";
import type { FlowOutcome } from "../orchestration/flow-run.ts";
import type { FlowSpec } from "../orchestration/flow.ts";
import { compactInlineText, sanitizeTerminalText } from "../ui/presentation.ts";
import { compactVisibleText } from "../ui/presentation.ts";
import { toolUsageField, type ChildUsageLedger } from "../ui/usage.ts";
import { sumUsage } from "../orchestration/reducers.ts";
import { emptyUsage } from "../engine/stream.ts";
import { Text } from "@earendil-works/pi-tui";
import { expandDetailHint } from "../extension/shared.ts";
import type { FailureKind } from "../orchestration/types.ts";

export interface FlowToolDeps {
	get lastCtx(): ExtensionContext | undefined;
	set lastCtx(value: ExtensionContext | undefined);
	loadFlow(cwd: string, name: string): { ok: true; flow: FlowSpec } | { ok: false; error: string } | undefined;
	listFlows(cwd: string): string[];
	runFlowVisible(ctx: ExtensionContext, spec: FlowSpec, task: string, signal?: AbortSignal): Promise<FlowOutcome>;
	childUsage: ChildUsageLedger;
	publishPersonaCost(): void;
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
			"phase's output into its dependents. Journaled, so an interrupted flow resumes. Reach for it",
			"when a task has a fixed multi-stage shape (e.g. gather → critique → decide) you want run",
			"deterministically, end to end, rather than deciding each step yourself.",
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
				const outcome = await d.runFlowVisible(ctx, parsed.flow, params.task, signal);
				const details = {
					ok: outcome.ok,
					failedPhase: outcome.failedPhase,
					failureKind: outcome.failureKind,
					error: outcome.error,
				};
				const usage = Object.values(outcome.results).length > 0
					? sumUsage(Object.values(outcome.results).map((r) => r.usage))
					: emptyUsage();
				d.childUsage.account(usage);
				d.publishPersonaCost();
				return {
					content: [{ type: "text", text: fenceUntrusted(outcome.output || "(flow produced no output)") }],
					details: outcome.ok ? details : failureDetails(details),
					isError: !outcome.ok,
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
			};
			const first = result.content[0];
			const full = sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)");
			const failed = details.ok === false;
			const failureBits = failed
				? compactInlineText(
						[details.failedPhase ? `phase ${details.failedPhase}` : undefined, details.failureKind, details.error]
							.filter((part): part is string => !!part)
							.join(" · "),
						{ maxChars: 160 },
					)
				: "";
			const title = failed
				? theme.fg("error", theme.bold(`flow failed${failureBits ? ` · ${failureBits}` : ""}`))
				: theme.fg("success", theme.bold("flow complete"));
			if (expanded) return new Text(`${title}\n${theme.fg("toolOutput", full)}`, 0, 0);
			const preview = compactVisibleText(full, { maxLines: 3, maxLineChars: 100 });
			const hint = preview.truncated ? `\n${theme.fg("dim", expandDetailHint())}` : "";
			return new Text(`${title}\n${theme.fg("toolOutput", preview.text)}${hint}`, 0, 0);
		},
	});
}

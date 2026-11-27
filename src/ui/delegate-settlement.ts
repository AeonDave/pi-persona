import type { AsyncRun } from "../engine/async.ts";
import { summarizeFailure } from "./failure-summary.ts";
import { compactInlineText } from "./presentation.ts";
import { buildRunLabelDetails } from "./run-labels.ts";

/** A failed headless batch can still have successful siblings. Keep failed causes above their findings. */
export function delegateSettlementPreview(runs: readonly AsyncRun[]): { status: "failed" | "stopped"; text: string } {
	const ordered = [...runs.filter((run) => run.status === "failed"), ...runs.filter((run) => run.status !== "failed")];
	const labels = new Map(buildRunLabelDetails(runs).runLabels.map(({ id, label }) => [id, label]));
	const shown = ordered.slice(0, 3);
	const rows = shown.map((run) => {
		const cause = run.status === "failed" && run.error ? summarizeFailure(run.error, run.agent) : "";
		const label = compactInlineText(labels.get(run.id) ?? run.agent, { maxChars: 36 });
		return compactInlineText([label, run.status, cause].filter(Boolean).join(" · "), { maxChars: 100 });
	});
	if (ordered.length > shown.length) rows.push(`… +${ordered.length - shown.length} more`);
	return { status: runs.some((run) => run.status === "failed") ? "failed" : "stopped", text: rows.join("\n") };
}

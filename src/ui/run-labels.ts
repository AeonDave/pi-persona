import { runDisplayLabel, type AsyncRun } from "../engine/async.ts";
import { compactInlineText } from "./presentation.ts";

/** Persist only identities used by the compact display; runtime reports remain authoritative. */
export function buildRunLabelDetails(runs: readonly Pick<AsyncRun, "id" | "agent" | "label">[]): { runLabels: Array<{ id: string; label: string }> } {
	const selected = runs.slice(0, 256);
	const counts = new Map<string, number>();
	for (const run of selected) { const label = runDisplayLabel(run); counts.set(label, (counts.get(label) ?? 0) + 1); }
	return { runLabels: selected.map((run) => {
		const id = compactInlineText(run.id, { maxChars: 120 });
		const label = runDisplayLabel(run);
		return { id, label: counts.get(label)! > 1 ? `${label} [${id}]` : label };
	}) };
}

export function parseRunLabelDetails(value: unknown): ReadonlyMap<string, string> {
	const labels = new Map<string, string>();
	if (!value || typeof value !== "object" || !("runLabels" in value) || !Array.isArray(value.runLabels)) return labels;
	for (const item of value.runLabels.slice(0, 256)) {
		if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.label !== "string") continue;
		const id = compactInlineText(item.id, { maxChars: 120 });
		const label = compactInlineText(item.label, { maxChars: 120 });
		if (id && label && !labels.has(id)) labels.set(id, label);
	}
	return labels;
}

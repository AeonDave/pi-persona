import { runDisplayLabel, runDurationLabel, type AsyncRun } from "../engine/async.ts";
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

type SettlementStatus = "done" | "failed" | "stopped";
interface SettlementRow { id: string; status: SettlementStatus; duration?: string }
export interface SettlementSnapshot { done: number; failed: number; stopped: number; runs: SettlementRow[] }

/** Capture runtime-owned settlement facts separately from fenced worker output. */
export function buildSettlementDetails(runs: readonly AsyncRun[]): { runLabels: Array<{ id: string; label: string }>; settlement: SettlementSnapshot } {
	const terminal = runs.filter((run): run is AsyncRun & { status: SettlementStatus } => run.status === "done" || run.status === "failed" || run.status === "stopped");
	return {
		...buildRunLabelDetails(terminal),
		settlement: {
			done: terminal.filter((run) => run.status === "done").length,
			failed: terminal.filter((run) => run.status === "failed").length,
			stopped: terminal.filter((run) => run.status === "stopped").length,
			runs: terminal.slice(0, 256).map((run) => {
				const duration = runDurationLabel(run);
				return { id: compactInlineText(run.id, { maxChars: 120 }), status: run.status, ...(duration ? { duration } : {}) };
			}),
		},
	};
}

/** Malformed persisted metadata has no authority over the literal history view. */
export function parseSettlementDetails(value: unknown): SettlementSnapshot | undefined {
	if (!value || typeof value !== "object" || !("settlement" in value)) return undefined;
	const data = value.settlement;
	if (!data || typeof data !== "object" || !("runs" in data) || !Array.isArray(data.runs) || data.runs.length > 256 ||
		!("done" in data) || !("failed" in data) || !("stopped" in data) ||
		![data.done, data.failed, data.stopped].every((count) => Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 1_000_000)) return undefined;
	const runs: SettlementRow[] = [];
	for (const item of data.runs) {
		if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 120 ||
			(item.status !== "done" && item.status !== "failed" && item.status !== "stopped") ||
			(item.duration !== undefined && (typeof item.duration !== "string" || item.duration.length > 32))) return undefined;
		runs.push({ id: compactInlineText(item.id, { maxChars: 120 }), status: item.status,
			...(typeof item.duration === "string" ? { duration: compactInlineText(item.duration, { maxChars: 32 }) } : {}) });
	}
	const done = data.done as number, failed = data.failed as number, stopped = data.stopped as number;
	const total = done + failed + stopped;
	if (runs.length !== Math.min(total, 256) || new Set(runs.map((run) => run.id)).size !== runs.length || runs.filter((run) => run.status === "done").length > done || runs.filter((run) => run.status === "failed").length > failed || runs.filter((run) => run.status === "stopped").length > stopped) return undefined;
	return { done, failed, stopped, runs };
}

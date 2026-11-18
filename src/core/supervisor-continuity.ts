import { sanitizeDisplayLabel } from "./display-label.ts";

/** Request-local continuity after native compaction; no session content or worker output is retained. */
export interface ContinuitySnapshot {
	runs: readonly { id: string; label?: string; status: "running" | "queued" | "done" | "failed" | "stopped"; resultRef?: string }[];
	asks: readonly { id: string }[];
}

export class SupervisorContinuity {
	private marker: { session: string; entry: string; prepared: boolean } | undefined;
	arm(session: string, entry: string): void { this.marker = { session, entry, prepared: false }; }
	applies(session: string, branch: readonly string[]): boolean {
		if (!this.marker) return false;
		if (this.marker.session !== session || !branch.includes(this.marker.entry)) { this.marker = undefined; return false; }
		return true;
	}
	prepared(): void { if (this.marker) this.marker.prepared = true; }
	response(): void { if (this.marker?.prepared) this.marker = undefined; }
}

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const REF = /^result:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 24;

/** Only identifier-shaped metadata crosses this boundary. Never include tasks, messages or output. */
export function renderContinuity(snapshot: ContinuitySnapshot, now: number): string | undefined {
	const rows: string[] = [];
	for (const run of snapshot.runs) {
		if (!ID.test(run.id)) continue;
		const label = run.label ? ` ${sanitizeDisplayLabel(run.label, "agent", 48)}` : "";
		const ref = run.resultRef && REF.test(run.resultRef) ? ` ${run.resultRef}` : "";
		rows.push(`run ${run.id}${label} ${run.status}${ref}`);
	}
	for (const ask of snapshot.asks) if (ID.test(ask.id)) rows.push(`pending ask ${ask.id}`);
	if (!rows.length) return undefined;
	const visible: string[] = [];
	let chars = 0;
	for (const row of rows) {
		if (visible.length >= MAX_ROWS || chars + row.length > 3000) break;
		visible.push(row);
		chars += row.length;
	}
	const omitted = rows.length - visible.length;
	return [`[Supervisor continuity: observed ${new Date(now).toISOString()} at request preparation; statuses may change]`, ...visible, ...(omitted ? [`${omitted} additional entries omitted`] : [])].join("\n");
}

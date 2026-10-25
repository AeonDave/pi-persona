/** Bounded local-work rows. A staged plan is waiting data, never a running agent. */
import type { CompanionActivity } from "../core/companion.ts";
import type { AddNodeInput } from "./agent-tree.ts";

export const MAX_COMPANION_ACTIVITIES = 8;
interface ActivityRecord { event: CompanionActivity; startedAt: number }

function description(event: CompanionActivity): string {
	const scope = `${event.target} memory`;
	if (event.state === "staged") return `${scope} · proposal prepared; explicit apply required`;
	if (event.state === "failed") return `${scope} · ${event.phase} failed; see the memory result`;
	if (event.state === "done") return `${scope} · ${event.phase === "inspect" ? "inspection complete; ready for review" : event.phase === "apply" ? "staged plan applied" : "plan validation complete"}`;
	return `${scope} · ${event.phase === "inspect" ? "inspecting" : event.phase === "stage" ? "validating consolidation" : "applying staged plan"}`;
}

export class ActivityRows {
	private readonly records = new Map<string, ActivityRecord>();
	accept(event: CompanionActivity, now: number): { node: AddNodeInput; removed: string[] } | undefined {
		const id = `activity:pi-persona-mind:${event.activityId}`;
		const existing = this.records.get(id);
		if (existing && (existing.event.phase !== event.phase || existing.event.target !== event.target || existing.event.state !== "running")) return undefined;
		const removed: string[] = [];
		if (!existing && this.records.size >= MAX_COMPANION_ACTIVITIES) {
			const victim = [...this.records].find(([, record]) => record.event.state !== "running");
			if (!victim) return undefined; // never silently evict active local work
			this.records.delete(victim[0]); removed.push(victim[0]);
		}
		const record = { event, startedAt: existing?.startedAt ?? now };
		this.records.set(id, record);
		const detail = description(event);
		return { removed, node: { id, label: "Mind", kind: "activity", status: event.state === "running" ? "running" : event.state === "failed" ? "failed" : "done", detail, output: `${detail}.\nLocal memory operation; no sub-agent or model execution is implied.\nInspect the memory tool or command result for the full receipt.`, startedAt: record.startedAt, lastAdvanceAt: now } };
	}
	clear(): string[] { const ids = [...this.records.keys()]; this.records.clear(); return ids; }
}
